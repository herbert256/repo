// FLORA NUSQUAM — the genome.
//
// Every plate in the herbarium is grown from a genome, and every genome from a
// plate number (or from two parent genomes, for hybrids). Everything else —
// the engraving, the Latin name, the field notes, the song — is derived from
// the genome deterministically, so plate 42 is the same plant for everyone,
// forever.
//
// This file is the shared contract between plate.js (drawing), text.js
// (names & prose) and song.js (music). Trait vocabularies are listed in the
// exported TRAITS object; consumers should handle every value listed there.

export const PLATE_COUNT = 3999; // the largest number the engravers could write

// ---------------------------------------------------------------- randomness

export function hash32(str) {
  str = String(str);
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

// Seeded PRNG (mulberry32) with conveniences. Same seed -> same sequence.
export function makeRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng = {
    next,
    float: (lo = 0, hi = 1) => lo + (hi - lo) * next(),
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)), // inclusive
    chance: (p) => next() < p,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    // weighted({a: 3, b: 1}) -> 'a' three times as often as 'b'
    weighted: (table) => {
      const entries = Object.entries(table).filter(([, w]) => w > 0);
      let total = 0;
      for (const [, w] of entries) total += w;
      let r = next() * total;
      for (const [k, w] of entries) { if ((r -= w) < 0) return k; }
      return entries[entries.length - 1][0];
    },
    gauss: (mean = 0, sd = 1) => {
      const u = 1 - next(), v = next();
      return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    shuffle: (arr) => {
      const out = arr.slice();
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
    // An independent stream derived from this one's seed and a salt.
    fork: (salt) => makeRng(hash32(seed + ':' + salt)),
  };
  return rng;
}

// The standard way for a consumer module to get its own random stream for a
// plant: rngFor(genome, 'text'), rngFor(genome, 'plate'), rngFor(genome, 'song').
export function rngFor(genome, salt) {
  return makeRng(hash32(genome.seed + ':' + salt));
}

// ---------------------------------------------------------------- vocabulary

export const TRAITS = {
  habit: ['herb', 'vine', 'shrublet', 'rosette', 'bulbous', 'aquatic', 'succulent', 'epiphyte'],
  lineage: ['dicot', 'monocot'],
  presentation: ['whole', 'sprig'], // whole plant with roots, or a cut flowering branch
  armature: ['none', 'hairs', 'thorns', 'tendrils'],
  leafShape: ['linear', 'ensiform', 'lanceolate', 'ovate', 'cordate', 'orbicular', 'peltate',
    'sagittate', 'lobed', 'palmate', 'pinnate', 'needle', 'terete'],
  leafArrangement: ['alternate', 'opposite', 'whorled', 'basal'],
  leafMargin: ['entire', 'serrate', 'crenate', 'undulate', 'ciliate'],
  venation: ['pinnate', 'palmate', 'parallel'],
  variegation: ['none', 'veined', 'spotted', 'margined'],
  flowerForm: ['rotate', 'stellate', 'campanulate', 'tubular', 'cup', 'lantern', 'labiate',
    'globose', 'spiral'],
  petalTip: ['rounded', 'acute', 'fringed', 'notched', 'filiform'],
  inflorescence: ['solitary', 'raceme', 'spike', 'umbel', 'panicle', 'cyme'],
  stamens: ['hidden', 'exserted', 'plume'],
  fruitForm: ['berry', 'capsule', 'pod', 'samara', 'drupe', 'bladder', 'beads'],
  rootForm: ['taproot', 'fibrous', 'tuber', 'rhizome', 'bulb', 'corm', 'aerial'],
  // The impossible property every plant in this herbarium has.
  marvel: ['luminous', 'glass', 'clockwork', 'tidal', 'smoke', 'crystal', 'feathered',
    'mirrored', 'weeping', 'nested', 'inverted', 'constellation', 'migratory', 'echoing'],
  figure: ['flower-front', 'flower-section', 'stamen', 'fruit', 'fruit-section', 'seed',
    'leaf', 'root', 'bud'],
  mode: ['ionian', 'lydian', 'mixolydian', 'dorian', 'aeolian', 'phrygian',
    'pentatonic', 'minor-pentatonic', 'wholetone', 'hirajoshi'],
  timbre: ['musicbox', 'celesta', 'glass', 'harp', 'bell', 'kalimba'],
};

// What each marvel means, for whoever needs to depict or describe it.
export const MARVELS = {
  luminous: 'the flowers glow softly after dusk',
  glass: 'petals are translucent, like blown glass, and chime when touched',
  clockwork: 'flowers open and close on the hour; the seeds are toothed like tiny gears',
  tidal: 'opens and closes with the tides of a sea it has never seen',
  smoke: 'the flowers breathe out thin curling wisps of pale blue smoke',
  crystal: 'roots and fruits are faceted crystal',
  feathered: 'leaves are barbed and soft like feathers',
  mirrored: 'below ground it grows a perfect inverted twin of its crown instead of roots',
  weeping: 'clear droplets hang from the tips of the petals',
  nested: 'within each flower blooms a smaller flower, and within that another',
  inverted: 'it grows downward, hanging from the ceilings of caves and the undersides of bridges',
  constellation: 'its petals are spotted with pale dots that map a constellation',
  migratory: 'it walks very slowly across the meadow on its roots',
  echoing: 'it repeats, faintly, the last words spoken near it',
};

// ---------------------------------------------------------------- colour

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const hsl = (h, s, l) => ({ h: ((h % 360) + 360) % 360, s: clamp(s, 0, 100), l: clamp(l, 0, 100) });

export function hslString(c, alpha = 1) {
  return alpha >= 1
    ? `hsl(${c.h.toFixed(1)} ${c.s.toFixed(1)}% ${c.l.toFixed(1)}%)`
    : `hsl(${c.h.toFixed(1)} ${c.s.toFixed(1)}% ${c.l.toFixed(1)}% / ${alpha})`;
}

function mixHue(a, b, t) {
  let d = ((b - a + 540) % 360) - 180;
  return (a + d * t + 360) % 360;
}

export function mixColor(a, b, t = 0.5) {
  return hsl(mixHue(a.h, b.h, t), a.s + (b.s - a.s) * t, a.l + (b.l - a.l) * t);
}

function makePalette(r, marvel) {
  // Foliage
  const leafFamily = r.weighted({ green: 70, blue: 10, glaucous: 8, purple: 6, golden: 6 });
  let leaf;
  switch (leafFamily) {
    case 'green': leaf = hsl(r.float(85, 140), r.float(28, 52), r.float(30, 44)); break;
    case 'blue': leaf = hsl(r.float(140, 172), r.float(22, 40), r.float(32, 44)); break;
    case 'glaucous': leaf = hsl(r.float(165, 210), r.float(10, 22), r.float(48, 60)); break;
    case 'purple': leaf = hsl(r.float(285, 345), r.float(18, 34), r.float(26, 38)); break;
    default: leaf = hsl(r.float(42, 70), r.float(35, 55), r.float(36, 48)); break;
  }
  const leafShade = hsl(leaf.h + r.float(-12, 12), leaf.s + 6, leaf.l - r.float(10, 16));

  // Flowers
  const flowerFamily = r.weighted({ hue: 78, white: 11, green: 6, dark: 3, glassy: marvel === 'glass' ? 40 : 2 });
  let flower;
  switch (flowerFamily) {
    case 'white': flower = hsl(r.float(0, 360), r.float(8, 22), r.float(86, 93)); break;
    case 'green': flower = hsl(r.float(70, 120), r.float(30, 50), r.float(58, 72)); break;
    case 'dark': flower = hsl(r.float(270, 360), r.float(30, 50), r.float(18, 26)); break;
    case 'glassy': flower = hsl(r.float(170, 230), r.float(20, 45), r.float(78, 88)); break;
    default: {
      let h = r.float(0, 360);
      if (h > 70 && h < 150) h = r.chance(0.5) ? r.float(20, 70) : r.float(150, 360);
      flower = hsl(h, r.float(40, 78), r.float(48, 74));
    }
  }
  const throat = r.weighted({ deeper: 50, golden: 25, contrast: 15, pale: 10 });
  let flowerInner;
  if (throat === 'deeper') flowerInner = hsl(flower.h + r.float(-15, 15), flower.s + 10, flower.l - r.float(18, 28));
  else if (throat === 'golden') flowerInner = hsl(r.float(40, 55), r.float(65, 85), r.float(52, 62));
  else if (throat === 'contrast') flowerInner = hsl(flower.h + 180 + r.float(-30, 30), r.float(40, 65), r.float(35, 55));
  else flowerInner = hsl(flower.h, flower.s * 0.4, Math.min(95, flower.l + 18));

  const accent = r.weighted({ yellow: 55, orange: 15, dark: 15, white: 10, red: 5 });
  const accentColor = {
    yellow: hsl(r.float(44, 56), r.float(70, 90), r.float(52, 62)),
    orange: hsl(r.float(22, 36), r.float(70, 85), r.float(48, 58)),
    dark: hsl(r.float(270, 330), r.float(30, 50), r.float(20, 30)),
    white: hsl(50, 20, 92),
    red: hsl(r.float(350, 365), r.float(60, 75), r.float(40, 50)),
  }[accent];

  const fruitFamily = r.weighted({ red: 30, orange: 15, blueblack: 20, purple: 12, gold: 10, translucent: 8, white: 5 });
  const fruit = {
    red: hsl(r.float(350, 368), r.float(60, 80), r.float(38, 50)),
    orange: hsl(r.float(18, 34), r.float(65, 85), r.float(46, 58)),
    blueblack: hsl(r.float(220, 250), r.float(25, 45), r.float(18, 28)),
    purple: hsl(r.float(280, 320), r.float(35, 55), r.float(28, 40)),
    gold: hsl(r.float(40, 52), r.float(55, 75), r.float(50, 60)),
    translucent: hsl(r.float(160, 200), r.float(20, 40), r.float(80, 88)),
    white: hsl(r.float(30, 60), r.float(10, 20), r.float(88, 94)),
  }[fruitFamily];

  const stem = r.chance(0.25)
    ? hsl(r.float(350, 380), r.float(25, 45), r.float(28, 38)) // reddish stems
    : hsl(leaf.h + r.float(-15, 10), leaf.s * 0.9, leaf.l + r.float(-4, 6));
  const root = hsl(r.float(28, 42), r.float(18, 35), r.float(62, 76));

  return { leaf, leafShade, flower, flowerInner, accent: accentColor, fruit, stem, root };
}

// ---------------------------------------------------------------- music

// Scriabin's clavier à lumières: each key has a colour. We go the other way —
// the flower's colour chooses the key of the plant's song.
const SCRIABIN = [
  { note: 'C', pc: 0, h: 0 },        // red
  { note: 'G', pc: 7, h: 25 },       // orange-rose
  { note: 'D', pc: 2, h: 55 },       // yellow
  { note: 'A', pc: 9, h: 115 },      // green
  { note: 'E', pc: 4, h: 195 },      // sky blue
  { note: 'B', pc: 11, h: 220 },     // pale blue
  { note: 'F♯', pc: 6, h: 240 },     // bright blue-violet
  { note: 'D♭', pc: 1, h: 270 },     // violet
  { note: 'A♭', pc: 8, h: 290 },     // purple-violet
  { note: 'E♭', pc: 3, h: 315 },     // steel / flesh
  { note: 'B♭', pc: 10, h: 335 },    // steel rose
  { note: 'F', pc: 5, h: 350 },      // deep red
];

function hueDistance(a, b) { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }

function deriveMusic(g, r) {
  const c = g.colors.flower;
  let key;
  if (c.s < 25 && c.l > 80) key = SCRIABIN[r.pick([0, 3, 4])]; // pale flowers: plain keys
  else key = SCRIABIN.slice().sort((a, b) => hueDistance(c.h, a.h) - hueDistance(c.h, b.h))[0];

  const formModes = {
    rotate: { ionian: 3, lydian: 2, pentatonic: 2 },
    stellate: { lydian: 3, ionian: 1, pentatonic: 1 },
    campanulate: { dorian: 3, aeolian: 2, pentatonic: 1 },
    tubular: { mixolydian: 3, dorian: 1, 'minor-pentatonic': 1 },
    cup: { 'minor-pentatonic': 3, aeolian: 1, ionian: 1 },
    lantern: { aeolian: 3, hirajoshi: 2, dorian: 1 },
    labiate: { phrygian: 3, hirajoshi: 1, aeolian: 1 },
    globose: { pentatonic: 3, ionian: 1, mixolydian: 1 },
    spiral: { wholetone: 4, lydian: 1 },
  };
  const table = { ...formModes[g.flower.form] };
  if (g.marvel === 'luminous' || g.marvel === 'constellation') table.lydian = (table.lydian || 0) + 2;
  if (g.marvel === 'weeping' || g.marvel === 'echoing') table.aeolian = (table.aeolian || 0) + 2;
  if (g.marvel === 'clockwork') table.wholetone = (table.wholetone || 0) + 1;
  const mode = r.weighted(table);

  const m = g.flower.merosity;
  const meter = m % 3 === 0 ? (r.chance(0.5) ? [3, 4] : [6, 8])
    : m === 5 || m === 10 ? [5, 4]
    : m === 7 ? [7, 8]
    : [4, 4];

  const timbreByMarvel = { glass: 'glass', clockwork: 'musicbox', luminous: 'celesta', crystal: 'glass', tidal: 'harp', constellation: 'celesta' };
  const timbreByHabit = { aquatic: 'bell', vine: 'harp', succulent: 'kalimba', epiphyte: 'celesta', bulbous: 'bell' };
  const timbre = timbreByMarvel[g.marvel] || timbreByHabit[g.habit] || r.pick(['musicbox', 'celesta', 'harp', 'kalimba']);

  // Taller plants sing slower and lower; crowded inflorescences sing denser.
  const bpm = Math.round(clamp(96 - g.stem.height * 38 + r.float(-6, 6), 50, 100));
  const octave = g.heightCm > 120 ? 3 : g.heightCm > 30 ? 4 : 5;
  const midi = 12 * (octave + 1) + key.pc;
  const density = clamp(0.25 + g.flower.count / 30 + r.float(-0.1, 0.1), 0.2, 0.9);
  const drone = ['bulb', 'corm', 'tuber', 'rhizome'].includes(g.root.form) || r.chance(0.3);

  return { tonic: key.note, pitchClass: key.pc, midi, mode, bpm, meter, timbre, density, drone };
}

// ---------------------------------------------------------------- growing

const HABIT_WEIGHTS = { herb: 5, vine: 2, shrublet: 2, rosette: 2, bulbous: 2, aquatic: 1.2, succulent: 1.2, epiphyte: 1 };

function grow(seed) {
  const r = makeRng(seed);
  const g = { seed };

  g.habit = r.weighted(HABIT_WEIGHTS);
  const monocotChance = { bulbous: 1, epiphyte: 0.5, aquatic: 0.4, herb: 0.15, rosette: 0.2 }[g.habit] || 0;
  g.lineage = r.chance(monocotChance) ? 'monocot' : 'dicot';
  const mono = g.lineage === 'monocot';

  g.presentation = ({ vine: 0.7, shrublet: 0.75, epiphyte: 0.3, herb: 0.2 }[g.habit] || 0.05) > r.next() ? 'sprig' : 'whole';

  g.heightCm = Math.round({
    herb: r.float(15, 90), vine: r.float(80, 400), shrublet: r.float(30, 150), rosette: r.float(6, 40),
    bulbous: r.float(15, 70), aquatic: r.float(10, 60), succulent: r.float(5, 50), epiphyte: r.float(10, 60),
  }[g.habit]);

  // --- stem
  const H = { herb: [0.55, 0.95], vine: [0.8, 1], shrublet: [0.6, 0.92], rosette: [0.25, 0.6], bulbous: [0.5, 0.9],
    aquatic: [0.35, 0.65], succulent: [0.3, 0.6], epiphyte: [0.4, 0.7] }[g.habit];
  const branchRange = { herb: [0.15, 0.65], vine: [0.3, 0.6], shrublet: [0.5, 0.9], rosette: [0, 0.15], bulbous: [0, 0.12],
    aquatic: [0, 0.3], succulent: [0.1, 0.5], epiphyte: [0.1, 0.4] }[g.habit];
  g.stem = {
    height: r.float(H[0], H[1]),                         // 0..1 of the drawable plate height
    lean: clamp(r.gauss(0, 0.35), -1, 1),                // overall bend, -1 left .. 1 right
    sinuosity: g.habit === 'vine' ? r.float(0.6, 1) : r.float(0, 0.45),
    thickness: g.habit === 'succulent' || g.habit === 'shrublet' ? r.float(0.55, 1) : r.float(0.15, 0.55),
    branching: r.float(branchRange[0], branchRange[1]),  // 0 none .. 1 profusely
    branchAngle: Math.round(r.float(20, 65)),            // degrees from parent
    nodes: r.int(3, 11),
    armature: g.habit === 'vine' && r.chance(0.7) ? 'tendrils'
      : r.weighted({ none: 6, hairs: 2, thorns: g.habit === 'shrublet' || g.habit === 'succulent' ? 3 : 0.7, tendrils: 0.3 }),
    twining: g.habit === 'vine',
  };

  // --- leaves
  let shape;
  if (mono) shape = r.weighted({ linear: 4, ensiform: 3, lanceolate: 3, ovate: 1, cordate: g.habit === 'aquatic' ? 2 : 0.3 });
  else if (g.habit === 'aquatic') shape = r.weighted({ orbicular: 3, peltate: 3, cordate: 2, sagittate: 2 });
  else if (g.habit === 'succulent') shape = r.weighted({ terete: 3, ovate: 2, lanceolate: 1, orbicular: 1 });
  else if (g.habit === 'vine') shape = r.weighted({ cordate: 4, palmate: 2, lobed: 2, sagittate: 1, pinnate: 1 });
  else shape = r.weighted({ lanceolate: 3, ovate: 3, cordate: 2, orbicular: 1, sagittate: 0.7, lobed: 2, palmate: 1.5, pinnate: 2, needle: 0.8, linear: 0.8 });
  const basal = ['rosette', 'bulbous'].includes(g.habit) || (g.habit === 'aquatic' && r.chance(0.6));
  g.leaf = {
    shape,
    arrangement: basal ? 'basal' : r.weighted({ alternate: 5, opposite: 3, whorled: 1 }),
    size: r.float(0.25, 1),
    margin: mono || shape === 'needle' || shape === 'terete' ? 'entire'
      : r.weighted({ entire: 3, serrate: 3, crenate: 2, undulate: 1.5, ciliate: 0.7 }),
    venation: mono || shape === 'linear' || shape === 'ensiform' ? 'parallel'
      : ['palmate', 'peltate', 'orbicular', 'cordate'].includes(shape) && r.chance(0.7) ? 'palmate' : 'pinnate',
    count: basal ? r.int(4, 12) : r.int(1, 3), // basal: total; otherwise per node (whorled ignores and uses 3-5)
    droop: r.float(0, 1),
    fleshy: g.habit === 'succulent',
    variegation: r.chance(0.15) ? r.pick(['veined', 'spotted', 'margined']) : 'none',
  };
  if (g.leaf.arrangement === 'whorled') g.leaf.count = r.int(3, 5);
  if (g.leaf.arrangement === 'opposite') g.leaf.count = 2;

  // --- flowers
  const merosity = mono ? r.pick([3, 3, 6]) : r.weighted({ 4: 2, 5: 6, 6: 1, 7: 0.6, 8: 1, 10: 0.5, 12: 0.4 }) | 0;
  const form = r.weighted({ rotate: 3, stellate: 2, campanulate: 3, tubular: 2, cup: 2, lantern: 1.2, labiate: mono ? 2 : 1, globose: 1, spiral: 0.6 });
  const inflorescence = g.habit === 'rosette' || g.habit === 'bulbous'
    ? r.weighted({ spike: 3, raceme: 3, umbel: 2, solitary: 2 })
    : r.weighted({ solitary: 3, raceme: 2, spike: 1.5, umbel: 1.5, panicle: 1.5, cyme: 2 });
  const counts = { solitary: [1, 3], raceme: [5, 14], spike: [8, 20], umbel: [5, 15], panicle: [8, 20], cyme: [3, 7] }[inflorescence];
  g.flower = {
    form,
    merosity,                               // petals per whorl
    whorls: form === 'globose' ? r.int(2, 3) : r.weighted({ 1: 6, 2: 2, 3: 0.6 }) | 0,
    petalTip: r.weighted({ rounded: 4, acute: 3, fringed: 1.2, notched: 1.5, filiform: 0.6 }),
    size: inflorescence === 'solitary' ? r.float(0.55, 1) : r.float(0.2, 0.6),
    inflorescence,
    count: r.int(counts[0], counts[1]),     // flowers per inflorescence
    nodding: ['campanulate', 'lantern', 'tubular'].includes(form) ? r.chance(0.65) : r.chance(0.12),
    stamens: r.weighted({ hidden: 3, exserted: 3, plume: 1 }),
    buds: r.chance(0.6),
  };

  // --- fruit & root
  g.fruit = {
    present: r.chance(0.7),
    form: r.weighted({ berry: 3, capsule: 3, pod: 2, samara: 1.5, drupe: 1.5, bladder: 1, beads: 0.6 }),
    count: r.int(1, 6),
  };
  let rootForm;
  if (g.habit === 'epiphyte') rootForm = 'aerial';
  else if (g.habit === 'bulbous') rootForm = r.weighted({ bulb: 4, corm: 1 });
  else if (mono) rootForm = r.weighted({ fibrous: 3, rhizome: 2, bulb: 1, corm: 1 });
  else if (g.habit === 'aquatic') rootForm = r.weighted({ rhizome: 3, fibrous: 2, tuber: 1 });
  else rootForm = r.weighted({ taproot: 4, fibrous: 3, tuber: 1.5, rhizome: 1.5 });
  g.root = { form: rootForm };

  // --- the impossible
  g.marvel = r.weighted({
    luminous: 1, glass: 0.8, clockwork: 0.8, tidal: 0.8, smoke: 0.8, crystal: 0.8, feathered: 0.8,
    mirrored: g.presentation === 'whole' ? 0.7 : 0, weeping: 0.9, nested: 0.7,
    inverted: g.habit === 'vine' || g.habit === 'aquatic' ? 0 : 0.5,
    constellation: 0.8, migratory: g.presentation === 'whole' && g.root.form !== 'aerial' ? 0.6 : 0, echoing: 0.6,
  });

  g.colors = makePalette(r.fork('colour'), g.marvel);
  g.figures = chooseFigures(g, r.fork('figures'));
  g.music = deriveMusic(g, r.fork('music'));
  return g;
}

function chooseFigures(g, r) {
  const pool = { 'flower-section': 3, 'flower-front': g.flower.nodding || g.flower.form === 'tubular' ? 3 : 1.5,
    stamen: 1.5, seed: 2, leaf: g.leaf.size < 0.5 ? 2 : 1, bud: g.flower.buds ? 0.5 : 1 };
  if (g.fruit.present) { pool.fruit = g.fruit.count < 2 ? 2.5 : 1.2; pool['fruit-section'] = 2; }
  if (g.presentation === 'sprig' || g.marvel === 'crystal') pool.root = g.root.form === 'aerial' ? 0 : 1.5;
  const n = r.weighted({ 2: 3, 3: 4, 4: 2 }) | 0;
  const out = [];
  while (out.length < n && Object.values(pool).some(w => w > 0)) {
    const kind = r.weighted(pool);
    delete pool[kind];
    const mag = { 'flower-section': r.pick([2, 3]), 'flower-front': 1, stamen: r.pick([5, 6, 8]), seed: r.pick([6, 8, 10, 12]),
      leaf: 1, bud: r.pick([2, 3]), fruit: r.pick([1, 2]), 'fruit-section': r.pick([2, 3]), root: 1 }[kind];
    out.push({ kind, mag }); // mag: ×1 natural size, ×8 magnified eight times
  }
  return out;
}

// ---------------------------------------------------------------- hybrids

function blendNumber(a, b, r) { const t = r.float(0.3, 0.7); return a + (b - a) * t; }

function crossGroup(a, b, r) {
  const out = {};
  for (const k of Object.keys(a)) {
    const va = a[k], vb = b[k];
    if (typeof va === 'number' && typeof vb === 'number') {
      const v = blendNumber(va, vb, r);
      out[k] = Number.isInteger(va) && Number.isInteger(vb) ? Math.round(v) : v;
    } else out[k] = r.chance(0.5) ? va : vb;
  }
  return out;
}

export function hybridize(a, b) {
  const id = `${wrapId(a.id)}x${wrapId(b.id)}`;
  const seed = hash32('hybrid:' + id);
  const r = makeRng(seed);
  const g = { seed };
  g.habit = r.chance(0.6) ? a.habit : b.habit;
  g.lineage = r.chance(0.5) ? a.lineage : b.lineage;
  g.presentation = r.chance(0.5) ? a.presentation : b.presentation;
  g.heightCm = Math.round(blendNumber(a.heightCm, b.heightCm, r));
  g.stem = crossGroup(a.stem, b.stem, r);
  g.stem.twining = g.habit === 'vine';
  g.leaf = crossGroup(a.leaf, b.leaf, r);
  if (g.leaf.arrangement === 'basal' && !['rosette', 'bulbous', 'aquatic'].includes(g.habit)) g.leaf.arrangement = 'alternate';
  if (g.leaf.arrangement === 'opposite') g.leaf.count = 2;
  g.flower = crossGroup(a.flower, b.flower, r);
  g.fruit = crossGroup(a.fruit, b.fruit, r);
  g.root = r.chance(0.5) ? { ...a.root } : { ...b.root };
  if (g.habit === 'epiphyte') g.root.form = 'aerial';
  else if (g.root.form === 'aerial') g.root.form = 'fibrous';
  g.marvel = r.chance(0.5) ? a.marvel : b.marvel;
  if (g.marvel === 'inverted' && (g.habit === 'vine' || g.habit === 'aquatic')) g.marvel = a.marvel === 'inverted' ? b.marvel : a.marvel;
  if (g.marvel === 'inverted' && (g.habit === 'vine' || g.habit === 'aquatic')) g.marvel = 'luminous';
  if ((g.marvel === 'mirrored' || g.marvel === 'migratory') && g.presentation !== 'whole') g.presentation = 'whole';
  if (g.marvel === 'migratory' && g.root.form === 'aerial') g.marvel = 'echoing';
  g.colors = {};
  for (const k of Object.keys(a.colors)) g.colors[k] = mixColor(a.colors[k], b.colors[k], r.float(0.25, 0.75));
  g.figures = chooseFigures(g, r.fork('figures'));
  g.music = deriveMusic(g, r.fork('music'));
  return finish(g, { id, plate: null, parents: [a, b] });
}

// ---------------------------------------------------------------- identity

function wrapId(id) { return id.includes('x') ? `(${id})` : id; }

export function toRoman(n) {
  if (!(n >= 1 && n <= 3999)) return String(n);
  const t = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'],
    [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let s = '';
  for (const [v, sym] of t) while (n >= v) { s += sym; n -= v; }
  return s;
}

function finish(g, { id, plate, parents }) {
  g.id = id;
  g.plate = plate;
  g.parents = parents;
  g.label = plate ? `Tab. ${toRoman(plate)}` : `Tab. ${parents.map(p => p.plate ? toRoman(p.plate) : '(' + p.label.replace('Tab. ', '') + ')').join(' × ')}`;
  return g;
}

const cache = new Map();

// The plant on plate n (1 ≤ n ≤ PLATE_COUNT).
export function genomeForPlate(n) {
  n = Math.max(1, Math.min(PLATE_COUNT, Math.floor(n)));
  const key = String(n);
  if (!cache.has(key)) cache.set(key, finish(grow(hash32('plate:' + n)), { id: key, plate: n, parents: null }));
  return cache.get(key);
}

// Parse an id like "42", "42x977" or "(42x977)x13" into a genome. Returns null if invalid.
export function genomeFromId(id) {
  id = String(id).trim().replace(/[×X]/g, 'x').replace(/\s+/g, '');
  if (cache.has(id)) return cache.get(id);
  const parse = (s) => {
    if (/^\d+$/.test(s)) { const n = +s; return n >= 1 && n <= PLATE_COUNT ? genomeForPlate(n) : null; }
    if (s.startsWith('(') && matchingParen(s, 0) === s.length - 1) return parse(s.slice(1, -1));
    let depth = 0;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '(') depth++;
      else if (s[i] === ')') depth--;
      else if (s[i] === 'x' && depth === 0) {
        const a = parse(s.slice(0, i)), b = parse(s.slice(i + 1));
        return a && b && a.id !== b.id ? hybridize(a, b) : null;
      }
    }
    return null;
  };
  const g = parse(id);
  if (g) cache.set(g.id, g);
  return g;
}

function matchingParen(s, i) {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === '(') depth++;
    else if (s[j] === ')' && --depth === 0) return j;
  }
  return -1;
}

// One plate per day, the same for everyone on Earth.
export function plateOfTheDay(date = new Date()) {
  const d = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
  return 1 + (hash32('day:' + d) % PLATE_COUNT);
}
