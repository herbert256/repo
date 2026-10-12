// FLORA NUSQUAM — the binding: turns pages, engraves plates, carries pollen.

import { genomeFromId, plateOfTheDay, PLATE_COUNT, toRoman, hslString } from './genome.js';
import { renderPlate } from './plate.js';
import { describe } from './text.js';
import { createSong, pageTurn, unlockAudio } from './song.js';
import { renderFlora, preloadFlora, FLORA_GENOME } from './flora.js';

const $ = (id) => document.getElementById(id);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const el = {
  plate: $('plate'), motes: $('motes'), plateWrap: $('plateWrap'), leaf: $('leaf'),
  titlePage: $('titlePage'), specimen: $('specimen'), floraPage: $('floraPage'), songFlora: $('songBtnFlora'),
  prev: $('prevBtn'), next: $('nextBtn'), random: $('randomBtn'), title: $('titleBtn'),
  song: $('songBtn'), songInline: $('songBtnInline'), pollen: $('pollenBtn'), pollenLabel: $('pollenLabel'),
  save: $('saveBtn'), link: $('linkBtn'), gotoForm: $('gotoForm'), gotoInput: $('gotoInput'),
  pollenChip: $('pollenChip'), pollenOf: $('pollenOf'), pollenDrop: $('pollenDrop'), toast: $('toast'),
};

const state = {
  genome: null,       // plant on the open page
  text: null,         // its description
  ctrl: null,         // engraving controller
  song: null,         // its song, when sung
  listening: false,   // keep singing as pages turn
  lastPlate: 1,       // last numbered plate, for turning pages away from a hybrid
  pollen: load('flora.pollen'),
  turn: 0,            // guards against stale page turns
  view: 'title',      // 'title' | 'flora' | 'plate'
};

// ------------------------------------------------------------------ helpers

function load(key) { try { return localStorage.getItem(key); } catch { return null; } }
function store(key, v) { try { v == null ? localStorage.removeItem(key) : localStorage.setItem(key, v); } catch { /* private mode */ } }

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const prose = (s) => esc(s).replace(/\*([^*]+)\*/g, '<i>$1</i>');
const wrapId = (id) => (id.includes('x') ? `(${id})` : id);
const shortLabel = (g) => g.label.replace(/^Tab\. /, '');

let toastTimer;
function toast(html, ms = 3200) {
  el.toast.innerHTML = html;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), ms);
}

function plateResolution() {
  const w = el.plateWrap.clientWidth || 600;
  return Math.max(0.9, Math.min(2.2, (w * (devicePixelRatio || 1)) / 1000));
}

function captionFor(g, d, label = g.label) {
  return { latin: d.plateTitle || d.latin.full, author: d.latin.author, label, del: d.credits?.del, sculp: d.credits?.sculp };
}

// ------------------------------------------------------------------ engraving

// Draw a plant's plate, or the goddess herself, onto a canvas.
function press(canvas, g, d, label, opts) {
  return g === FLORA_GENOME
    ? renderFlora(canvas, { ...opts, label: label || 'Frontispiece' })
    : renderPlate(canvas, g, { ...opts, caption: captionFor(g, d, label) });
}

function engrave(g, d, label) {
  state.ctrl?.cancel();
  motes.clear();
  const animate = !reducedMotion;
  el.plateWrap.classList.toggle('drawing', animate);
  let ctrl;
  try {
    ctrl = press(el.plate, g, d, label, {
      animate,
      resolution: plateResolution(),
      onDone: () => { if (state.ctrl === ctrl) el.plateWrap.classList.remove('drawing'); },
    });
  } catch (err) {
    console.error('The engraver faltered:', err);
    el.plateWrap.classList.remove('drawing');
    return null;
  }
  state.ctrl = ctrl;
  return ctrl;
}

el.plateWrap.addEventListener('click', () => {
  if (el.plateWrap.classList.contains('drawing')) state.ctrl?.finish();
  else if (state.view === 'title') go('flora');
});

// ------------------------------------------------------------------ pollen motes (the song made visible)

const motes = (() => {
  const cv = el.motes, ctx = cv.getContext('2d');
  let parts = [], rings = [], raf = 0, last = 0;

  function fit() {
    const r = cv.getBoundingClientRect(), dpr = devicePixelRatio || 1;
    const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    return { scale: (r.width / 1000) * dpr, dpr };
  }

  function emit(note) {
    const pts = state.ctrl?.flowerPoints;
    const g = state.genome;
    if (!pts?.length || !g) return;
    const { scale } = fit();
    const p = pts[Math.abs(note.degree ?? note.pitch ?? 0) % pts.length];
    const x = p.x * scale, y = p.y * scale, r = Math.max(6, (p.r || 14) * scale);
    const v = note.velocity ?? 0.6;
    if (note.voice === 'drone') { rings.push({ x, y, r0: r * 0.6, r1: r * 3.4, t: 0, life: 3.2, a: 0.12 }); start(); return; }
    rings.push({ x, y, r0: r * 0.4, r1: r * (1.6 + v * 1.4), t: 0, life: 1.4, a: 0.22 + v * 0.18 });
    const n = note.voice === 'counter' ? 3 : 5 + Math.round(v * 6);
    const colours = [g.colors.accent, g.colors.flower, g.colors.flowerInner];
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = Math.random() * r * 0.7;
      parts.push({
        x: x + Math.cos(a) * s, y: y + Math.sin(a) * s * 0.6,
        vx: (Math.random() - 0.5) * 14 * scale, vy: -(16 + Math.random() * 30) * scale,
        size: (0.9 + Math.random() * 1.8) * scale * 1.6, t: 0, life: 1.8 + Math.random() * 2,
        c: colours[i % colours.length], wob: Math.random() * 6,
      });
    }
    start();
  }

  function start() { if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); } }

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    ctx.clearRect(0, 0, cv.width, cv.height);
    rings = rings.filter((g) => (g.t += dt) < g.life);
    for (const g of rings) {
      const k = g.t / g.life, e = 1 - Math.pow(1 - k, 3);
      ctx.beginPath();
      ctx.ellipse(g.x, g.y, g.r0 + (g.r1 - g.r0) * e, (g.r0 + (g.r1 - g.r0) * e) * 0.82, 0, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(42,33,24,${g.a * (1 - k)})`;
      ctx.lineWidth = Math.max(0.6, 1.1 * (devicePixelRatio || 1) * (1 - k));
      ctx.stroke();
    }
    parts = parts.filter((p) => (p.t += dt) < p.life);
    for (const p of parts) {
      const k = p.t / p.life;
      p.x += (p.vx + Math.sin(p.t * 2.2 + p.wob) * 9) * dt;
      p.y += p.vy * dt; p.vy *= 0.995;
      const alpha = Math.min(1, p.t * 5) * (1 - k);
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * (1 - k * 0.4), 0, Math.PI * 2);
      ctx.fillStyle = hslString({ ...p.c, l: Math.min(p.c.l, 62) }, alpha * 0.85);
      ctx.fill();
      ctx.lineWidth = 0.5 * (devicePixelRatio || 1);
      ctx.strokeStyle = `rgba(42,33,24,${alpha * 0.45})`;
      ctx.stroke();
    }
    raf = parts.length || rings.length ? requestAnimationFrame(frame) : 0;
  }

  return {
    emit,
    clear() { parts = []; rings = []; ctx.clearRect(0, 0, cv.width, cv.height); },
  };
})();

// ------------------------------------------------------------------ song

function singCurrent() {
  const g = state.genome;
  if (!g) return;
  const song = createSong(g, {
    onNote: (n) => {
      if (reducedMotion || n.muted) return;
      setTimeout(() => { if (state.song === song) motes.emit(n); }, Math.max(0, (n.delay || 0) * 1000));
    },
  });
  state.song = song;
  song.play()?.catch?.((err) => console.warn('The plant would not sing:', err));
}

function toggleSong() {
  if (!state.genome) return;
  unlockAudio();
  if (state.listening) {
    state.listening = false;
    state.song?.stop();
    state.song = null;
  } else {
    state.listening = true;
    singCurrent();
    toast('The song will follow you as you turn the pages.', 2600);
  }
  updateSongButtons();
}

function updateSongButtons() {
  el.song.classList.toggle('active', state.listening);
  el.song.querySelector('span').textContent = state.listening ? 'Singing' : 'Song';
  el.songInline.classList.toggle('playing', state.listening);
  el.songInline.querySelector('span').textContent = state.listening ? 'Hush' : 'Hear its song';
  el.songFlora.classList.toggle('playing', state.listening);
  el.songFlora.querySelector('span').textContent = state.listening ? 'Hush' : 'Hear her song';
}

// ------------------------------------------------------------------ pages

function setText(id, s) { $(id).innerHTML = prose(s); }

function fillSpecimen(g, d) {
  $('rhLabel').textContent = g.label;
  $('rhFamily').textContent = d.family;
  const hn = $('hybridNote');
  if (g.parents) {
    const [a, b] = g.parents;
    hn.innerHTML = `A hybrid, raised from <a href="#${esc(a.id)}">${esc(a.label)}</a> ♀ × <a href="#${esc(b.id)}">${esc(b.label)}</a> ♂`;
    hn.hidden = false;
  } else hn.hidden = true;
  $('latin').innerHTML = `${prose(d.latin.full)} <span class="author">${esc(d.latin.author)}</span>`;
  $('family').textContent = d.family;
  $('common').innerHTML = d.common?.length ? `vulg. ${d.common.map((c) => `<span>${prose(c)}</span>`).join('; ')}` : '';
  setText('description', d.description);
  setText('etymology', d.etymology);
  setText('habitat', d.habitat);
  setText('flowering', d.flowering);
  setText('notesText', d.notes?.text);
  $('notesSig').textContent = d.notes?.collector || '';
  $('notesMeta').innerHTML = prose([d.notes?.place, d.notes?.date].filter(Boolean).join(', '));
  setText('virtues', d.virtues);
  setText('songText', d.song);
  $('figures').innerHTML = (d.figures || []).map((f) => `<li>${prose(f)}</li>`).join('');
  $('folio').textContent = `❦  ${g.label}  ❦`;
}

function showTitle() {
  const turn = ++state.turn;
  state.genome = null;
  state.text = null;
  if (state.listening) { state.listening = false; state.song?.stop(); state.song = null; updateSongButtons(); }
  state.view = 'title';
  document.body.classList.add('on-title');
  document.title = 'Flora Nusquam — a herbarium of plants that have never grown';
  el.specimen.hidden = true;
  el.floraPage.hidden = true;
  el.titlePage.hidden = false;
  el.plateWrap.classList.add('to-flora');
  el.plateWrap.title = 'Flora, goddess of flowers — turn to her page';
  el.gotoInput.value = '';
  el.gotoInput.placeholder = 'e.g. XLII';
  el.prev.disabled = true;
  el.title.disabled = true;
  el.leaf.scrollTop = 0;
  const today = plateOfTheDay();
  $('tpToday').href = `#${today}`;
  $('tpToday').textContent = `The specimen of the day`;
  $('tpToday').title = `Tab. ${toRoman(today)}`;
  // The frontispiece is the goddess herself.
  if (turn !== state.turn) return;
  state.frontispiece = FLORA_GENOME;
  engrave(FLORA_GENOME, null, 'Frontispiece');
  updatePollenUi();
}

function showFlora() {
  const turn = ++state.turn;
  state.genome = FLORA_GENOME;
  state.text = null;
  state.view = 'flora';
  document.body.classList.remove('on-title');
  document.title = 'Flora, goddess of flowers — Flora Nusquam';
  el.titlePage.hidden = true;
  el.specimen.hidden = true;
  el.floraPage.hidden = false;
  el.plateWrap.classList.remove('to-flora');
  el.plateWrap.title = '';
  el.floraPage.classList.remove('turning');
  void el.floraPage.offsetWidth;
  el.floraPage.classList.add('turning');
  el.leaf.scrollTop = 0;
  el.gotoInput.value = '';
  el.gotoInput.placeholder = 'Flora';
  el.prev.disabled = false;
  el.title.disabled = false;
  pageTurn();
  el.plate.classList.add('fading');
  setTimeout(() => {
    if (turn !== state.turn) return;
    engrave(FLORA_GENOME, null, 'Frontispiece');
    el.plate.classList.remove('fading');
    if (state.listening) singCurrent();
  }, reducedMotion ? 0 : 200);
  updatePollenUi();
}

function showPlate(g, { quiet = false } = {}) {
  const turn = ++state.turn;
  let d;
  try { d = describe(g); } catch (err) {
    console.error('The botanist faltered:', err);
    d = { latin: { full: g.label, author: '' }, family: '', common: [], description: 'The description of this plate has been lost.', figures: [] };
  }
  state.genome = g;
  state.text = d;
  if (g.plate) state.lastPlate = g.plate;

  state.view = 'plate';
  document.body.classList.remove('on-title');
  document.title = `${d.latin.full.replace(/\*/g, '')} — Flora Nusquam`;
  el.titlePage.hidden = true;
  el.floraPage.hidden = true;
  el.specimen.hidden = false;
  el.plateWrap.classList.remove('to-flora');
  el.plateWrap.title = '';
  fillSpecimen(g, d);
  el.specimen.classList.remove('turning');
  void el.specimen.offsetWidth;
  el.specimen.classList.add('turning');
  el.leaf.scrollTop = 0;

  el.gotoInput.value = g.plate ? toRoman(g.plate) : shortLabel(g);
  el.prev.disabled = false;
  el.title.disabled = false;

  if (!quiet) pageTurn();
  el.plate.classList.add('fading');
  setTimeout(() => {
    if (turn !== state.turn) return;
    engrave(g, d);
    el.plate.classList.remove('fading');
    if (state.listening) singCurrent();
  }, reducedMotion ? 0 : 200);
  updatePollenUi();
}

// ------------------------------------------------------------------ navigation

function go(id) {
  const h = `#${id}`;
  if (location.hash === h) route();
  else location.hash = h;
}

function step(delta) {
  if (state.view === 'title') { if (delta > 0) go('flora'); return; }
  if (state.view === 'flora') { go(delta > 0 ? 1 : 'title'); return; }
  const base = state.genome?.plate ?? state.lastPlate;
  let n = base + delta;
  if (n < 1) { go('flora'); return; }
  if (n > PLATE_COUNT) n = 1;
  go(n);
}

function randomPlate() { go(1 + Math.floor(Math.random() * PLATE_COUNT)); }

function parsePlateInput(raw) {
  const s = raw.trim().replace(/^tab\.?\s*/i, '').replace(/\s+/g, '');
  if (!s) return null;
  if (/^\d+$/.test(s)) return s;
  const roman = fromRoman(s);
  if (roman) return String(roman);
  // hybrids may be typed with ×/x between numbers or numerals
  const parts = s.split(/[×xX]/);
  if (parts.length === 2) {
    const a = parsePlateInput(parts[0]), b = parsePlateInput(parts[1]);
    if (a && b && !a.includes('x') && !b.includes('x')) return `${a}x${b}`;
  }
  return s;
}

function fromRoman(s) {
  if (!/^[MDCLXVI]+$/i.test(s)) return 0;
  const v = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  const u = s.toUpperCase();
  let n = 0;
  for (let i = 0; i < u.length; i++) {
    const a = v[u[i]], b = v[u[i + 1]] || 0;
    n += a < b ? -a : a;
  }
  return toRoman(n) === u ? n : 0;
}

function route() {
  const id = decodeURIComponent(location.hash.slice(1));
  if (!id || id === 'title') { showTitle(); return; }
  if (id.toLowerCase() === 'flora') { showFlora(); return; }
  const g = genomeFromId(id);
  if (!g) {
    toast(`There is no plate “${esc(id)}” in this herbarium.`);
    history.replaceState(null, '', '#title');
    showTitle();
    return;
  }
  showPlate(g);
}

// ------------------------------------------------------------------ pollination

function updatePollenUi() {
  const pollen = state.pollen ? genomeFromId(state.pollen) : null;
  if (state.pollen && !pollen) { state.pollen = null; store('flora.pollen', null); }
  el.pollenChip.hidden = !pollen;
  if (pollen) el.pollenOf.textContent = pollen.label;
  const g = state.view === 'plate' ? state.genome : null;
  el.pollen.disabled = state.view === 'flora';
  const canPollinate = pollen && g && pollen.id !== g.id;
  el.pollen.classList.toggle('armed', !!canPollinate);
  el.pollenLabel.textContent = canPollinate ? 'Pollinate' : pollen && g && pollen.id === g.id ? 'Pollen gathered' : 'Gather pollen';
  el.pollen.title = canPollinate
    ? `Pollinate this plate with the pollen of ${pollen.label}, and raise a hybrid`
    : 'Gather pollen to cross with another plate';
}

function pollinate() {
  const g = state.genome;
  if (!g || state.view !== 'plate') return;
  const pollen = state.pollen ? genomeFromId(state.pollen) : null;
  if (!pollen) {
    state.pollen = g.id;
    store('flora.pollen', g.id);
    toast(`Pollen of <b>${esc(g.label)}</b> gathered. Turn to another plate and pollinate it.`, 4200);
  } else if (pollen.id === g.id) {
    toast('Turn to another plate — a flower cannot be crossed with itself here.');
  } else {
    const id = `${wrapId(g.id)}x${wrapId(pollen.id)}`;
    const hybrid = genomeFromId(id);
    if (!hybrid) { toast('The cross did not take.'); return; }
    state.pollen = null;
    store('flora.pollen', null);
    toast(`Seed set on <b>${esc(g.label)}</b>. A new plant is raised…`, 3600);
    go(id);
  }
  updatePollenUi();
}

// ------------------------------------------------------------------ keeping & sharing

async function savePlate() {
  const g = state.genome, d = state.text;
  if (!g || (!d && g !== FLORA_GENOME)) return;
  toast('Pulling a fresh impression from the plate…', 2000);
  await new Promise((r) => setTimeout(r, 30));
  try {
    const cv = document.createElement('canvas');
    await press(cv, g, d, g.label, { animate: false, resolution: 2.4 }).done;
    const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `flora-nusquam-${g === FLORA_GENOME ? 'frontispiece-flora' : g.plate ? 'tab-' + toRoman(g.plate) : 'hybrid-' + g.id.replace(/[()]/g, '')}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  } catch (err) {
    console.error(err);
    toast('The impression could not be pulled.');
  }
}

async function copyLink() {
  const url = location.href;
  try { await navigator.clipboard.writeText(url); toast('A link to this plate has been copied.'); }
  catch { toast(esc(url), 5000); }
}

// ------------------------------------------------------------------ wiring

el.prev.addEventListener('click', () => step(-1));
el.next.addEventListener('click', () => step(+1));
el.random.addEventListener('click', randomPlate);
el.title.addEventListener('click', () => go('title'));
el.song.addEventListener('click', toggleSong);
el.songInline.addEventListener('click', toggleSong);
el.songFlora.addEventListener('click', toggleSong);
el.pollen.addEventListener('click', pollinate);
el.pollenDrop.addEventListener('click', () => { state.pollen = null; store('flora.pollen', null); updatePollenUi(); toast('The pollen is scattered.'); });
el.save.addEventListener('click', savePlate);
el.link.addEventListener('click', copyLink);
$('tpRandom').addEventListener('click', (e) => { e.preventDefault(); randomPlate(); });

el.gotoForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const id = parsePlateInput(el.gotoInput.value);
  if (/^flora$/i.test(el.gotoInput.value.trim())) { el.gotoInput.blur(); go('flora'); }
  else if (id && genomeFromId(id)) { el.gotoInput.blur(); go(id); }
  else toast('Give a plate between I and MMMCMXCIX (or 1 to 3999).');
});
el.gotoInput.addEventListener('focus', () => el.gotoInput.select());

addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key;
  if (k === 'ArrowRight') { step(+1); e.preventDefault(); }
  else if (k === 'ArrowLeft') { step(-1); e.preventDefault(); }
  else if (k === 'r' || k === 'R') randomPlate();
  else if ((k === 's' || k === 'S') && state.genome) toggleSong();
  else if (k === 'Escape' && state.genome) go('title');
});

// swipe to turn pages on small screens
let touch = null;
el.plateWrap.addEventListener('touchstart', (e) => { const t = e.touches[0]; touch = { x: t.clientX, y: t.clientY, at: Date.now() }; }, { passive: true });
el.plateWrap.addEventListener('touchend', (e) => {
  if (!touch) return;
  const t = e.changedTouches[0], dx = t.clientX - touch.x, dy = t.clientY - touch.y;
  if (Math.abs(dx) > 60 && Math.abs(dy) < 50 && Date.now() - touch.at < 700) step(dx < 0 ? +1 : -1);
  touch = null;
});

// re-engrave crisply if the window changes size a lot
let lastRes = 0, resizeTimer;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const r = plateResolution();
    if (Math.abs(r - lastRes) / (lastRes || 1) > 0.25) {
      lastRes = r;
      const g = state.genome || state.frontispiece;
      const d = g === FLORA_GENOME ? null : state.text || (g && describe(g));
      if (g && (d || g === FLORA_GENOME)) {
        state.ctrl?.cancel();
        state.ctrl = press(el.plate, g, d, state.view === 'plate' ? g.label : 'Frontispiece', { animate: false, resolution: r });
        el.plateWrap.classList.remove('drawing');
      }
    }
  }, 300);
});

addEventListener('hashchange', route);
preloadFlora().catch(() => {});
(async () => {
  try { await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 1200))]); } catch { /* no font API */ }
  lastRes = plateResolution();
  route();
})();
