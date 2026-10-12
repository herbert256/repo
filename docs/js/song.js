// FLORA NUSQUAM — the song.
//
// Every plant in the herbarium sings. Its song is grown from its genome the
// same way its engraving is: the key from the flower's colour, the meter from
// its petals, the mode from the flower's form, the tempo from its height and
// the instrument from its marvel or habit (genome.music). From those, and from
// a seeded random stream, this module composes a small, slowly evolving piece
// and plays it on a synthesized instrument through the Web Audio API. Nothing
// is sampled; every sound is made here.
//
// Public API
//   createSong(genome, { onNote }) -> { play(), stop(), get playing() }
//   pageTurn()          a short paper rustle (no-op until audio is unlocked)
//   setMuted(bool)      master mute; scheduling continues silently
//   unlockAudio()       create/resume the shared AudioContext (call in a gesture)
//   composeEvents(genome, bars)   pure composition (for tests / visualisation)
//   renderOffline(genome, seconds, opts)   render into an OfflineAudioContext
//
// onNote({ time, delay, pitch, degree, velocity, voice, muted }) fires when a
// note is handed to the audio clock; `delay` is the number of seconds until it
// is heard (output latency included), so setTimeout(fn, delay * 1000) lines
// visuals up with the sound. `degree` is the scale step 0..n-1, `voice` is
// 'melody' | 'counter' | 'drone', and `muted` is true when setMuted(true) is on.

import { rngFor, makeRng, hash32 } from './genome.js';

// ---------------------------------------------------------------- helpers

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const mod = (a, n) => ((a % n) + n) % n;
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const EPS = 1e-9;

// Weighted pick from [[value, weight], ...]; values may be numbers.
function wpick(r, pairs) {
  let total = 0;
  for (const [, w] of pairs) total += Math.max(0, w);
  let x = r.next() * total;
  for (const [v, w] of pairs) if ((x -= Math.max(0, w)) < 0) return v;
  return pairs[pairs.length - 1][0];
}

// ---------------------------------------------------------------- vocabulary

const MODES = {
  ionian: [0, 2, 4, 5, 7, 9, 11],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  pentatonic: [0, 2, 4, 7, 9],
  'minor-pentatonic': [0, 3, 5, 7, 10],
  wholetone: [0, 2, 4, 6, 8, 10],
  hirajoshi: [0, 2, 3, 7, 8],
};

// Time is counted in ticks of one eighth note. A bar is a row of pulses (the
// felt beats); odd meters are grouped so they lilt: 5/4 = 3+2, 7/8 = 2+2+3.
// `strong` lists the tick offsets where the counter-melody may move.
const METERS = {
  '3/4': { pulses: [2, 2, 2], accents: [1, 0.66, 0.74], strong: [0] },
  '4/4': { pulses: [2, 2, 2, 2], accents: [1, 0.64, 0.84, 0.66], strong: [0, 4] },
  '5/4': { pulses: [2, 2, 2, 2, 2], accents: [1, 0.64, 0.7, 0.86, 0.66], strong: [0, 6] },
  '6/8': { pulses: [3, 3], accents: [1, 0.82], strong: [0, 3] },
  '7/8': { pulses: [2, 2, 3], accents: [1, 0.76, 0.86], strong: [0, 4] },
};

function meterInfo(meter) {
  const [beats, unit] = meter;
  const known = METERS[beats + '/' + unit];
  if (known) return known;
  const ticks = Math.max(2, Math.round((beats * 8) / unit));
  const pulses = [];
  if (unit >= 8) {
    let left = ticks;
    while (left > 4) { pulses.push(3); left -= 3; }
    if (left === 4) pulses.push(2, 2); else if (left > 0) pulses.push(left);
  } else {
    let left = ticks;
    while (left > 0) { pulses.push(Math.min(2, left)); left -= 2; }
  }
  const accents = pulses.map((_, i) => (i === 0 ? 1 : 0.7));
  const strong = [0];
  let t = 0;
  for (let i = 0; i < pulses.length; i++) { if (i === Math.ceil(pulses.length / 2) && i > 0) strong.push(t); t += pulses[i]; }
  return { pulses, accents, strong };
}

const TIMBRES = ['musicbox', 'celesta', 'glass', 'harp', 'bell', 'kalimba'];
// The tonic is moved by octaves into each instrument's sweet spot.
const REGISTER = { musicbox: [62, 79], celesta: [58, 74], glass: [55, 71], harp: [50, 66], bell: [50, 67], kalimba: [57, 72] };
// Sustaining instruments play fewer notes.
const DENSITY_SCALE = { musicbox: 1.05, celesta: 1, glass: 0.72, harp: 1, bell: 0.8, kalimba: 1 };
const PITCH_LO = 36, PITCH_HI = 96, COUNTER_LO = 40;
const PASS_BARS = 16; // four four-bar phrases: statement, answer, variation, return

// Little habits of the plant that colour its melodies.
function personalityOf(g) {
  const marvel = g.marvel, f = g.flower || {}, leaf = g.leaf || {};
  return {
    leap: (['serrate', 'ciliate'].includes(leaf.margin) ? 0.3 : leaf.margin === 'undulate' ? 0.18 : 0.05)
      + (['lobed', 'palmate', 'pinnate'].includes(leaf.shape) ? 0.08 : 0)
      + (marvel === 'constellation' || marvel === 'crystal' ? 0.3 : 0),
    orn: (['fringed', 'filiform'].includes(f.petalTip) ? 0.3 : 0.04) + (marvel === 'feathered' ? 0.35 : 0),
    sigh: (f.nodding ? 0.35 : 0.15) + (marvel === 'weeping' ? 0.35 : 0),
    rest: marvel === 'smoke' ? 0.22 : 0.05,
    echo: marvel === 'echoing' || marvel === 'mirrored',
    invert: marvel === 'inverted' || marvel === 'mirrored',
    steady: marvel === 'clockwork',
    tidal: marvel === 'tidal',
    sparkle: marvel === 'luminous' || marvel === 'constellation',
    fall: !!f.nodding || marvel === 'weeping' || marvel === 'inverted',
    rise: ((g.stem && g.stem.lean) || 0) > 0.25 || marvel === 'migratory',
  };
}

// ---------------------------------------------------------------- composer

class Composer {
  constructor(genome) {
    const m = genome.music || {};
    this.genome = genome;
    this.mode = MODES[m.mode] ? m.mode : 'ionian';
    this.scale = MODES[this.mode];
    this.n = this.scale.length;
    this.meter = Array.isArray(m.meter) && m.meter.length === 2 ? m.meter : [4, 4];
    const mi = meterInfo(this.meter);
    this.pulses = mi.pulses; this.accents = mi.accents; this.strong = mi.strong;
    this.B = this.pulses.reduce((a, b) => a + b, 0);
    this.pulseStarts = [];
    for (let i = 0, t = 0; i < this.pulses.length; t += this.pulses[i++]) this.pulseStarts.push(t);
    this.beatsPerTick = this.meter[1] / 8;
    this.bpm = clamp(Number(m.bpm) || 72, 30, 200);
    this.secPerTick = 30 / this.bpm; // bpm counts quarter notes
    this.timbre = TIMBRES.includes(m.timbre) ? m.timbre : 'musicbox';
    this.tonicPc = mod(Number.isFinite(m.pitchClass) ? m.pitchClass : Number.isFinite(m.midi) ? m.midi : 0, 12);
    const [lo, hi] = REGISTER[this.timbre];
    let t = Number.isFinite(m.midi) ? m.midi : 60 + this.tonicPc;
    while (t < lo) t += 12;
    while (t > hi) t -= 12;
    this.tonic = t;
    this.density = clamp((Number.isFinite(m.density) ? m.density : 0.5) * DENSITY_SCALE[this.timbre], 0.15, 0.95);
    this.P = personalityOf(genome);

    const idx = (s) => this.scale.indexOf(s);
    this.third = idx(4) >= 0 ? idx(4) : idx(3) >= 0 ? idx(3) : 2;
    this.fifth = idx(7) >= 0 ? idx(7) : idx(8) >= 0 ? idx(8) : idx(6) >= 0 ? idx(6) : Math.floor(this.n / 2);
    this.lo = this.n >= 6 ? -3 : -2;                       // a fourth or so below the tonic
    this.hi = this.n >= 7 ? 9 : this.n === 6 ? 8 : 7;      // a tenth or so above
    this.canOctUp = this.tonic + this.semis(this.hi) + 12 <= PITCH_HI - 2;

    this.drone = !!m.drone;
    this.droneRoot = 40 + mod(this.tonicPc - 4, 12);       // E2..D#3
    this.droneFifth = this.droneRoot + (this.scale.includes(7) ? 7 : 12);

    this.root = rngFor(genome, 'song');
    this.motif = this.makeMotif(this.root.fork('motif'));
    this.cache = new Map();
  }

  semis(d) { return 12 * Math.floor(d / this.n) + this.scale[mod(d, this.n)]; }
  pitch(d, oct = 0) {
    let p = this.tonic + this.semis(d) + oct;
    while (p > PITCH_HI) p -= 12;
    while (p < PITCH_LO) p += 12;
    return p;
  }
  clampDeg(d) { return clamp(d, this.lo, this.hi); }
  isPulseStart(tick) { const tb = mod(tick, this.B); return this.pulseStarts.some((s) => Math.abs(s - tb) < EPS); }
  accentAt(tick) {
    const tb = mod(tick, this.B);
    for (let i = 0; i < this.pulseStarts.length; i++) if (Math.abs(this.pulseStarts[i] - tb) < EPS) return this.accents[i];
    return Number.isInteger(Math.round(tb * 1e6) / 1e6) ? 0.55 : 0.48;
  }

  // A rhythm of exactly k onsets over nBars, grown by splitting and merging
  // the bar's pulses, so it always sits naturally in the meter.
  genRhythm(r, nBars, k, { endLong = false } = {}) {
    const B = this.B, notes = [];
    for (let b = 0; b < nBars; b++) for (let i = 0; i < this.pulses.length; i++) notes.push({ t: b * B + this.pulseStarts[i], dur: this.pulses[i] });
    k = clamp(Math.round(k), 1, nBars * B);
    const split = () => {
      let c = [];
      notes.forEach((x, i) => { if (x.dur >= 2) c.push(i); });
      if (endLong && c.length > 1 && r.chance(0.7)) c = c.filter((i) => i !== notes.length - 1);
      if (!c.length) notes.forEach((x, i) => { if (x.dur >= 1) c.push(i); });
      if (!c.length) return false;
      const i = r.pick(c), x = notes[i];
      let a;
      if (x.dur === 2) a = 1;
      else if (x.dur === 3) a = r.chance(0.6) ? 2 : 1;
      else if (x.dur === 1) a = 0.5;
      else if (x.dur >= 4) a = r.chance(0.5) ? Math.floor(x.dur / 2) : x.dur - 1;
      else a = x.dur / 2;
      notes.splice(i, 1, { t: x.t, dur: a }, { t: x.t + a, dur: x.dur - a });
      return true;
    };
    const merge = () => {
      const c = [];
      notes.forEach((x, i) => { if (i > 0 && mod(x.t, B) > EPS) c.push(i); }); // never tie over a bar line
      if (!c.length) return false;
      const i = endLong && r.chance(0.45) ? c[c.length - 1] : r.pick(c);
      notes[i - 1].dur += notes[i].dur;
      notes.splice(i, 1);
      return true;
    };
    for (let guard = 0; notes.length !== k && guard < 400; guard++) {
      if (!(notes.length < k ? split() : merge())) break;
    }
    // Trade a few long notes for short ones (same count) so even rhythms
    // (five petals in 5/4) still get some shape.
    for (let s = r.weighted({ 0: 1, 1: 2, 2: 1.2 }) | 0; s > 0; s--) {
      if (r.chance(0.5)) { if (split()) merge(); } else if (merge()) split();
    }
    // An occasional dotted pair (long-short) for lilt.
    const dotted = this.P.steady ? 0 : 0.12;
    for (let i = 0; i + 1 < notes.length; i++) {
      const a = notes[i], b = notes[i + 1];
      if (a.dur === 1 && b.dur === 1 && this.isPulseStart(a.t) && r.chance(dotted)) {
        a.dur = 1.5; b.t = a.t + 1.5; b.dur = 0.5; i++;
      }
    }
    return notes;
  }

  // The plant's motif: as many notes as it has petals (folded into 4..8),
  // shaped by its bearing — nodding flowers sigh downward, leaning stems climb.
  makeMotif(r) {
    const g = this.genome, P = this.P, B = this.B, n = this.n;
    let K = (g.flower && g.flower.merosity) | 0 || 5;
    while (K > 8) K = Math.round(K / 2);
    while (K < 4) K *= 2;
    const span = K <= B * (0.45 + this.density * 0.5) ? 1 : 2;
    const rhythm = this.genRhythm(r, span, K, { endLong: true });
    K = rhythm.length;
    const shape = wpick(r, [['arch', 3], ['descent', 2 + (P.fall ? 3 : 0)], ['ascent', 1.5 + (P.rise ? 2 : 0)],
      ['valley', 1.2 + (P.invert ? 2 : 0)], ['zigzag', 0.6 + P.leap * 3], ['wave', 1]]);
    const zig = r.chance(0.5) ? 1 : -1;
    const rel = [0];
    let cur = 0, last = 0;
    for (let i = 1; i < K; i++) {
      const frac = i / (K - 1);
      let dir;
      switch (shape) {
        case 'arch': dir = frac <= 0.55 ? 1 : -1; break;
        case 'descent': dir = r.chance(0.8) ? -1 : 1; break;
        case 'ascent': dir = r.chance(0.78) ? 1 : -1; break;
        case 'valley': dir = frac <= 0.5 ? -1 : 1; break;
        case 'zigzag': dir = i % 2 ? zig : -zig; break;
        default: dir = Math.floor((i - 1) / 2) % 2 ? -1 : 1;
      }
      let mag = wpick(r, [[0, 0.5], [1, 6], [2, 2.4 + P.leap * 4], [3, 0.6 + P.leap * 3], [4, 0.25 + P.leap * 2]]);
      if (Math.abs(last) >= 3) { dir = -Math.sign(last); mag = 1; } // fill the gap after a leap
      if (mag === 0 && last === 0) mag = 1;                         // never three alike
      const step = dir * mag;
      cur += step; rel.push(cur); last = step;
    }
    const starts = {
      arch: [0, this.third, 0], descent: [this.fifth, n, this.third + n], ascent: [0, 0, this.third],
      valley: [this.fifth, this.third, n], zigzag: [0, this.third, this.fifth], wave: [0, this.third, this.fifth],
    }[shape];
    let start = r.pick(starts);
    const mx = Math.max(...rel), mn = Math.min(...rel);
    if (start + mx > this.hi) start = this.hi - mx;
    if (start + mn < this.lo) start = this.lo - mn;
    return { K, span, rhythm, rel, start, shape };
  }

  // Shift a fragment (whole) so it lies in the melody's range, then clamp.
  fit(degs) {
    let mx = Math.max(...degs), mn = Math.min(...degs), s = 0;
    if (mx > this.hi) s = this.hi - mx;
    if (mn + s < this.lo) s = this.lo - mn;
    return degs.map((d) => this.clampDeg(d + s));
  }

  // The motif, transformed: plain, invert, retro, vary (new ending), rhythm (new rhythm).
  transform(r, start, how, extra = 0) {
    const M = this.motif;
    let rhythm = M.rhythm, degs;
    switch (how) {
      case 'invert': degs = M.rel.map((x) => start - x); break;
      case 'retro': { const rv = M.rel.slice().reverse(); degs = rv.map((x) => start + x - rv[0]); break; }
      case 'vary': {
        degs = M.rel.map((x) => start + x);
        const from = Math.max(1, M.K - r.int(1, 2));
        for (let i = from; i < M.K; i++) {
          let d;
          do d = degs[i - 1] + r.pick([-2, -1, 1, 2]); while (d === degs[i] && r.chance(0.9));
          degs[i] = d;
        }
        break;
      }
      case 'rhythm': {
        rhythm = this.genRhythm(r, M.span, M.K + extra, { endLong: true });
        const k = rhythm.length;
        degs = [];
        for (let i = 0; i < k; i++) {
          const j = Math.min(M.K - 1, Math.floor((i * M.K) / k));
          let d = start + M.rel[j];
          if (i > 0 && d === degs[i - 1]) d += i % 2 ? 1 : -1; // repeated slot -> neighbour note
          degs.push(d);
        }
        break;
      }
      default: degs = M.rel.map((x) => start + x);
    }
    degs = this.fit(degs);
    return rhythm.map((x, i) => ({ t: x.t, dur: x.dur, deg: degs[i] }));
  }

  // A free bar of continuation, wandering from `from` to arrive one step away
  // from the cadence target. contour: 1 climbs, -1 falls, 0 neutral.
  freeBar(r, from, target, density, contour) {
    const B = this.B, P = this.P;
    const k = clamp(Math.round(B * (0.22 + density * 0.6)) + r.int(-1, 1), 2, B);
    const rhythm = this.genRhythm(r, 1, k);
    let approach = target + (target === 0 || target === this.n ? wpick(r, [[1, 3], [-1, 2]]) : r.pick([1, -1]));
    if (approach > this.hi || approach < this.lo) approach = target - Math.sign(approach - target);
    const out = [];
    let d = from, last = 0;
    for (let i = 0; i < rhythm.length; i++) {
      const remaining = rhythm.length - 1 - i;
      let nd;
      if (remaining === 0) nd = approach;
      else {
        const gap = approach - d;
        if (Math.abs(gap) > remaining * 2) nd = d + Math.sign(gap) * 2;
        else if (Math.abs(last) >= 3) nd = d - Math.sign(last);
        else {
          let dir = r.chance(0.5) ? 1 : -1;
          if (contour && r.chance(0.35 + 0.3 * (1 - i / rhythm.length))) dir = contour;
          if (Math.abs(gap) >= remaining && r.chance(0.75)) dir = Math.sign(gap) || dir;
          const mag = wpick(r, [[0, 0.4], [1, 6], [2, 2 + P.leap * 3], [3, 0.4 + P.leap * 2]]);
          nd = d + dir * mag;
        }
      }
      nd = this.clampDeg(nd);
      out.push({ t: rhythm[i].t, dur: rhythm[i].dur, deg: nd });
      last = nd - d; d = nd;
    }
    return out;
  }

  // The cadence bar: the target held (perhaps after a sighing appoggiatura),
  // then a breath or a little pickup into the next phrase.
  cadenceBar(r, target, kind, nextStart) {
    const B = this.B, out = [];
    let t = 0;
    if (kind !== 'final' && r.chance(this.P.sigh) && target + 1 <= this.hi) {
      out.push({ t: 0, dur: this.pulses[0], deg: target + 1, sigh: true });
      t = this.pulses[0];
    }
    let end = B;
    const tail = [];
    if (kind !== 'final') {
      if (nextStart != null && B >= 6 && r.chance(0.25 + this.density * 0.25)) {
        const cnt = B >= 8 && r.chance(0.5) ? 2 : 1;
        const dir = r.chance(0.5) ? 1 : -1;
        end = B - cnt;
        for (let j = 0; j < cnt; j++) tail.push({ t: end + j, dur: 1, deg: this.clampDeg(nextStart - dir * (cnt - j)) });
      } else {
        end = B - wpick(r, [[0, 2], [1, 1.2], [2, B >= 8 ? 1 : 0]]);
      }
    }
    if (end - t < 1) end = Math.min(B, t + 1);
    out.push({ t, dur: end - t, deg: target, cad: true });
    return out.concat(tail);
  }

  seqStep(r, start, how) {
    const M = this.motif;
    const step = wpick(r, [[1, 2], [-1, 2], [2, 1], [-2, 0.6]]);
    const rel = how === 'invert' ? M.rel.map((x) => -x) : M.rel;
    const mx = Math.max(...rel) + start + step, mn = Math.min(...rel) + start + step;
    if (mx > this.hi || mn < this.lo) return -step;
    return step;
  }

  genPhrase(r, kind, o) {
    const B = this.B, M = this.motif, out = [];
    const place = (notes, off) => { for (const x of notes) out.push({ ...x, t: x.t + off }); };

    let stmt;
    if (kind === 'B') stmt = this.transform(r, o.bStart, o.bHow);
    else if (kind === 'A3' && o.variant === 'diminution') stmt = this.transform(r, M.start, 'rhythm', 1);
    else stmt = this.transform(r, M.start, 'plain');
    place(stmt, 0);

    if (M.span === 1) {
      const how = { A: 'sequence', A2: r.pick(['vary', 'rhythm']), B: 'sequence', A3: r.pick(['plain', 'vary']) }[kind];
      let dev;
      if (how === 'sequence') {
        const base = kind === 'B' ? o.bStart : M.start, bh = kind === 'B' ? o.bHow : 'plain';
        dev = this.transform(r, base + this.seqStep(r, base, bh), bh);
      } else dev = this.transform(r, M.start, how, o.variant === 'diminution' ? 2 : 0);
      place(dev, B);
    }

    const last = out[out.length - 1].deg;
    let target = o.target;
    if (target === 'tonic') target = last > this.fifth + 1 ? this.n : 0;
    const contour = kind === 'B' ? 1 : kind === 'A' ? 0 : -1;
    place(this.freeBar(r, last, target, clamp(o.density + (o.variant === 'diminution' ? 0.25 : 0), 0.1, 1), contour), 2 * B);
    place(this.cadenceBar(r, target, kind === 'A3' ? 'final' : kind === 'A2' ? 'full' : 'half', o.nextStart), 3 * B);

    // Rests: some short notes fall silent (smoke, sparse passes) — never a bar's
    // first note, a cadence, or the plant's first statement of its motif.
    if (o.restP > 0) {
      for (let i = out.length - 1; i > 0; i--) {
        const x = out[i];
        if (kind === 'A' && x.t < M.span * B) break;                 // the motif is first heard whole
        const short = x.dur < 2 || o.variant === 'sparse';
        if (x.t < 3 * B && mod(x.t, B) > EPS && short && !x.cad && r.chance(o.restP)) out.splice(i, 1);
      }
    }
    // Ornaments: a quick grace note just before a longer note, stolen from the
    // end of the note before it, so the main note still falls on its beat.
    const gT = Math.round(clamp(0.085 / this.secPerTick, 0.12, 0.3) * 1000) / 1000;
    for (let i = out.length - 1; i > 0; i--) {
      const x = out[i], prev = out[i - 1];
      const p = x.cad ? Math.max(o.ornP, this.P.orn > 0.25 ? 0.6 : 0) : o.ornP;
      if (x.dur >= 1.5 && !prev.grace && Math.abs(prev.t + prev.dur - x.t) < EPS && prev.dur >= gT + 0.4 && r.chance(p)) {
        let gd = this.clampDeg(x.deg + (r.chance(0.7) ? 1 : -1));
        if (gd === prev.deg) gd = this.clampDeg(2 * x.deg - gd);
        if (gd === x.deg || gd === prev.deg) continue;
        prev.dur -= gT;
        out.splice(i, 0, { t: x.t - gT, dur: gT, deg: gd, grace: true });
      }
    }
    return out;
  }

  // The counter-melody: a slower voice below, moving by step in thirds and
  // sixths against the melody, and in some passes echoing the melody's last
  // notes an octave lower while the melody holds its cadence.
  genCounter(r, mel, from, echo) {
    const B = this.B, n = this.n, out = [];
    const sounding = (t) => { let best = null; for (const x of mel) { if (x.t <= t + EPS) best = x; else break; } return best; };
    let prev = this.fifth - n;
    for (let b = 0; b < PASS_BARS; b++) {
      const phrase = b >> 2, cad = (b & 3) === 3, full = phrase >= from, t0 = b * B;
      if (cad && echo) {
        const held = mel.find((x) => x.cad && x.t >= t0 && x.t < t0 + B);
        const src = mel.filter((x) => x.t >= t0 - B && x.t < t0 && !x.grace).slice(-3);
        if (held && src.length >= 2) {
          const eo = held.t - t0 + Math.max(1, Math.min(this.pulses[0], held.dur / 2));
          const room = held.t - t0 + held.dur - eo;
          const total = src.reduce((a, x) => a + Math.min(x.dur, 2), 0);
          const k = Math.min(1, room / total);
          if (room >= 1.5 && src.every((x) => this.tonic + this.semis(x.deg - n) >= COUNTER_LO)) {
            let t = eo;
            src.forEach((x, i) => {
              const dur = i === src.length - 1 ? B - t : Math.min(x.dur, 2) * k;
              out.push({ t: t0 + t, dur, deg: x.deg - n, echo: true });
              t += dur;
            });
            prev = src[src.length - 1].deg - n;
            continue;
          }
        }
      }
      if (!full) continue;
      let onsets = cad ? [0] : this.strong.slice();
      if (!cad && onsets.length > 1 && this.density < 0.35 && r.chance(0.5)) onsets = [0];
      if (!cad && this.density > 0.6 && r.chance(0.3)) {
        const last = this.pulseStarts[this.pulseStarts.length - 1];
        if (!onsets.includes(last)) onsets.push(last);
      }
      for (let j = 0; j < onsets.length; j++) {
        const o = onsets[j], end = j + 1 < onsets.length ? onsets[j + 1] : B;
        const d = this.counterDeg(r, sounding(t0 + o), prev, cad);
        if (d == null) continue;
        out.push({ t: t0 + o, dur: end - o, deg: d });
        prev = d;
      }
    }
    return out;
  }

  counterDeg(r, m, prev, cadence) {
    const n = this.n;
    const mp = m ? this.semis(m.deg) + (m.oct || 0) : this.semis(prev) + 9;
    let best = null, bestCost = Infinity;
    for (let c = this.lo - 2 * n; c <= this.hi; c++) {
      const cs = this.semis(c), iv = mp - cs;
      if (iv < 3 || iv > 24 || this.tonic + cs < COUNTER_LO) continue;
      const ic = iv % 12;
      let cost = [3, 4, 8, 9].includes(ic) ? 0 : ic === 7 ? 0.7 : ic === 0 ? 1.3 : ic === 5 ? 2.4 : 6;
      cost += Math.abs(c - prev) * 0.55;
      if (iv > 16) cost += (iv - 16) * 0.25;
      if (cadence && mod(c, n) === 0) cost -= 1.2;
      else if (cadence && mod(c, n) === this.fifth) cost -= 0.4;
      cost += r.next() * 0.6;
      if (cost < bestCost) { bestCost = cost; best = c; }
    }
    return bestCost < 5 ? best : null;
  }

  genPass(p) {
    const r = this.root.fork('pass:' + p);
    const P = this.P, B = this.B, M = this.motif, n = this.n;
    let variant;
    if (p <= 1) variant = 'plain';
    else if (p === 2) variant = wpick(r, [['octave', this.canOctUp ? 2 + (P.sparkle ? 2 : 0) : 0], ['diminution', 2], ['ornamented', 1 + P.orn * 3]]);
    else if (p === 3) variant = 'sparse';
    else variant = wpick(r, [['plain', 2], ['octave', this.canOctUp ? 1.5 : 0], ['diminution', 1.5], ['ornamented', 1 + P.orn * 2], ['sparse', 1.5]]);
    const counterFrom = p === 0 ? 4 : p === 1 ? 1 : p >= 4 && r.chance(0.2) ? 2 : 0;
    const echo = P.echo || (p >= 2 && r.chance(0.45));
    const density = clamp(this.density + (variant === 'sparse' ? -0.2 : 0), 0.1, 1);
    const bHow = P.invert ? wpick(r, [['invert', 3], ['retro', 1]]) : wpick(r, [['invert', 1.5], ['plain', 2], ['retro', 0.6]]);
    const bStart = M.start + r.pick([this.third, this.fifth]) * (bHow === 'invert' ? 1 : r.chance(0.7) ? 1 : -1);
    const half = () => wpick(r, [[this.fifth, 3], [1, 1.2], [this.third, 0.8]]);
    const plan = [
      { kind: 'A', target: half(), nextStart: M.start },
      { kind: 'A2', target: 'tonic', nextStart: bStart },
      { kind: 'B', target: wpick(r, [[this.fifth, 3], [1, 1]]), nextStart: M.start },
      { kind: 'A3', target: 'tonic', nextStart: null },
    ];
    const restP = P.rest + (variant === 'sparse' ? 0.3 : 0);
    const ornP = variant === 'ornamented' ? 0.35 + P.orn : P.orn * 0.4;
    const passDyn = { plain: 1, octave: 0.9, diminution: 0.96, ornamented: 1, sparse: 0.84 }[variant] * (p === 0 ? 0.95 : 1);

    const mel = [];
    plan.forEach((ph, i) => {
      const notes = this.genPhrase(r, ph.kind, { ...ph, variant, density, restP, ornP, bStart, bHow });
      const oct = variant === 'octave' && (i === 1 || i === 2) ? 12 : 0;
      for (const x of notes) { x.t += i * 4 * B; x.oct = oct; mel.push(x); }
    });
    mel.sort((a, b) => a.t - b.t);

    const arc = [0.92, 1, 1.04, 0.9];
    const vel = (x, base) => {
      const acc = 0.62 + 0.38 * this.accentAt(x.t);
      return clamp(base * acc * arc[Math.floor(x.t / B) % 4] * passDyn * (x.grace ? 0.6 : 1) * (x.cad ? 0.95 : 1) * (1 + r.gauss(0, 0.05)), 0.08, 1);
    };
    const events = [];
    for (const x of mel) events.push({ t: x.t, dur: x.dur, deg: x.deg, pitch: this.pitch(x.deg, x.oct), vel: vel(x, 0.78), voice: 'melody' });

    if (counterFrom < 4 || echo) {
      const ctr = this.genCounter(r, mel, counterFrom, echo);
      const cBase = variant === 'sparse' ? 0.6 : 0.5;
      for (const x of ctr) events.push({ t: x.t, dur: x.dur, deg: x.deg, pitch: this.pitch(x.deg), vel: vel(x, x.echo ? 0.48 : cBase), voice: 'counter' });
    }
    if (this.drone) {
      for (let ph = 0; ph < 4; ph++) {
        events.push({ t: ph * 4 * B, dur: B, deg: 0, pitch: this.droneRoot, vel: 0.4, voice: 'drone' });
        events.push({ t: ph * 4 * B, dur: B, deg: this.scale.includes(7) ? this.fifth : 0, pitch: this.droneFifth, vel: 0.32, voice: 'drone' });
      }
    }

    const bars = [];
    for (let b = 0; b < PASS_BARS; b++) {
      let s = (b & 3) === 3 ? 1.03 : 1;
      if (P.tidal) s *= [0.97, 1, 1.03, 1.06][b & 3];
      bars.push({ stretch: s, events: [] });
    }
    bars[PASS_BARS - 2].stretch *= 1.06;                                   // ritardando
    bars[PASS_BARS - 1].stretch *= variant === 'sparse' ? 1.65 : 1.45;     // fermata
    for (const e of events) {
      const b = clamp(Math.floor((e.t + EPS) / B), 0, PASS_BARS - 1);
      const t = e.t - b * B;
      e.t = t;
      e.dur = Math.min(Math.max(0.05, e.dur), B - t);
      bars[b].events.push(e);
    }
    for (const bar of bars) bar.events.sort((a, b) => a.t - b.t);
    return { variant, bars };
  }

  bar(i) {
    const p = Math.floor(i / PASS_BARS);
    let pass = this.cache.get(p);
    if (!pass) {
      pass = this.genPass(p);
      this.cache.set(p, pass);
      if (this.cache.size > 3) this.cache.delete(this.cache.keys().next().value);
    }
    return pass.bars[i % PASS_BARS];
  }
}

// Pure composition: the first `bars` bars of a plant's song as note events.
// beat / beatInBar / durationBeats are in the meter's own unit (quarters in
// x/4, eighths in x/8); `stretch` is the bar's tempo stretch (fermata etc.).
export function composeEvents(genome, bars = 16) {
  const c = new Composer(genome), out = [];
  const bpt = c.beatsPerTick, barBeats = c.B * bpt;
  for (let i = 0; i < bars; i++) {
    const bar = c.bar(i);
    for (const e of bar.events) {
      out.push({
        bar: i, beat: i * barBeats + e.t * bpt, beatInBar: e.t * bpt, durationBeats: e.dur * bpt,
        pitch: e.pitch, degree: mod(e.deg, c.n), velocity: e.vel, voice: e.voice, stretch: bar.stretch,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- synthesis

// Per-timbre loudness, balanced by ear-in-numbers (see dev-song.html).
const LEVEL = { musicbox: 0.34, celesta: 0.32, glass: 0.28, harp: 0.52, bell: 0.2, kalimba: 0.34 };
const MASTER = 0.6, DRY = 0.8, WET = 0.55, PAD_LEVEL = 0.05;

function makeIR(ctx, seconds = 3.6, rt60 = 3.1) {
  const sr = ctx.sampleRate, len = Math.floor(sr * seconds), ir = ctx.createBuffer(2, len, sr);
  const r = makeRng(0xf10a);
  const pre = Math.floor(0.014 * sr), fadeIn = 0.04 * sr, fadeOut = Math.floor(0.3 * sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    let lp = 0;
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / sr;
      // darker as it decays: the cutoff slides from ~8 kHz down to ~1.2 kHz
      const fc = 1200 + 7000 * Math.exp(-t / 0.7);
      const a = Math.exp((-2 * Math.PI * fc) / sr);
      lp = (1 - a) * (r.next() * 2 - 1) + a * lp;
      let env = Math.exp((-6.9 * t) / rt60) * Math.min(1, (i - pre) / fadeIn);
      if (i > len - fadeOut) env *= (len - i) / fadeOut;
      d[i] = lp * env;
    }
  }
  return ir;
}

class Engine {
  constructor(ctx, { offline = false, dry = DRY, wet = WET } = {}) {
    this.ctx = ctx;
    this.offline = offline;
    const sr = ctx.sampleRate;
    this.noise = ctx.createBuffer(1, Math.floor(sr * 2), sr);
    const nd = this.noise.getChannelData(0), nr = makeRng(0x5eed);
    for (let i = 0; i < nd.length; i++) nd[i] = nr.next() * 2 - 1;
    this._nOff = 0;
    this.ks = new Map();

    this.master = ctx.createGain(); this.master.gain.value = MASTER;
    this.mute = ctx.createGain(); this.mute.gain.value = !offline && muted ? 0 : 1;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -20; comp.knee.value = 12; comp.ratio.value = 2.5; comp.attack.value = 0.01; comp.release.value = 0.3;
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -5; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.002; lim.release.value = 0.15;
    const trim = ctx.createGain(); trim.gain.value = 0.85;
    this.master.connect(this.mute); this.mute.connect(comp); comp.connect(lim); lim.connect(trim); trim.connect(ctx.destination);

    this.dry = ctx.createGain(); this.dry.gain.value = dry; this.dry.connect(this.master);
    this.send = ctx.createGain(); this.send.gain.value = wet;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 220;
    const conv = ctx.createConvolver(); conv.buffer = makeIR(ctx);
    this.send.connect(hp); hp.connect(conv); conv.connect(this.master);
  }
  noiseOffset() { this._nOff = (this._nOff + 0.2371) % 1.6; return this._nOff; }
}

// --- note plumbing: every node a note makes is disconnected when it ends.

function makeNote(eng, dest, pan) {
  const ctx = eng.ctx, out = ctx.createGain(), nodes = [out];
  if (ctx.createStereoPanner) {
    const p = ctx.createStereoPanner();
    p.pan.value = clamp(pan, -0.9, 0.9);
    out.connect(p); p.connect(dest); nodes.push(p);
  } else out.connect(dest);
  return { ctx, eng, out, nodes, last: null, lastEnd: -Infinity };
}
function track(note, src, end) { note.nodes.push(src); if (end > note.lastEnd) { note.lastEnd = end; note.last = src; } }
function seal(note) {
  if (!note.last) { for (const nd of note.nodes) nd.disconnect(); return; }
  note.last.onended = () => { for (const nd of note.nodes) { try { nd.disconnect(); } catch (e) { /* already gone */ } } };
}

// A decaying sine partial. `bend` starts the pitch slightly sharp (a thumb, a pluck).
function partial(note, t, freq, amp, att, tau, maxEnd, bend = 0) {
  if (freq >= 18000 || amp <= 1e-4) return null;
  const { ctx } = note;
  const o = ctx.createOscillator();
  if (bend) { o.frequency.setValueAtTime(freq * (1 + bend), t); o.frequency.setTargetAtTime(freq, t, 0.012); }
  else o.frequency.value = freq;
  const g = ctx.createGain();
  const natural = t + att + tau * 7;
  const end = Math.max(t + att + 0.2, Math.min(maxEnd, natural));
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(amp, t + att);
  g.gain.setTargetAtTime(0, t + att, tau);
  if (end < natural - 1e-3) g.gain.setTargetAtTime(0, end - 0.15, 0.03);
  o.connect(g); g.connect(note.out);
  o.start(t); o.stop(end);
  note.nodes.push(g); track(note, o, end);
  return o;
}

// A filtered noise burst: hammer felt, the pin of a music-box cylinder, wood.
function burst(note, t, type, freq, Q, dur, amp) {
  if (amp <= 1e-4) return;
  const { ctx, eng } = note;
  const s = ctx.createBufferSource(); s.buffer = eng.noise;
  const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = Q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(amp, t + 0.0008);
  g.gain.setTargetAtTime(0, t + 0.0008, dur / 4);
  s.connect(f); f.connect(g); g.connect(note.out);
  const end = t + dur * 1.8 + 0.01;
  s.start(t, eng.noiseOffset()); s.stop(end);
  note.nodes.push(f, g); track(note, s, end);
}

// Karplus–Strong plucked string, rendered once per pitch and cached. The loop
// length is an integer, so the buffer is retuned exactly with playbackRate.
function ksBuffer(eng, midi) {
  const hit = eng.ks.get(midi);
  if (hit) return hit;
  const ctx = eng.ctx, sr = ctx.sampleRate, f = mtof(midi);
  const N = Math.max(4, Math.floor(sr / f - 0.5));
  const fp = sr / (N + 0.5);
  const T60 = clamp(4.2 * Math.pow(220 / f, 0.45), 1.2, 6);
  const len = Math.floor(sr * Math.min(T60 * 0.9, 4.5));
  const rho = Math.pow(0.001, 1 / (fp * T60));
  const buf = ctx.createBuffer(1, len, sr), y = buf.getChannelData(0);
  const r = makeRng(hash32('harp:' + midi));
  const exc = new Float32Array(N);
  // A finger pad pulls the string into a soft triangle (harmonics fall as
  // 1/n^2, so the tone is round); a little filtered noise keeps it alive.
  const beta = 0.28;
  let lp = 0, mean = 0;
  for (let i = 0; i < N; i++) {
    const x = i / N, tri = x < beta ? x / beta : (1 - x) / (1 - beta);
    lp += 0.5 * (r.next() * 2 - 1 - lp);
    exc[i] = tri + 0.3 * lp; mean += exc[i];
  }
  mean /= N;
  for (let i = 0; i < N; i++) y[i] = exc[i] - mean;
  for (let i = N; i < len; i++) y[i] = rho * 0.5 * (y[i - N] + (i - N - 1 >= 0 ? y[i - N - 1] : 0));
  let peak = 0;
  for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(y[i]));
  const k = peak > 0 ? 0.9 / peak : 0, fo = Math.floor(0.08 * sr);
  for (let i = 0; i < len; i++) y[i] *= k * (i > len - fo ? (len - i) / fo : 1);
  const out = { buf, rate: f / fp };
  eng.ks.set(midi, out);
  return out;
}

const INSTR = {
  // A tuned steel comb: bright, slightly inharmonic, quick to fade, and the
  // tiny tick of the cylinder's pin just before each note.
  musicbox(note, t, f, v) {
    const b = 0.35 + 0.65 * v, k = clamp(Math.pow(523 / f, 0.4), 0.55, 1.6), tau = 0.62 * k;
    partial(note, t, f, 1, 0.0015, tau, t + 6);
    partial(note, t, f * 2.003, 0.11 * b, 0.0015, tau * 0.35, t + 4);
    partial(note, t, f * 6.27, 0.26 * b * b, 0.001, 0.045, t + 1);
    partial(note, t, f * 17.55, 0.08 * b * b, 0.001, 0.016, t + 1);
    burst(note, Math.max(note.ctx.currentTime, t - 0.004), 'highpass', 4200, 0.7, 0.007, 0.07 * v);
  },
  // A felt hammer on a steel bar over a wooden resonator.
  celesta(note, t, f, v) {
    const b = 0.3 + 0.7 * v, k = clamp(Math.pow(523 / f, 0.35), 0.6, 1.5), tau = 0.95 * k;
    partial(note, t, f, 0.8, 0.003, tau, t + 7);
    partial(note, t, f * 1.0018, 0.25, 0.004, tau * 1.3, t + 7); // the resonator beats slowly against the bar
    partial(note, t, f * 2, 0.26 * b, 0.002, tau * 0.4, t + 4);
    partial(note, t, f * 3, 0.05 * b, 0.002, tau * 0.2, t + 2);
    partial(note, t, f * 4.07, 0.035 * b, 0.0015, 0.06, t + 1);
    burst(note, t, 'lowpass', 1800, 0.7, 0.012, 0.05 * v);
  },
  // Glass harmonica: a wet finger on a turning glass bowl. Slow attack, two
  // nearly unison sines that shimmer against each other, a gentle tremolo.
  glass(note, t, f, v, durS) {
    const { ctx } = note;
    const b = 0.3 + 0.7 * v;
    const att = clamp(durS * 0.35, 0.06, 0.28), hold = Math.max(durS, 0.45), rel = 0.45;
    const end = t + hold + rel * 7;
    const body = ctx.createGain(), trem = ctx.createGain(), lfo = ctx.createOscillator(), depth = ctx.createGain();
    body.gain.setValueAtTime(0, t);
    body.gain.linearRampToValueAtTime(1, t + att);
    body.gain.setTargetAtTime(0.55, t + att, 1.8);
    body.gain.setTargetAtTime(0, t + hold, rel);
    lfo.frequency.value = 3.6 + (f % 1.3); depth.gain.value = 0.07; trem.gain.value = 1;
    lfo.connect(depth); depth.connect(trem.gain);
    body.connect(trem); trem.connect(note.out);
    note.nodes.push(body, trem, depth);
    lfo.start(t); lfo.stop(end); track(note, lfo, end);
    for (const [ratio, amp] of [[0.9985, 0.5], [1.0015, 0.5], [2.001, 0.1 * b], [3.002, 0.03 * b]]) {
      if (f * ratio >= 18000) continue;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = f * ratio; g.gain.value = amp;
      o.connect(g); g.connect(body);
      o.start(t); o.stop(end);
      note.nodes.push(g); track(note, o, end);
    }
  },
  // A plucked gut string (Karplus–Strong), brighter when plucked harder.
  harp(note, t, f, v, durS, pitch) {
    const { ctx, eng } = note;
    const ks = ksBuffer(eng, pitch);
    const s = ctx.createBufferSource();
    s.buffer = ks.buf;
    s.playbackRate.value = ks.rate * (f / mtof(pitch));
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.5;
    lp.frequency.value = clamp(f * (3 + 9 * v), 900, 9000);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(1, t + 0.002);
    s.connect(lp); lp.connect(g); g.connect(note.out);
    const end = t + ks.buf.duration / s.playbackRate.value;
    s.start(t); s.stop(end);
    note.nodes.push(lp, g); track(note, s, end);
  },
  // A small bell: inharmonic partials (1, 2.76, 5.40, 8.93) with long decays,
  // the prime split in two so it slowly beats.
  bell(note, t, f, v) {
    const b = 0.35 + 0.65 * v, k = clamp(Math.pow(392 / f, 0.35), 0.6, 1.5);
    partial(note, t, f, 0.7, 0.0015, 1.7 * k, t + 8);
    partial(note, t, f * 1.0021, 0.3, 0.0015, 1.9 * k, t + 8);
    partial(note, t, f * 2.76, 0.42 * b, 0.001, 0.85 * k, t + 6);
    partial(note, t, f * 5.4, 0.24 * b, 0.001, 0.4 * k, t + 3);
    partial(note, t, f * 8.93, 0.12 * b * b, 0.001, 0.2 * k, t + 2);
    burst(note, t, 'bandpass', 3200, 1.2, 0.006, 0.05 * v);
  },
  // Thumb piano: a softly plucked tine on a wooden box — the pitch settles
  // from a hair sharp, a quick metallic overtone, a woody knock.
  kalimba(note, t, f, v) {
    const b = 0.3 + 0.7 * v, k = clamp(Math.pow(440 / f, 0.4), 0.6, 1.6);
    partial(note, t, f, 1, 0.004, 0.5 * k, t + 5, 0.008);
    partial(note, t, f * 2.0, 0.06 * b, 0.003, 0.15 * k, t + 2);
    partial(note, t, f * 5.93, 0.24 * b * b, 0.002, 0.035, t + 1);
    burst(note, t, 'bandpass', 420, 2, 0.03, 0.16 * v);
    burst(note, t, 'highpass', 2500, 0.7, 0.004, 0.03 * v);
  },
};

function makeTone(ctx, timbre) {
  const f = ctx.createBiquadFilter();
  switch (timbre) {
    case 'musicbox': f.type = 'highshelf'; f.frequency.value = 5200; f.gain.value = -4; break;
    case 'celesta': f.type = 'lowpass'; f.frequency.value = 7500; f.Q.value = 0.5; break;
    case 'glass': f.type = 'lowpass'; f.frequency.value = 5500; f.Q.value = 0.5; break;
    case 'harp': f.type = 'peaking'; f.frequency.value = 220; f.Q.value = 0.8; f.gain.value = 2.5; break;
    case 'bell': f.type = 'highshelf'; f.frequency.value = 4000; f.gain.value = -3; break;
    default: f.type = 'peaking'; f.frequency.value = 420; f.Q.value = 1.1; f.gain.value = 4; break; // kalimba
  }
  return f;
}

function playVoice(eng, dest, timbre, t, pitch, durS, vel, pan, det) {
  const note = makeNote(eng, dest, pan);
  const f0 = mtof(pitch), f = f0 * Math.pow(2, det / 1200);
  note.out.gain.value = LEVEL[timbre] * Math.pow(vel, 1.4) * clamp(Math.pow(f0 / 440, -0.18), 0.75, 1.3);
  INSTR[timbre](note, t, f, vel, durS, pitch);
  seal(note);
}

// The drone: a very soft pad on the tonic and fifth, two detuned saws and a
// triangle under a slowly breathing low-pass filter.
function startPad(eng, dest, rootPitch, fifthPitch, t) {
  const ctx = eng.ctx, nodes = [], srcs = [];
  const out = ctx.createGain();
  out.gain.setValueAtTime(0, t);
  out.gain.setTargetAtTime(1, t, 1.6);
  const amp = ctx.createGain(); amp.gain.value = PAD_LEVEL;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.9;
  const fc = clamp(mtof(rootPitch) * 4, 220, 900);
  lp.frequency.value = fc;
  const lfo = ctx.createOscillator(), lfoG = ctx.createGain();
  lfo.frequency.value = 0.07; lfoG.gain.value = fc * 0.35;
  lfo.connect(lfoG); lfoG.connect(lp.frequency);
  const alfo = ctx.createOscillator(), alfoG = ctx.createGain();
  alfo.frequency.value = 0.13; alfoG.gain.value = PAD_LEVEL * 0.3;
  alfo.connect(alfoG); alfoG.connect(amp.gain);
  lp.connect(amp); amp.connect(out); out.connect(dest);
  nodes.push(out, amp, lp, lfoG, alfoG);
  srcs.push(lfo, alfo);
  for (const [type, pitch, cents, a] of [['sawtooth', rootPitch, -5, 0.5], ['sawtooth', rootPitch, 5, 0.5], ['triangle', fifthPitch, 2, 0.55], ['triangle', rootPitch + 12, -3, 0.18]]) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.value = mtof(pitch); o.detune.value = cents; g.gain.value = a;
    o.connect(g); g.connect(lp);
    nodes.push(g); srcs.push(o);
  }
  for (const s of srcs) s.start(t);
  return {
    stop(at) {
      for (const s of srcs) { try { s.stop(at); } catch (e) { /* stopped */ } }
      srcs[0].onended = () => { for (const nd of nodes.concat(srcs)) { try { nd.disconnect(); } catch (e) { /* gone */ } } };
    },
  };
}

// ---------------------------------------------------------------- playback

let rt = null;       // { ctx, engine } — the shared realtime audio graph
let current = null;  // the song that is playing
let muted = false;

class SongPlayer {
  constructor(genome, onNote) {
    this.genome = genome;
    this.onNote = typeof onNote === 'function' ? onNote : null;
    this.composer = null;
    this._playing = false;
    this._token = 0;
    this._timer = null;
    this._bus = null;
  }

  _setup(eng, t0) {
    if (!this.composer) this.composer = new Composer(this.genome);
    const c = this.composer, ctx = eng.ctx;
    this._eng = eng;
    this._bus = ctx.createGain();
    this._tone = makeTone(ctx, c.timbre);
    this._bus.connect(this._tone); this._tone.connect(eng.dry); this._tone.connect(eng.send);
    this._bar = 0; this._barTime = t0; this._queue = []; this._qi = 0;
    this._hum = rngFor(this.genome, 'humanize'); // the same performance every time
    this._pad = c.drone ? startPad(eng, this._bus, c.droneRoot, c.droneFifth, t0) : null;
  }

  _genBar() {
    const c = this.composer, bar = c.bar(this._bar), spt = c.secPerTick * bar.stretch, h = this._hum;
    const loose = c.P.steady ? 0.3 : 1;
    for (const e of bar.events) {
      const drone = e.voice === 'drone';
      const jit = drone ? 0 : clamp(h.gauss(0, 0.0045), -0.01, 0.01) * loose;
      const side = e.voice === 'counter' ? -0.22 : 0.06;
      this._queue.push({
        ...e,
        time: this._barTime + e.t * spt + jit,
        durS: e.dur * spt,
        vel: drone ? e.vel : clamp(e.vel + h.float(-0.04, 0.04), 0.05, 1),
        det: h.float(-3, 3),
        pan: clamp((e.pitch - c.tonic - 5) / 32 + side + h.float(-0.08, 0.08), -0.5, 0.5),
      });
    }
    this._barTime += c.B * spt;
    this._bar++;
  }

  _run(horizon, now) {
    if (this._barTime < now - 0.25) this._barTime = now + 0.05; // the tab slept; pick the thread up again
    while (this._barTime < horizon) this._genBar();
    const q = this._queue, ctx = this._eng.ctx;
    const latency = (ctx.outputLatency || ctx.baseLatency || 0);
    while (this._qi < q.length && q[this._qi].time < horizon) {
      const e = q[this._qi++];
      if (e.time < now - 0.04) continue; // too late to be heard in time
      const time = Math.max(e.time, now + 0.008);
      const silent = !this._eng.offline && muted;
      if (!silent && e.voice !== 'drone') playVoice(this._eng, this._bus, this.composer.timbre, time, e.pitch, e.durS, e.vel, e.pan, e.det);
      if (this.onNote) {
        try {
          this.onNote({ time, delay: Math.max(0, time - now + latency), pitch: e.pitch, degree: mod(e.deg, this.composer.n), velocity: e.vel, voice: e.voice, muted: silent });
        } catch (err) { console.error(err); }
      }
    }
    if (this._qi > 256) { q.splice(0, this._qi); this._qi = 0; }
  }

  _tick() {
    if (!this._playing || !this._eng) return;
    const now = this._eng.ctx.currentTime;
    const wall = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const gap = this._lastTick ? (wall - this._lastTick) / 1000 : 0.025;
    this._lastTick = wall;
    // ~0.15 s ahead normally; further when the page is busy or hidden (throttled timers).
    let ahead = clamp(gap * 1.6, 0.15, 1.6);
    if (typeof document !== 'undefined' && document.hidden) ahead = 1.6;
    this._run(now + ahead, now);
  }

  play() {
    if (this._playing) return Promise.resolve();
    this._playing = true;
    const token = ++this._token;
    const other = current && current !== this ? current : null;
    if (other) other.stop(); // crossfade: it fades over 1.2 s while this one begins
    current = this;
    let unlocking;
    try { unlocking = unlockAudio(); } catch (err) { unlocking = Promise.reject(err); }
    return unlocking.then(() => {
      if (token !== this._token || !rt) return;
      this._setup(rt.engine, rt.ctx.currentTime + (other ? 0.45 : 0.08));
      this._lastTick = 0;
      this._timer = setInterval(() => this._tick(), 25);
      this._tick();
    }, (err) => {
      if (token === this._token) { this._playing = false; if (current === this) current = null; }
      throw err;
    });
  }

  stop() {
    this._token++;
    const was = this._playing;
    this._playing = false;
    if (current === this) current = null;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (!was || !this._bus) return;
    const ctx = this._eng.ctx, now = ctx.currentTime, bus = this._bus, tone = this._tone, pad = this._pad;
    const curve = new Float32Array(64);
    for (let i = 0; i < 64; i++) curve[i] = Math.cos((i / 63) * Math.PI / 2);
    curve[63] = 0;
    bus.gain.cancelScheduledValues(now);
    try { bus.gain.setValueCurveAtTime(curve, now, 1.2); } catch (e) { bus.gain.setTargetAtTime(0, now, 0.3); }
    if (pad) pad.stop(now + 1.3);
    this._bus = null; this._pad = null; this._queue = []; this._qi = 0;
    setTimeout(() => { try { bus.disconnect(); tone.disconnect(); } catch (e) { /* gone */ } }, 1600);
  }
}

export function createSong(genome, { onNote } = {}) {
  const s = new SongPlayer(genome, onNote);
  return {
    play: () => s.play(),
    stop: () => s.stop(),
    get playing() { return s._playing; },
  };
}

// Create (or wake) the shared AudioContext. Call from a user gesture.
export function unlockAudio() {
  if (typeof window === 'undefined') return Promise.resolve(null);
  if (!rt || rt.ctx.state === 'closed') {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return Promise.reject(new Error('Web Audio is not available'));
    let ctx;
    try { ctx = new AC({ latencyHint: 'interactive' }); } catch (e) { ctx = new AC(); }
    rt = { ctx, engine: new Engine(ctx) };
    try { // an inaudible blip, for older iOS
      const b = ctx.createBuffer(1, 1, ctx.sampleRate), s = ctx.createBufferSource();
      s.buffer = b; s.connect(ctx.destination); s.start(0);
    } catch (e) { /* fine */ }
  }
  const ctx = rt.ctx;
  if (ctx.state === 'running') return Promise.resolve(ctx);
  return ctx.resume().then(() => ctx);
}

export function setMuted(on) {
  muted = !!on;
  if (!rt) return;
  const g = rt.engine.mute.gain, now = rt.ctx.currentTime;
  g.cancelScheduledValues(now);
  g.setTargetAtTime(muted ? 0 : 1, now, 0.08);
}

// A page turning: a swish of filtered noise, a few crinkles, the page landing.
export function pageTurn() {
  if (!rt || muted || rt.ctx.state !== 'running') return;
  const { ctx, engine: eng } = rt;
  const t = ctx.currentTime + 0.01, rand = Math.random;
  const out = ctx.createGain(), nodes = [out];
  let pan = null;
  if (ctx.createStereoPanner) { pan = ctx.createStereoPanner(); pan.pan.value = (rand() - 0.5) * 0.5; out.connect(pan); nodes.push(pan); }
  const tail = pan || out;
  tail.connect(eng.dry);
  const sendG = ctx.createGain(); sendG.gain.value = 0.25; tail.connect(sendG); sendG.connect(eng.send); nodes.push(sendG);
  out.gain.value = 0.9 + rand() * 0.2;
  const noise = (start, dur, type, freq, Q, amp, rate = 1) => {
    const s = ctx.createBufferSource(); s.buffer = eng.noise; s.playbackRate.value = rate;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = Q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, start); g.gain.linearRampToValueAtTime(amp, start + 0.002);
    g.gain.setTargetAtTime(0, start + 0.002, dur / 4);
    s.connect(f); f.connect(g); g.connect(out);
    s.start(start, rand() * 1.5); s.stop(start + dur * 1.8 + 0.01);
    nodes.push(s, f, g);
    return { s, f, g };
  };
  // the swish
  const sw = noise(t, 0.4, 'bandpass', 900, 0.6, 0, 0.8 + rand() * 0.3);
  sw.f.frequency.setValueAtTime(900, t);
  sw.f.frequency.exponentialRampToValueAtTime(3200 + rand() * 600, t + 0.13);
  sw.f.frequency.exponentialRampToValueAtTime(1500, t + 0.34);
  sw.g.gain.cancelScheduledValues(t);
  sw.g.gain.setValueAtTime(0, t);
  sw.g.gain.linearRampToValueAtTime(0.1, t + 0.05);
  sw.g.gain.linearRampToValueAtTime(0.065, t + 0.15);
  sw.g.gain.setTargetAtTime(0, t + 0.17, 0.06);
  // crinkles of paper
  const k = 3 + Math.floor(rand() * 4);
  for (let i = 0; i < k; i++) noise(t + 0.02 + rand() * 0.26, 0.01 + rand() * 0.02, 'bandpass', 2200 + rand() * 4500, 1.4, 0.025 + rand() * 0.035);
  // the page settling
  noise(t + 0.27 + rand() * 0.04, 0.05, 'lowpass', 300, 0.7, 0.07);
  setTimeout(() => { for (const nd of nodes) { try { nd.disconnect(); } catch (e) { /* gone */ } } }, 1200);
}

// Render a plant's song offline (for tests, or to make a recording).
// Resolves with the rendered AudioBuffer.
export function renderOffline(genome, seconds = 12, { sampleRate = 44100, context = null, dry, wet, onNote } = {}) {
  const OAC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  const ctx = context || new OAC(2, Math.ceil(sampleRate * seconds), sampleRate);
  const eng = new Engine(ctx, { offline: true, dry, wet });
  const s = new SongPlayer(genome, onNote);
  s._setup(eng, 0.05);
  s._run(seconds, 0);
  return ctx.startRendering();
}
