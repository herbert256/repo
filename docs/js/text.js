// FLORA NUSQUAM — the text.
//
// Names, descriptions, field notes and folklore for every plate, read from the
// genome. All chance comes from rngFor(genome, 'text') and its forks, so a
// plate reads the same for every reader, always.
//
// describe(genome) -> { latin, family, common, etymology, description, habitat,
//   flowering, notes, virtues, song, figures, credits, plateTitle }
// Strings are plain text; *asterisks* mark words to be set in italic.

import { rngFor, genomeForPlate, toRoman } from './genome.js';

// ---------------------------------------------------------------- helpers

const LETTER = /[A-Za-zÀ-ÿŒœ]/;

function cap(s) {
  for (let i = 0; i < s.length; i++) {
    if (LETTER.test(s[i])) return s.slice(0, i) + s[i].toUpperCase() + s.slice(i + 1);
  }
  return s;
}

const titleCase = (s) => s.split(' ').map(w => w.split('-').map((p, i) =>
  (i > 0 && /^(the|a|of|at|in|on|for|and|me|it|to|by)$/.test(p)) ? p : cap(p)).join('-')).join(' ');

// 'a' or 'an', by sound.
function an(word) {
  const w = word.replace(/^[*‘“]+/, '').toLowerCase();
  const vowel = (/^[aeiou]/.test(w) && !/^(uni|use|usu|uti|ure[^c]|eu|one|once|ewe)/.test(w)) || /^(hour|honest|heir|honour)/.test(w);
  return (vowel ? 'an ' : 'a ') + word;
}

function andList(arr) {
  if (arr.length <= 1) return arr.join('');
  return arr.slice(0, -1).join(', ') + ' and ' + arr[arr.length - 1];
}

const NUMS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven',
  'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
const num = (n) => NUMS[n] || String(n);

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
  'October', 'November', 'December'];

// Weighted pick from [[item, weight], ...].
function wpick(r, entries) {
  let total = 0;
  for (const [, w] of entries) if (w > 0) total += w;
  let x = r.next() * total;
  for (const [it, w] of entries) { if (w > 0 && (x -= w) < 0) return it; }
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i][1] > 0) return entries[i][0];
  return entries[entries.length - 1][0];
}

// '[a|b|c]' -> one of a, b, c (nestable). '{key}' -> ctx[key].
function vary(r, s) {
  let prev;
  do {
    prev = s;
    s = s.replace(/\[([^[\]]*)\]/g, (m, body) => r.pick(body.split('|')));
  } while (s !== prev);
  return s;
}

function fill(s, ctx) {
  return s.replace(/\{(\w+)\}/g, (m, k) => {
    const v = ctx[k];
    if (v === undefined || v === null) throw new Error('text.js: no value for {' + k + '} in “' + s + '”');
    return typeof v === 'function' ? v() : String(v);
  });
}

const T = (r, s, ctx = {}) => fill(vary(r, s), ctx);

// Typographic tidying: spaces, apostrophes, articles, capitals after full stops.
function tidy(s) {
  return s
    .replace(/\b([Aa]n?) ([*‘“]*[A-Za-z][\w-]*)/g, (m, art, w) => {
      const fixed = an(w);
      return art[0] === 'A' ? cap(fixed) : fixed;
    })
    .replace(/\s+/g, ' ')
    .replace(/ ([,.;:!?])/g, '$1')
    .replace(/([,;:])\1+/g, '$1')
    .replace(/\.\.+/g, '.')
    .replace(/,\./g, '.')
    .replace(/([A-Za-zœ])'([A-Za-z])/g, '$1’$2')
    .replace(/s' /g, 's’ ')
    .replace(/([.!?]["”’]?) ([a-z])/g, (m, p, c) => p + ' ' + c.toUpperCase())
    .replace(/^\s+|\s+$/g, '');
}

const sentence = (s) => { s = tidy(cap(s)); return /[.!?”]$/.test(s) ? s : s + '.'; };

// ---------------------------------------------------------------- colour

// Hue sectors: [upper bound, light names, middle names, dark names, muted names, white-tint]
const HUES = [
  [12, ['rose', 'shell-pink', 'pink'], ['red', 'scarlet', 'crimson', 'carmine'], ['crimson', 'garnet', 'oxblood'], ['dusky rose', 'old rose'], 'rosy'],
  [24, ['coral', 'salmon-pink'], ['vermilion', 'coral-red', 'cinnabar'], ['brick-red', 'rust'], ['dusky coral', 'terracotta'], 'rosy'],
  [38, ['apricot', 'peach'], ['orange', 'flame-orange', 'marigold'], ['rust', 'russet', 'burnt sienna'], ['fawn', 'biscuit'], 'creamy'],
  [50, ['buff', 'apricot'], ['amber', 'ochre', 'saffron'], ['tawny', 'umber', 'bronze'], ['fawn', 'buff', 'drab'], 'creamy'],
  [64, ['primrose', 'lemon', 'pale yellow'], ['yellow', 'gold', 'sulphur-yellow', 'buttercup-yellow'], ['mustard', 'old gold'], ['straw', 'tarnished gold'], 'creamy'],
  [85, ['citron', 'pale greenish yellow'], ['greenish yellow', 'citron', 'chartreuse'], ['olive'], ['olive-drab', 'khaki'], 'greenish'],
  [150, ['pale green', 'celadon'], ['green', 'leaf-green', 'apple-green', 'grass-green'], ['bottle-green', 'deep green'], ['sage', 'grey-green'], 'greenish'],
  [178, ['celadon', 'pale jade'], ['jade', 'sea-green', 'verdigris'], ['dark sea-green'], ['verdigris', 'grey-green'], 'greenish'],
  [200, ['aquamarine', 'pale turquoise'], ['turquoise', 'peacock-blue'], ['teal'], ['grey-blue', 'slate'], 'bluish'],
  [222, ['sky-blue', 'forget-me-not blue'], ['azure', 'cerulean', 'blue'], ['steel-blue', 'slate-blue'], ['grey-blue', 'steel-grey'], 'bluish'],
  [248, ['cornflower', 'powder-blue'], ['ultramarine', 'gentian-blue', 'cobalt'], ['indigo', 'navy'], ['slate-blue', 'pewter-blue'], 'bluish'],
  [268, ['periwinkle', 'lavender'], ['blue-violet', 'hyacinth-blue'], ['indigo', 'deep blue-violet'], ['heather-grey', 'dove-grey'], 'lilac'],
  [290, ['lavender', 'lilac'], ['violet', 'amethyst'], ['deep violet', 'pansy-purple'], ['heather', 'grey-violet'], 'lilac'],
  [312, ['lilac', 'orchid'], ['purple', 'amethyst', 'heliotrope'], ['plum', 'damson'], ['mauve', 'heather'], 'lilac'],
  [332, ['orchid-pink', 'mauve-pink'], ['magenta', 'fuchsia', 'heliotrope'], ['mulberry', 'wine'], ['mauve', 'dusky pink'], 'rosy'],
  [348, ['pink', 'rose-pink'], ['cerise', 'rose', 'carmine'], ['claret', 'wine-red'], ['dusky pink', 'ashes-of-roses'], 'rosy'],
  [361, ['rose', 'shell-pink', 'pink'], ['red', 'scarlet', 'crimson', 'carmine'], ['crimson', 'garnet', 'oxblood'], ['dusky rose', 'old rose'], 'rosy'],
];

// hsl -> 'pale violet', 'deep crimson', 'bluish white', 'smoke-grey', 'verdigris' ...
function colourName(c, r) {
  const { h, s, l } = c;
  const row = HUES.find(x => h < x[0]) || HUES[0];
  if (l < 13) return r.pick(['nearly black', 'black', 'sooty black']);
  if (l > 84 && s < 40) {
    if (s < 14) return r.pick(['white', 'milk-white', 'ivory', 'snow-white', 'chalk-white']);
    return r.chance(0.7) ? `${row[5]} white` : `white flushed with ${r.pick(row[1])}`;
  }
  if (s < 12 || (s < 18 && l > 30)) {
    if (l > 70) return r.pick(['pearl-grey', 'pale grey', 'silver-grey', 'dove-grey']);
    if (l > 48) return r.pick(['grey', 'smoke-grey', 'ash-grey', 'mouse-grey']);
    if (l > 28) return r.pick(['slate', 'dark grey', 'lead-grey']);
    return r.pick(['charcoal', 'soot-grey']);
  }
  if (l > 84) return 'palest ' + r.pick(row[1]);
  if (l < 24) return 'blackish ' + r.pick(row[3]).replace(/^(deep|dark) /, '');
  if (s < 30) return (l > 72 ? 'pale ' : '') + r.pick(row[4]);
  if (l > 70) return r.pick(row[1]);
  if (l < 36) return r.pick(row[3]);
  const name = r.pick(row[2]);
  if (s > 74 && r.chance(0.35)) return r.pick(['vivid', 'clear', 'bright']) + ' ' + name;
  if (l > 62 && r.chance(0.4)) return r.pick(['soft', 'pale', 'light']) + ' ' + name;
  return name;
}

// Broad colour family, for roots and epithets.
function colourFamily(c) {
  if (c.l < 22) return 'dark';
  if (c.l > 84 && c.s < 40) return 'white';
  if (c.s < 14 || (c.s < 22 && c.l > 45)) return c.l > 80 ? 'white' : 'grey';
  const h = c.h;
  if (h < 15 || h >= 345) return c.l > 68 ? 'pink' : 'red';
  if (h < 40) return 'orange';
  if (h < 68) return 'yellow';
  if (h < 178) return 'green';
  if (h < 250) return 'blue';
  if (h < 285) return 'violet';
  if (h < 320) return 'purple';
  return c.l > 62 ? 'pink' : 'red';
}

function leafColourName(c, r) {
  const { h, s, l } = c;
  if (s < 24 && l > 46) return r.pick(['glaucous', 'blue-grey', 'grey-green, bloomed like a plum']);
  if (h >= 270 || h < 20) return r.pick(['bronze-purple', 'dusky purple', 'livid purple', 'purplish bronze']);
  if (h < 75) return r.pick(['yellow-green', 'golden-green', 'olive-gold']);
  if (h >= 138) return r.pick(['blue-green', 'sea-green', 'dark blue-green']);
  if (l < 34) return r.pick(['dark green', 'deep green', 'sombre green']);
  if (s > 45) return r.pick(['bright green', 'fresh green', 'grass-green']);
  return r.pick(['green', 'dull green', 'mid-green', 'green']);
}

const hueGap = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

// ---------------------------------------------------------------- the world

// The gazetteer. ref: as it appears in a sentence; short: for folk names;
// lat: the Latin adjective for epithets; at: prepositions for field-note places.
const PLACES = [
  { id: 'hollow', ref: 'the Hollow Range', short: 'Hollow', tags: 'mountain cave rock moor high', lat: 'cavimontanus', at: ['high in', 'on the eastern slopes of', 'below the passes of'] },
  { id: 'askel', ref: 'the Fells of Askel', short: 'Askel', tags: 'mountain moor rock lake', lat: 'askelensis', at: ['high on', 'in the upper valleys of', 'on'] },
  { id: 'spindle', ref: 'the Spindle Peaks', short: 'Spindle', tags: 'mountain rock cliff high', lat: 'fusimontanus', at: ['below', 'among', 'on the scree beneath'] },
  { id: 'teeth', ref: 'the Grey Teeth', short: 'Grey Teeth', tags: 'mountain rock cliff high', lat: null, at: ['among', 'on the north face of', 'in a gully of'] },
  { id: 'ninefold', ref: 'the Ninefold Hills', short: 'Ninefold', tags: 'hills meadow chalk', lat: 'novemcollinus', at: ['in', 'high in', 'on the downs of'] },
  { id: 'downs', ref: 'the Pale Downs', short: 'Downland', tags: 'hills chalk meadow', lat: 'albicollinus', at: ['on', 'crossing', 'on the high road over'] },
  { id: 'lantern', ref: 'the Lantern Coast', short: 'Lantern', tags: 'seacliff coast cliff', lat: 'laternensis', at: ['on', 'along', 'on the cliff path of'] },
  { id: 'sorrow', ref: 'Cape Sorrow', short: 'Sorrow', tags: 'seacliff coast cliff', lat: null, at: ['at', 'on the headland of', 'below the light at'] },
  { id: 'merrow', ref: 'the Shoals of Merrow', short: 'Merrow', tags: 'coast sand', lat: 'merrowensis', at: ['on', 'at low water on', 'out on'] },
  { id: 'bitter', ref: 'the Bitterstrand', short: 'Bitterstrand', tags: 'coast sand salt', lat: null, at: ['on', 'at the near end of', 'at the far end of'] },
  { id: 'ure', ref: 'the Saltmarsh of Ure', short: 'Ure', tags: 'marsh salt coast water', lat: 'urensis', at: ['in', 'at the edge of', 'on the creeks of'] },
  { id: 'hollin', ref: 'the Fens of Hollin', short: 'Hollin', tags: 'marsh water peat', lat: 'hollinensis', at: ['in', 'punting through', 'on the dykes of'] },
  { id: 'sallow', ref: 'Sallowmere', short: 'Sallowmere', tags: 'lake water marsh', lat: 'sallowmerensis', at: ['at', 'on the shore of', 'rowing on'] },
  { id: 'wend', ref: 'the river Wend', short: 'Wend', tags: 'river water meadow', lat: 'wendensis', at: ['on', 'along', 'at the crossing on'] },
  { id: 'ambry', ref: 'the water-meadows of Ambry', short: 'Ambry', tags: 'river meadow water', lat: 'ambriensis', at: ['in', 'crossing', 'at the far side of'] },
  { id: 'hesk', ref: 'the drowned town of Hesk', short: 'Hesk', tags: 'drowned water', lat: 'heskensis', at: ['above', 'over', 'rowing above'] },
  { id: 'callow', ref: 'the drowned village of Lower Callow', short: 'Callow', tags: 'drowned water reservoir', lat: 'callowensis', at: ['above', 'at the dam above', 'over'] },
  { id: 'ebbawater', ref: 'Saint Ebba’s-under-Water', short: 'Saint Ebba’s', tags: 'drowned water church', lat: null, at: ['above', 'at', 'over the steeple of'] },
  { id: 'valleys', ref: 'the Drowned Valleys', short: 'Valley', tags: 'reservoir drowned water', lat: null, at: ['in', 'surveying in', 'at the head of'] },
  { id: 'vell', ref: 'Old Vell', short: 'Vell', tags: 'town bridge garden wall churchyard', lat: 'vellensis',
    as: { bridge: 'the bridges of Old Vell', wall: 'the old walls of Old Vell', garden: 'the gardens of Old Vell' }, at: ['in', 'beneath the bridges of', 'on the walls of', 'in the Clockmakers’ Quarter of'] },
  { id: 'wyle', ref: 'Wyle', short: 'Wyle', tags: 'town garden churchyard', lat: 'wylensis', as: { garden: 'the physic garden at Wyle' }, at: ['near', 'outside', 'in the physic garden at'] },
  { id: 'owlsbury', ref: 'Owlsbury', short: 'Owlsbury', tags: 'town churchyard garden wall', lat: 'owlsburiensis',
    as: { wall: 'the churchyard wall at Owlsbury', garden: 'the cottage gardens of Owlsbury' }, at: ['near', 'in the churchyard at', 'on the road to'] },
  { id: 'grimmet', ref: 'the old tin-workings at Grimmet', short: 'Grimmet', tags: 'mine ruin', lat: 'grimmetensis', at: ['in', 'above', 'among'] },
  { id: 'eskern', ref: 'Eskern Heath', short: 'Eskern', tags: 'heath moor sand', lat: 'eskernensis', at: ['on', 'crossing', 'at the edge of'] },
  { id: 'kell', ref: 'the salt-flats of Kell', short: 'Kell', tags: 'salt flats', lat: 'kellensis', at: ['on', 'at the edge of', 'crossing'] },
  { id: 'mirth', ref: 'the Isle of Mirth', short: 'Mirth', tags: 'seacliff island coast cliff', lat: 'mirthensis', at: ['on', 'off the north shore of', 'on the western cliffs of'] },
  { id: 'glass', ref: 'the Glass Islands', short: 'Glass Island', tags: 'island coast sand', lat: 'vitrinsularis', at: ['in', 'on the smallest of', 'among'] },
  { id: 'vane', ref: 'the Skerries of Vane', short: 'Vane', tags: 'seacliff island rock coast', lat: 'vanensis', at: ['on', 'landing on', 'among'] },
  { id: 'quarantine', ref: 'the Quarantine Station on Little Quarantine', short: 'Quarantine', tags: 'island ruin', lat: null, at: ['at', 'among the ruins of'] },
  { id: 'ebba', ref: 'the Convent of Saint Ebba', short: 'Saint Ebba’s', tags: 'monastery garden mountain wall', lat: 'sanctae-ebbae',
    as: { wall: 'the walls of the Convent of Saint Ebba', garden: 'the convent garden of Saint Ebba', mountain: 'the mountain below the Convent of Saint Ebba' }, at: ['below', 'in the garth of', 'on the road to'] },
  { id: 'charter', ref: 'the Charterhouse at Wyle', short: 'Charterhouse', tags: 'monastery garden ruin wall', lat: null,
    as: { wall: 'the cloister walls of the Charterhouse at Wyle', garden: 'the old garden of the Charterhouse at Wyle' }, at: ['in the cloister of', 'at', 'behind'] },
  { id: 'scarrow', ref: 'the lime quarries at Scarrow', short: 'Scarrow', tags: 'quarry rock limestone', lat: 'scarrowensis', at: ['in', 'on the spoil-heaps of', 'above'] },
  { id: 'morrowdene', ref: 'the chalk-pits of Morrowdene', short: 'Morrowdene', tags: 'quarry chalk', lat: 'morrowdenensis', at: ['in', 'above', 'at the bottom of'] },
  { id: 'undle', ref: 'the Caves of Undle', short: 'Undle', tags: 'cave', lat: 'undlensis', at: ['in', 'at the mouth of', 'deep in'] },
  { id: 'bellhollow', ref: 'the Bellhollow', short: 'Bellhollow', tags: 'cave', lat: null, at: ['in', 'at the bottom of', 'by candle in'] },
  { id: 'ise', ref: 'the whispering galleries of Mount Ise', short: 'Ise', tags: 'cave mountain', lat: 'isensis', at: ['in', 'at the entrance to'] },
  { id: 'orrery', ref: 'Mount Orrery', short: 'Orrery', tags: 'mountain ruin high', lat: 'orrerianus', at: ['on', 'below the old observatory on', 'high on'] },
  { id: 'fenn', ref: 'the larch woods of Fenn', short: 'Fenn', tags: 'wood mountain', lat: 'fennensis', at: ['in', 'at the edge of', 'deep in'] },
  { id: 'lampwood', ref: 'the Lampwood', short: 'Lampwood', tags: 'wood', lat: null, at: ['in', 'in a clearing of', 'on the far side of'] },
  { id: 'ost', ref: 'the Wandering Meadows of Ost', short: 'Ost', tags: 'meadow', lat: 'ostensis', at: ['in', 'crossing', 'at the upper end of'] },
  { id: 'askelbridge', ref: 'the Weeping Bridge at Tarn Askel', short: 'Tarn', tags: 'bridge lake', lat: null, at: ['beneath', 'on', 'below'] },
  { id: 'porthollin', ref: 'Port Hollin', short: 'Port Hollin', tags: 'harbour town coast', lat: null, at: ['in the harbour at', 'on the quays of', 'near'] },
  { id: 'thornmouth', ref: 'Thornmouth', short: 'Thornmouth', tags: 'harbour town coast', lat: 'thornmuthensis', at: ['near', 'on the quays of', 'above'] },
  { id: 'brakewater', ref: 'the mill at Brakewater', short: 'Brakewater', tags: 'river mill water ruin', lat: null, at: ['by', 'in the race of', 'below'] },
  { id: 'quillhall', ref: 'Quill Hall', short: 'Quill', tags: 'garden', lat: null, at: ['at', 'in the glasshouses at'] },
];
const PLACE = Object.fromEntries(PLACES.map(p => [p.id, p]));

function placesTagged(tags) {
  const want = tags.split('/');
  return PLACES.filter(p => want.some(t => p.tags.split(' ').includes(t)));
}

// The botanists of the herbarium.
const COLLECTORS = [
  { id: 'vellum', name: 'Agathe Vellum', abbr: 'Vell.', ep: 'vellumiae', f: true, life: '1811–1874', active: [1832, 1871],
    haunts: ['lantern', 'sorrow', 'mirth', 'glass', 'merrow', 'bitter', 'vane'], raise: 0.5,
    garden: 'the walled garden below the lighthouse at Cape Sorrow',
    about: 'the lighthouse-keeper’s daughter of Cape Sorrow, widowed at twenty-six, who painted her plants by the light of the lamp' },
  { id: 'ashgrove', name: 'Tobias Ashgrove', abbr: 'Ashgr.', ep: 'ashgrovei', f: false, life: '1772–1849', active: [1798, 1846],
    haunts: ['vell', 'ambry', 'ninefold', 'wend', 'brakewater'], raise: 1,
    garden: 'the narrow garden behind the clock-shop in Old Vell',
    about: 'the clockmaker of Old Vell, who went nearly blind at his bench and thereafter botanised by touch and by ear' },
  { id: 'brenn', name: 'Sister Ottilie Brenn', abbr: 'Brenn', ep: 'brenniae', f: true, life: '1797–1868', active: [1820, 1866],
    haunts: ['ebba', 'hollow', 'spindle', 'fenn', 'askel'], raise: 1,
    garden: 'the cloister garth of the Convent of Saint Ebba',
    about: 'a sister of the Convent of Saint Ebba, who pressed her specimens between the pages of her psalter' },
  { id: 'hollander', name: 'Casimir Hollander', abbr: 'Holl.', ep: 'hollanderi', f: false, life: '1761–1833', active: [1788, 1829],
    haunts: ['kell', 'vane', 'quarantine', 'teeth', 'glass', 'mirth', 'eskern'], raise: 0,
    garden: 'a borrowed garden at Port Hollin',
    about: 'the exiled cartographer, who mapped the coasts of a country that would not have him back' },
  { id: 'emoerk', name: 'Edmund Mœrk', abbr: 'E.Mœrk', ep: 'moerkii', f: false, life: '1828–1893', active: [1850, 1891],
    haunts: ['owlsbury', 'eskern', 'fenn', 'ost', 'morrowdene'], raise: 0.8, brother: 'smoerk',
    garden: 'Edmund Mœrk’s half of the divided garden at Owlsbury',
    about: 'the elder of the Mœrk brothers, who spent forty years disputing priority with the younger' },
  { id: 'smoerk', name: 'Silas Mœrk', abbr: 'S.Mœrk', ep: 'moerkii', f: false, life: '1831–1899', active: [1852, 1897],
    haunts: ['owlsbury', 'eskern', 'fenn', 'ost', 'scarrow'], raise: 0.8, brother: 'emoerk',
    garden: 'Silas Mœrk’s half of the divided garden at Owlsbury',
    about: 'the younger of the Mœrk brothers, who outlived the elder and corrected his labels for six years after' },
  { id: 'carrow', name: 'Ivo Carrow', abbr: 'Carrow', ep: 'carrowii', f: false, life: '1834–1905', active: [1859, 1903],
    haunts: ['callow', 'hesk', 'valleys', 'sallow', 'wend', 'ebbawater', 'askelbridge'], raise: 0,
    garden: 'a window-box at the surveyor’s lodgings in Wyle',
    about: 'surveyor to the Reservoir Commission, who measured eleven valleys so that they might be drowned' },
  { id: 'quill', name: 'Lady Harriet Quill', abbr: 'Quill', ep: 'quilliae', f: true, life: '1838–1919', active: [1866, 1912],
    haunts: ['quillhall', 'downs', 'ninefold', 'lampwood'], raise: 6,
    garden: 'the glasshouses at Quill Hall',
    about: 'the hybridist of Quill Hall, whose glasshouses were said to be heated more generously than her guests' },
  { id: 'orme', name: 'Dr Fenwick Orme', abbr: 'Orme', ep: 'ormei', f: false, life: '1755–1822', active: [1783, 1821],
    haunts: ['wyle', 'charter', 'downs', 'owlsbury', 'grimmet'], raise: 1,
    garden: 'the physic garden at Wyle',
    about: 'physician of Wyle, who tried the virtues of every plant he described upon himself' },
  { id: 'lisk', name: 'Margarethe Lisk', abbr: 'Lisk', ep: 'liskiae', f: true, life: '1846–1911', active: [1871, 1909],
    haunts: ['ost', 'morrowdene', 'scarrow', 'ninefold', 'ambry'], raise: 0.5,
    garden: 'the school garden at Ost',
    about: 'schoolmistress at Ost, who botanised every Thursday with whichever pupils could be persuaded' },
  { id: 'hallum', name: 'Pieter Hallum', abbr: 'Hallum', ep: 'hallumii', f: false, life: '1815–1886', active: [1840, 1880],
    haunts: ['wend', 'hollin', 'ure', 'sallow', 'brakewater', 'porthollin'], raise: 0.3,
    garden: 'the ferry-house garden on the Wend',
    about: 'ferryman on the river Wend for forty years, who collected everything within reach of the boat' },
  { id: 'wren', name: 'Esther Wren', abbr: 'Wren', ep: 'wreniae', f: true, life: '1858–1931', active: [1880, 1912],
    haunts: ['teeth', 'spindle', 'orrery', 'sorrow', 'mirth', 'vane'], raise: 0,
    garden: 'a balcony at Thornmouth',
    about: 'the aeronaut, who collected from cliff-ledges no one else could reach, out of the basket of her balloon *Petrel*' },
];
const COLL = Object.fromEntries(COLLECTORS.map(c => [c.id, c]));

const DELINEATORS = [['A. Vellum', 1832, 1871], ['O. Brenn', 1820, 1866], ['M. Osterlay', 1780, 1830],
  ['C. Penmarrow', 1838, 1886], ['I. Strand', 1858, 1906], ['E. Wren', 1880, 1912], ['H. Quill', 1866, 1912],
  ['F. Darrow', 1795, 1842], ['R. Ambrose', 1868, 1912], ['L. Kettle', 1812, 1860], ['M. Lisk', 1871, 1909]];
const ENGRAVERS = [['J. Ashgrove', 1826, 1880], ['W. Tallis', 1780, 1826], ['R. Corvell', 1808, 1856],
  ['H. Mardle', 1848, 1900], ['P. Gaunt', 1868, 1912], ['E. Lowther', 1798, 1846], ['B. Sorrel', 1858, 1912],
  ['T. Fenwick', 1830, 1872]];

const CONSTELLATIONS = ['the Plough', 'Cassiopeia', 'the Pleiades', 'Orion’s Belt', 'the Northern Crown', 'the Swan',
  'the Lyre', 'the Hare', 'the Dolphin', 'the Dragon', 'Andromeda', 'the Little Bear', 'the Twins', 'the Scorpion',
  'the Ship', 'the Lesser Dog'];
const LOST_STARS = ['a constellation in no atlas', 'a constellation no astronomer has been able to find',
  'a sky that is not ours', 'a constellation said to have set for the last time in 1572'];

const SCENTS = ['snuffed candles', 'wet slate', 'cedar shavings', 'church incense', 'burnt sugar', 'rain on hot stone',
  'a sealed letter', 'pipe tobacco', 'gunpowder', 'old hymn-books', 'oranges', 'cold ashes', 'hot iron', 'peat-smoke',
  'a blown-out lamp', 'cloves', 'bonfires in a neighbouring parish'];

const SEAS = ['the Narrow Sea', 'the Grey Sea', 'the Sound of Vane', 'the Bitter Sea', 'the sea beyond the Spindle Peaks',
  'the Northern Ocean', 'a sea that no longer exists', 'the Gulf of Merrow'];

const DIRECTIONS = ['north', 'south', 'east', 'west', 'north-east', 'south-west', 'north-west', 'south-east'];

// ---------------------------------------------------------------- Latin: roots

// First elements of genus names: [stem, Greek word, meaning]. Stems are given
// in Latin spelling, without the linking vowel.
const R = (s, w, gl, extra = {}) => ({ s, w, gl, sem: s, ...extra });

const MARVEL_STEMS = {
  luminous: [R('lychn', 'lychnos', 'a lamp'), R('phot', 'phōs', 'light'), R('lampad', 'lampas', 'a torch'),
    R('nyct', 'nyx', 'night'), R('selen', 'selēnē', 'the moon'), R('pheng', 'phengos', 'radiance')],
  glass: [R('hyal', 'hyalos', 'glass'), R('diaphan', 'diaphanēs', 'transparent'), R('cymbal', 'kymbalon', 'a cymbal'),
    R('phial', 'phialē', 'a glass vessel')],
  clockwork: [R('chron', 'chronos', 'time'), R('hor', 'hōra', 'an hour'), R('horolog', 'hōrologion', 'a clock'),
    R('troch', 'trochos', 'a wheel'), R('hemer', 'hēmera', 'a day'), R('gnomon', 'gnōmōn', 'the pointer of a sundial')],
  tidal: [R('thalass', 'thalassa', 'the sea'), R('pelag', 'pelagos', 'the open sea'), R('cym', 'kyma', 'a wave'),
    R('plemmyr', 'plēmmyris', 'the flood-tide'), R('ampot', 'ampōtis', 'the ebb-tide'), R('hal', 'hals', 'the sea')],
  smoke: [R('capn', 'kapnos', 'smoke'), R('atm', 'atmos', 'vapour'), R('nephel', 'nephelē', 'a cloud'),
    R('aethal', 'aithalē', 'soot'), R('typh', 'typhos', 'smoke')],
  crystal: [R('crystall', 'krystallos', 'ice, or crystal'), R('lith', 'lithos', 'a stone'), R('goni', 'gōnia', 'an angle'),
    R('adamant', 'adamas', 'the unconquerable stone')],
  feathered: [R('pter', 'pteron', 'a feather'), R('ptil', 'ptilon', 'down'), R('pten', 'ptēnos', 'feathered'),
    R('ornith', 'ornis', 'a bird')],
  mirrored: [R('catoptr', 'katoptron', 'a mirror'), R('eidol', 'eidōlon', 'an image'), R('didym', 'didymos', 'a twin'),
    R('dipl', 'diploos', 'double')],
  weeping: [R('dacry', 'dakry', 'a tear', { noLat: true }), R('penth', 'penthos', 'grief'), R('stalact', 'stalaktos', 'dripping'),
    R('dros', 'drosos', 'dew')],
  nested: [R('end', 'endon', 'within'), R('embol', 'embolē', 'a thing set inside another'), R('pyxid', 'pyxis', 'a box'),
    R('palin', 'palin', 'again')],
  inverted: [R('cremast', 'kremastos', 'hanging'), R('antipod', 'antipous', 'having the feet opposite'),
    R('antr', 'antron', 'a cave'), R('gephyr', 'gephyra', 'a bridge')],
  constellation: [R('astr', 'astron', 'a star', { sem: 'star' }), R('uran', 'ouranos', 'the sky'), R('pleiad', 'Pleias', 'the Pleiades'),
    R('stict', 'stiktos', 'spotted')],
  migratory: [R('planet', 'planētēs', 'a wanderer'), R('nomad', 'nomas', 'a wanderer'), R('peripat', 'peripatos', 'a walking about'),
    R('hod', 'hodos', 'a road')],
  echoing: [R('ech', 'ēchō', 'an echo'), R('phon', 'phōnē', 'a voice'), R('lal', 'lalia', 'chatter'), R('mnem', 'mnēmē', 'memory')],
};

const COLOUR_STEMS = {
  red: [R('erythr', 'erythros', 'red'), R('haem', 'haima', 'blood')],
  pink: [R('rhod', 'rhodon', 'a rose')],
  orange: [R('pyr', 'pyr', 'fire'), R('croc', 'krokos', 'saffron')],
  yellow: [R('chrys', 'chrysos', 'gold'), R('xanth', 'xanthos', 'yellow')],
  green: [R('chlor', 'chlōros', 'pale green'), R('prasin', 'prasinos', 'leek-green')],
  blue: [R('cyan', 'kyanos', 'dark blue')],
  violet: [R('ianth', 'ianthinos', 'violet-coloured')],
  purple: [R('porphyr', 'porphyra', 'purple')],
  white: [R('leuc', 'leukos', 'white'), R('galact', 'gala', 'milk')],
  grey: [R('argyr', 'argyros', 'silver'), R('poli', 'polios', 'grey')],
  dark: [R('melan', 'melas', 'black'), R('scot', 'skotos', 'darkness')],
};

const FORM_STEMS = {
  rotate: [R('cycl', 'kyklos', 'a circle'), R('actin', 'aktis', 'a ray', { sem: 'ray' }), R('troch', 'trochos', 'a wheel')],
  stellate: [R('aster', 'astēr', 'a star', { sem: 'star' }), R('actin', 'aktis', 'a ray', { sem: 'ray' }), R('astr', 'astron', 'a star', { sem: 'star' })],
  campanulate: [R('codon', 'kōdōn', 'a bell', { sem: 'bell' }), R('crotal', 'krotalon', 'a rattle', { sem: 'bell' })],
  tubular: [R('siphon', 'siphōn', 'a tube', { sem: 'tube' }), R('aul', 'aulos', 'a flute', { sem: 'tube' })],
  cup: [R('cyath', 'kyathos', 'a cup', { sem: 'cup' }), R('scyph', 'skyphos', 'a cup', { sem: 'cup' })],
  lantern: [R('phys', 'physa', 'a bladder', { sem: 'bladder' }), R('lampter', 'lamptēr', 'a lantern', { sem: 'lychn' })],
  labiate: [R('cheil', 'cheilos', 'a lip', { sem: 'lip' }), R('stomat', 'stoma', 'a mouth', { sem: 'lip' })],
  globose: [R('sphaer', 'sphaira', 'a ball', { sem: 'ball' }), R('phys', 'physa', 'a bladder', { sem: 'bladder' })],
  spiral: [R('helic', 'helix', 'a spiral', { sem: 'spiral' }), R('strept', 'streptos', 'twisted', { sem: 'spiral' }),
    R('stromb', 'strombos', 'a spiral shell', { sem: 'spiral' })],
};

const LEAF_STEMS = {
  cordate: [R('cardi', 'kardia', 'the heart')], lanceolate: [R('dory', 'dory', 'a spear', { noLat: true })],
  ensiform: [R('xiph', 'xiphos', 'a sword')], orbicular: [R('cycl', 'kyklos', 'a circle')],
  peltate: [R('aspid', 'aspis', 'a shield')], sagittate: [R('bel', 'belos', 'a dart')],
  palmate: [R('dactyl', 'daktylos', 'a finger')], needle: [R('rhaph', 'rhaphis', 'a needle')],
  terete: [R('cylindr', 'kylindros', 'a roller')], linear: [R('lept', 'leptos', 'slender')],
};
const HABIT_STEMS = {
  aquatic: [R('hydr', 'hydōr', 'water', { why: 'for its home in still water' }), R('limn', 'limnē', 'a pool', { why: 'for its home in pools and ditches' })],
  succulent: [R('sarc', 'sarx', 'flesh', { why: 'for its fleshy substance' })],
  epiphyte: [R('aer', 'aēr', 'the air', { why: 'for its life high on the branches of trees' }), R('dendr', 'dendron', 'a tree', { why: 'for its life upon trees' })],
  rosette: [R('chamae', 'chamai', 'on the ground', { vEnd: true, why: 'for its low growth' }), R('petr', 'petra', 'a rock', { why: 'for its home among rocks' })],
  shrublet: [R('thamn', 'thamnos', 'a shrub', { sem: 'shrub', why: 'for its shrubby habit' })], vine: [R('ampel', 'ampelos', 'a vine', { why: 'for its climbing habit' })],
  bulbous: [R('bolb', 'bolbos', 'a bulb', { why: 'for its bulb' })],
};
const ARMATURE_STEMS = {
  hairs: [R('trich', 'thrix', 'a hair', { why: 'for its hairy stems' }), R('lasi', 'lasios', 'shaggy', { why: 'for its hairy stems' })],
  thorns: [R('acanth', 'akantha', 'a thorn', { why: 'for its thorns' }), R('echin', 'echinos', 'a hedgehog', { why: 'for its thorns' })],
};

// Final elements: [ending, gender, Greek word, meaning, family form, sense]
const E = (e, g, w, gl, fam, sem = e) => ({ e, g, w, gl, fam, sem, vowel: /^[aeiou]/.test(e) });
const END = {
  anthus: E('anthus', 'm', 'anthos', 'a flower', 'anthaceae', 'flower'),
  anthe: E('anthe', 'f', 'anthē', 'a flower', 'anthaceae', 'flower'),
  anthemum: E('anthemum', 'n', 'anthemon', 'a blossom', 'anthemaceae', 'flower'),
  opsis: E('opsis', 'f', 'opsis', 'likeness', 'opsidaceae'),
  phyton: E('phyton', 'n', 'phyton', 'a plant', 'phytaceae'),
  actis: E('actis', 'f', 'aktis', 'a ray', 'actinaceae', 'ray'),
  aster: E('aster', 'm', 'astēr', 'a star', 'asteraceae', 'star'),
  astrum: E('astrum', 'n', 'astron', 'a star', 'astraceae', 'star'),
  codon: E('codon', 'm', 'kōdōn', 'a bell', 'codonaceae', 'bell'),
  cyathus: E('cyathus', 'm', 'kyathos', 'a cup', 'cyathaceae', 'cup'),
  scyphus: E('scyphus', 'm', 'skyphos', 'a drinking-cup', 'scyphaceae', 'cup'),
  siphon: E('siphon', 'm', 'siphōn', 'a tube', 'siphonaceae', 'tube'),
  syrinx: E('syrinx', 'f', 'syrinx', 'a shepherd’s pipe', 'syringaceae', 'tube'),
  lychnis: E('lychnis', 'f', 'lychnis', 'a lamp-flower', 'lychnidaceae', 'lychn'),
  physa: E('physa', 'f', 'physa', 'a bladder', 'physaceae', 'bladder'),
  cheilus: E('cheilus', 'm', 'cheilos', 'a lip', 'cheilaceae', 'lip'),
  sphaera: E('sphaera', 'f', 'sphaira', 'a ball', 'sphaeraceae', 'ball'),
  helix: E('helix', 'f', 'helix', 'a spiral', 'helicaceae', 'spiral'),
  strophus: E('strophus', 'm', 'strophos', 'a twisted cord', 'strophaceae', 'spiral'),
  phyllum: E('phyllum', 'n', 'phyllon', 'a leaf', 'phyllaceae'),
  caulon: E('caulon', 'n', 'kaulos', 'a stem', 'caulaceae'),
  rhiza: E('rhiza', 'f', 'rhiza', 'a root', 'rhizaceae'),
  carpus: E('carpus', 'm', 'karpos', 'a fruit', 'carpaceae'),
  spermum: E('spermum', 'n', 'sperma', 'a seed', 'spermaceae'),
  coccus: E('coccus', 'm', 'kokkos', 'a berry', 'coccaceae'),
  stemon: E('stemon', 'm', 'stēmōn', 'a thread, that is, a stamen', 'stemonaceae'),
  thamnus: E('thamnus', 'm', 'thamnos', 'a shrub', 'thamnaceae', 'shrub'),
  stachys: E('stachys', 'f', 'stachys', 'an ear of grain', 'stachyaceae'),
  petalum: E('petalum', 'n', 'petalon', 'a petal', 'petalaceae'),
  nema: E('nema', 'n', 'nēma', 'a thread', 'nemataceae'),
  lirion: E('lirion', 'n', 'leirion', 'a lily', 'liriaceae'),
  chloa: E('chloa', 'f', 'chloē', 'a green shoot', 'chloaceae'),
  ella: { e: 'ella', g: 'f', latin: 'dim', fam: 'ellaceae', sem: 'ella', vowel: true },
  aria: { e: 'aria', g: 'f', latin: 'aria', fam: 'ariaceae', sem: 'aria', vowel: true },
  ia: { e: 'ia', g: 'f', latin: 'ia', fam: 'iaceae', sem: 'ia', vowel: true },
  ium: { e: 'ium', g: 'n', latin: 'ia', fam: 'iaceae', sem: 'ium', vowel: true },
};

// Whole Latin genera, used now and then in place of a Greek compound.
const LATIN_GENERA = {
  luminous: [['Lucernaria', 'Latin *lucerna*, a lamp'], ['Laternaria', 'Latin *laterna*, a lantern'], ['Candelaria', 'Latin *candela*, a candle']],
  glass: [['Tintinnabularia', 'Latin *tintinnabulum*, a little bell'], ['Vitraria', 'Latin *vitrum*, glass']],
  clockwork: [['Horologiella', 'Latin *horologium*, a clock'], ['Clepsydra', 'Greek *klepsydra*, a water-clock']],
  tidal: [['Aestuaria', 'Latin *aestus*, the tide'], ['Refluxia', 'Latin *refluxus*, the ebb']],
  smoke: [['Turibularia', 'Latin *turibulum*, a censer'], ['Fumifera', 'Latin *fumus*, smoke, and *ferre*, to bear']],
  crystal: [['Adamantina', 'Latin *adamas*, the hardest stone'], ['Gemmaria', 'Latin *gemma*, a jewel']],
  feathered: [['Pennella', 'Latin *penna*, a feather'], ['Plumaria', 'Latin *pluma*, a soft feather']],
  mirrored: [['Specularia', 'Latin *speculum*, a mirror'], ['Gemellaria', 'Latin *gemellus*, a twin']],
  weeping: [['Lacrimaria', 'Latin *lacrima*, a tear'], ['Lugentia', 'Latin *lugere*, to mourn']],
  nested: [['Cistella', 'Latin *cistella*, a little box'], ['Inclusaria', 'Latin *inclusus*, shut within']],
  inverted: [['Pensilia', 'Latin *pensilis*, hanging'], ['Fornicaria', 'Latin *fornix*, a vault']],
  constellation: [['Siderella', 'Latin *sidus*, a star'], ['Stellulina', 'Latin *stellula*, a little star']],
  migratory: [['Peregrinella', 'Latin *peregrinus*, a pilgrim'], ['Viatoria', 'Latin *viator*, a traveller']],
  echoing: [['Resonaria', 'Latin *resonare*, to sound again'], ['Iteraria', 'Latin *iterare*, to say again']],
};

const REAL_GENERA = new Set(['Chrysanthemum', 'Leucanthemum', 'Argyranthemum', 'Erythranthe', 'Rhodanthe', 'Cyananthus',
  'Codonanthe', 'Siphonanthus', 'Sphaeranthus', 'Chlorophyllum', 'Xanthium', 'Melanthium', 'Phyllanthus', 'Thalassia',
  'Hyalella', 'Capnia', 'Lithospermum', 'Helianthus', 'Pteris', 'Dendrobium', 'Hydrophyllum', 'Polianthes',
  'Erythrina', 'Ornithogalum', 'Astrantia', 'Haemanthus', 'Pyracantha', 'Pteranthus', 'Lithocarpus', 'Chloranthus',
  'Hydrocotyle', 'Didymocarpus', 'Xanthophyllum', 'Leucospermum', 'Chamaecyparis', 'Aerangis', 'Petrophyton', 'Crotalaria',
  'Echinopsis', 'Rhodanthemum', 'Glaucium', 'Galactia', 'Cymbalaria', 'Phialanthus', 'Selenia', 'Drosanthemum', 'Cyclanthus',
  'Streptanthus', 'Sarcocaulon', 'Ampelopsis', 'Trichocaulon', 'Lasiopetalum', 'Xiphidium', 'Limnanthemum', 'Sarcanthus',
  'Lasianthus', 'Acanthophyllum', 'Physaria', 'Aeranthus', 'Dendranthemum', 'Lithophyllum', 'Sarcococcus', 'Nyctanthus',
  'Leptosiphon', 'Dactylanthus', 'Cyclophyllum', 'Trichanthus', 'Helicia', 'Actinanthus', 'Pterophyllum', 'Hydrangea']);

// ---------------------------------------------------------------- Latin: epithets

// Epithets are given in the masculine. 'a|b|c' gives the three genders
// outright; a leading '=' marks a noun or invariable word.
const EPI_MARVEL = {
  luminous: [['noctiflorus', 'night-flowering'], ['noctilucus', 'shining by night'], ['lucens', 'shining'],
    ['phosphoreus', 'light-bearing'], ['vespertinus', 'of the evening'], ['crepuscularis', 'of the twilight'],
    ['ardens', 'glowing'], ['lampadophorus', 'torch-bearing'], ['candelarius', 'of candles'], ['nitens', 'gleaming'],
    ['luminosus', 'full of light'], ['scintillans', 'glimmering'], ['=lucifer|lucifera|luciferum', 'light-bringing']],
  glass: [['vitreus', 'glassy'], ['hyalinus', 'like glass'], ['pellucidus', 'transparent'], ['tinniens', 'ringing'],
    ['sonorus', 'resonant'], ['fragilis', 'brittle'], ['diaphanus', 'translucent'], ['vitrarius', 'of the glass-blower'],
    ['campanarius', 'of the bell-ringer'], ['tintinnans', 'chiming']],
  clockwork: [['horologicus', 'clock-like'], ['horarius', 'hourly'], ['=horologium', 'a clock'], ['chronometricus', 'time-keeping'],
    ['punctualis', 'punctual'], ['mechanicus', 'mechanical'], ['horaeus', 'keeping the hours'], ['pendulus', 'swinging'],
    ['dentatus', 'toothed'], ['rotarius', 'of wheels'], ['=automaton', 'a thing that moves of itself']],
  tidal: [['thalassicus', 'of the sea'], ['aestuarius', 'tidal'], ['lunaris', 'of the moon'], ['refluus', 'ebbing'],
    ['fluctuans', 'rising and falling'], ['oceanicus', 'of the ocean'], ['pelagicus', 'of the open sea'],
    ['aestuans', 'surging'], ['reciprocus', 'going back and forth'], ['nostalgicus', 'homesick']],
  smoke: [['fumosus', 'smoky'], ['fumans', 'smoking'], ['fumarius', 'of the chimney'], ['=capnodes', 'smoke-like'],
    ['nebulosus', 'clouded'], ['thuriferus', 'incense-bearing'], ['vaporarius', 'of vapours'], ['fuliginosus', 'sooty'],
    ['turibularius', 'of the censer'], ['cinerascens', 'turning to ash']],
  crystal: [['crystallinus', 'crystalline'], ['adamantinus', 'adamantine'], ['gemmeus', 'jewelled'], ['lapideus', 'stony'],
    ['gemmifer|gemmifera|gemmiferum', 'jewel-bearing'], ['glacialis', 'icy'], ['polyedrus', 'many-faceted'],
    ['hyalocarpus', 'with glassy fruit'], ['prismaticus', 'prism-shaped']],
  feathered: [['plumosus', 'feathery'], ['pennatus', 'feathered'], ['plumarius', 'of the plume-maker'],
    ['ptilophyllus', 'with downy leaves'], ['avicularis', 'of little birds'], ['plumiger|plumigera|plumigerum', 'plume-bearing'],
    ['columbinus', 'dove-like'], ['mollis', 'soft'], ['pterophyllus', 'feather-leaved']],
  mirrored: [['=speculum', 'a mirror'], ['didymus', 'twinned'], ['geminus', 'twin'], ['reflexus', 'turned back'],
    ['duplicatus', 'doubled'], ['gemellus', 'twin-born'], ['symmetricus', 'symmetrical'], ['speculifer|speculifera|speculiferum', 'mirror-bearing'],
    ['narcissinus', 'like Narcissus'], ['imaginarius', 'of images']],
  weeping: [['lacrimosus', 'tearful'], ['lacrimans', 'weeping'], ['plorans', 'lamenting'], ['flebilis', 'lamentable'],
    ['lugubris', 'mournful'], ['stillans', 'dripping'], ['roridus', 'dewy'], ['maestus', 'sorrowful'],
    ['=viduarum', 'of the widows'], ['consolabilis', 'able to be consoled']],
  nested: [['inclusus', 'enclosed'], ['multiplex', 'manifold'], ['iteratus', 'repeated'], ['infinitus', 'without end'],
    ['intimus', 'innermost'], ['pyxidatus', 'boxed'], ['interior|interior|interius', 'inner'], ['arcanus', 'secret'],
    ['involutus', 'rolled within']],
  inverted: [['inversus', 'upside-down'], ['pendulinus', 'hanging'], ['=cavernicola', 'cave-dwelling'], ['=pontis', 'of the bridge'],
    ['resupinatus', 'turned upside-down'], ['praeposterus', 'back to front'], ['=speluncarum', 'of the caves'],
    ['subterraneus', 'subterranean'], ['=fornicola', 'dwelling in vaults']],
  constellation: [['stellatus', 'starry'], ['stellifer|stellifera|stelliferum', 'star-bearing'], ['sidereus', 'of the stars'],
    ['astronomicus', 'astronomical'], ['caelestis', 'heavenly'], ['uranius', 'of the sky'], ['=astrologorum', 'of the astrologers'],
    ['zodiacus', 'of the zodiac'], ['punctatus', 'dotted'], ['constellatus', 'set with stars']],
  migratory: [['peregrinus', 'wandering abroad'], ['vagans', 'roaming'], ['ambulans', 'walking'], ['errans', 'straying'],
    ['migrans', 'migrating'], ['erraticus', 'wandering'], ['=viator', 'a traveller'], ['itinerans', 'journeying'],
    ['vagabundus', 'vagabond'], ['inquietus', 'restless'], ['profugus', 'fugitive']],
  echoing: [['resonans', 'resounding'], ['loquax', 'talkative'], ['garrulus', 'chattering'], ['susurrans', 'whispering'],
    ['imitans', 'imitating'], ['=echo', 'an echo'], ['repetens', 'repeating'], ['auritus', 'long-eared'],
    ['psittacinus', 'parrot-like'], ['=memoria', 'memory']],
};

const EPI_COLOUR = {
  red: [['ruber|rubra|rubrum', 'red'], ['coccineus', 'scarlet'], ['sanguineus', 'blood-red'], ['erythranthus', 'red-flowered']],
  pink: [['roseus', 'rose-coloured'], ['carneus', 'flesh-coloured'], ['rhodanthus', 'rose-flowered'], ['erubescens', 'blushing']],
  orange: [['aurantiacus', 'orange'], ['croceus', 'saffron-coloured'], ['igneus', 'fiery'], ['flammeus', 'flame-coloured']],
  yellow: [['luteus', 'yellow'], ['aureus', 'golden'], ['flavus', 'yellow'], ['chrysanthus', 'golden-flowered'], ['sulphureus', 'sulphur-coloured']],
  green: [['viridiflorus', 'green-flowered'], ['chloranthus', 'green-flowered'], ['virens', 'green'], ['prasinus', 'leek-green']],
  blue: [['caeruleus', 'sky-blue'], ['cyaneus', 'dark blue'], ['azureus', 'azure'], ['cyananthus', 'blue-flowered']],
  violet: [['violaceus', 'violet'], ['ianthinus', 'violet'], ['amethystinus', 'amethyst-coloured']],
  purple: [['purpureus', 'purple'], ['porphyreus', 'purple'], ['purpurascens', 'turning purple']],
  white: [['albus', 'white'], ['niveus', 'snowy'], ['candidus', 'shining white'], ['lacteus', 'milky'], ['eburneus', 'ivory'], ['leucanthus', 'white-flowered']],
  grey: [['cinereus', 'ash-grey'], ['argenteus', 'silvery'], ['plumbeus', 'leaden'], ['canescens', 'greyish']],
  dark: [['niger|nigra|nigrum', 'black'], ['atratus', 'clothed in black'], ['melananthus', 'black-flowered'], ['tenebrosus', 'dark']],
};

const EPI_FORM = {
  rotate: [['rotatus', 'wheel-shaped'], ['patens', 'spreading'], ['cycloides', 'circular']],
  stellate: [['stelliflorus', 'star-flowered'], ['radiatus', 'rayed'], ['actinanthus', 'ray-flowered']],
  campanulate: [['campanulatus', 'bell-shaped'], ['campaniflorus', 'bell-flowered'], ['codonanthus', 'bell-flowered']],
  tubular: [['tubiflorus', 'tube-flowered'], ['tubulosus', 'tubular'], ['fistulosus', 'pipe-like']],
  cup: [['cyathiformis', 'cup-shaped'], ['poculiformis', 'goblet-shaped'], ['crateriformis', 'bowl-shaped'], ['calathinus', 'basket-like']],
  lantern: [['urceolatus', 'pitcher-shaped'], ['inflatus', 'inflated'], ['laternifer|laternifera|laterniferum', 'lantern-bearing'], ['physanthus', 'bladder-flowered']],
  labiate: [['labiatus', 'lipped'], ['bilabiatus', 'two-lipped'], ['ringens', 'gaping'], ['personatus', 'masked']],
  globose: [['globosus', 'globe-shaped'], ['globiflorus', 'globe-flowered'], ['pilularis', 'like a little ball']],
  spiral: [['spiralis', 'spiral'], ['tortilis', 'twisted'], ['contortus', 'contorted'], ['=helicoides', 'spiral-like'], ['cochleatus', 'snail-shelled']],
};
const EPI_TIP = {
  fringed: [['fimbriatus', 'fringed'], ['laciniatus', 'slashed']], notched: [['emarginatus', 'notched'], ['retusus', 'blunt-notched']],
  filiform: [['caudatus', 'tailed'], ['filifer|filifera|filiferum', 'thread-bearing']], acute: [['acutiflorus', 'with pointed flowers']],
  rounded: [['obtusiflorus', 'with blunt petals']],
};
const EPI_LEAF = {
  linear: [['graminifolius', 'grass-leaved'], ['angustifolius', 'narrow-leaved']], ensiform: [['ensifolius', 'sword-leaved'], ['gladiatus', 'sword-bearing']],
  lanceolate: [['lancifolius', 'lance-leaved'], ['lanceolatus', 'lance-shaped']], ovate: [['ovatus', 'egg-shaped'], ['ovalifolius', 'oval-leaved']],
  cordate: [['cordifolius', 'heart-leaved'], ['cordatus', 'heart-shaped']], orbicular: [['rotundifolius', 'round-leaved'], ['orbicularis', 'circular']],
  peltate: [['peltatus', 'shield-leaved'], ['umbilicatus', 'navelled']], sagittate: [['sagittifolius', 'arrow-leaved'], ['sagittatus', 'arrow-shaped']],
  lobed: [['lobatus', 'lobed'], ['trilobus', 'three-lobed']], palmate: [['palmatus', 'hand-shaped'], ['digitatus', 'fingered']],
  pinnate: [['pinnatus', 'feather-leaved'], ['filicifolius', 'fern-leaved']], needle: [['acicularis', 'needle-like'], ['pinifolius', 'pine-leaved']],
  terete: [['teretifolius', 'with cylindrical leaves'], ['cylindricus', 'cylindrical']],
};
const EPI_MARGIN = { serrate: [['serratus', 'saw-edged']], crenate: [['crenatus', 'scalloped']], undulate: [['undulatus', 'wavy']], ciliate: [['ciliatus', 'eyelashed']] };
const EPI_HABIT = {
  vine: [['scandens', 'climbing'], ['volubilis', 'twining'], ['funambulus', 'rope-walking']],
  herb: [['erectus', 'upright'], ['gracilis', 'slender'], ['herbaceus', 'herbaceous']],
  shrublet: [['fruticosus', 'shrubby'], ['suffruticosus', 'somewhat shrubby'], ['lignosus', 'woody']],
  rosette: [['acaulis', 'stemless'], ['rosulatus', 'in rosettes'], ['humifusus', 'spread on the ground']],
  bulbous: [['bulbosus', 'bulbous'], ['tunicatus', 'coated']],
  aquatic: [['aquaticus', 'of the water'], ['palustris', 'of the marsh'], ['natans', 'floating'], ['fluitans', 'floating'], ['lacustris', 'of lakes'], ['stagnalis', 'of still waters']],
  succulent: [['carnosus', 'fleshy'], ['crassifolius', 'thick-leaved'], ['crassus', 'thick']],
  epiphyte: [['epiphyticus', 'growing upon others'], ['aerius', 'of the air'], ['=arboricola', 'tree-dwelling']],
};
const EPI_ARMATURE = {
  hairs: [['hirsutus', 'hairy'], ['villosus', 'shaggy'], ['pubescens', 'downy'], ['lanatus', 'woolly'], ['tomentosus', 'felted']],
  thorns: [['spinosus', 'spiny'], ['horridus', 'bristling'], ['aculeatus', 'prickly'], ['ferox', 'fierce'], ['armatus', 'armed']],
  tendrils: [['cirrhosus', 'tendrilled'], ['cirrhifer|cirrhifera|cirrhiferum', 'tendril-bearing']],
};
const EPI_INFL = {
  solitary: [['solitarius', 'solitary'], ['uniflorus', 'one-flowered']], raceme: [['racemosus', 'in racemes']],
  spike: [['spicatus', 'spiked']], umbel: [['umbellatus', 'in umbels']], panicle: [['paniculatus', 'panicled']], cyme: [['cymosus', 'in cymes']],
};
const EPI_FRUIT = {
  berry: [['baccatus', 'berried']], capsule: [['capsularis', 'capsuled']], pod: [['siliquosus', 'podded']],
  samara: [['pterocarpus', 'wing-fruited']], drupe: [['drupaceus', 'stone-fruited']], bladder: [['vesicarius', 'bladdered']],
  beads: [['moniliformis', 'necklace-like'], ['monilifer|monilifera|moniliferum', 'necklace-bearing']],
};
const EPI_SEASON = {
  spring: [['vernalis', 'of spring'], ['vernus', 'of spring']], summer: [['aestivalis', 'of summer'], ['solstitialis', 'of midsummer']],
  autumn: [['autumnalis', 'of autumn'], ['serotinus', 'late']], winter: [['hiemalis', 'of winter'], ['hibernus', 'wintry']],
  always: [['semperflorens', 'ever-flowering']], early: [['praecox', 'early']],
};
const EPI_MOOD = [['tristis', 'sad'], ['oblitus', 'forgotten'], ['desideratus', 'longed-for'], ['infelix', 'unlucky'],
  ['mirabilis', 'wonderful'], ['paradoxus', 'paradoxical'], ['improbabilis', 'improbable'], ['fallax', 'deceptive'],
  ['insomnis', 'sleepless'], ['patiens', 'patient'], ['pudicus', 'modest'], ['superbus', 'proud'], ['solitarius', 'solitary'],
  ['incognitus', 'unknown'], ['memorabilis', 'memorable'], ['vanus', 'empty'], ['=nusquamensis|nusquamensis|nusquamense', 'of nowhere']];
const EPI_HYBRID = [['hybridus', 'hybrid'], ['intermedius', 'intermediate'], ['mixtus', 'mixed'], ['ambiguus', 'doubtful'],
  ['nothus', 'spurious'], ['adulterinus', 'counterfeit'], ['=concordiae', 'of concord'], ['conjunctus', 'joined'], ['hortensis', 'of gardens']];

function agree(word, g) {
  if (word.startsWith('=') && !word.includes('|')) return word.slice(1);
  word = word.replace(/^=/, '');
  if (word.includes('|')) { const [m, f, n] = word.split('|'); return g === 'f' ? f : g === 'n' ? n : m; }
  if (/us$/.test(word)) return g === 'f' ? word.slice(0, -2) + 'a' : g === 'n' ? word.slice(0, -2) + 'um' : word;
  if (/is$/.test(word)) return g === 'n' ? word.slice(0, -2) + 'e' : word;
  if (/ior$/.test(word)) return g === 'n' ? word.slice(0, -3) + 'ius' : word;
  return word;
}

// ---------------------------------------------------------------- Latin: names

const FLOWER_ENDS = new Set(['anthus', 'anthe', 'anthemum', 'actis', 'aster', 'astrum', 'codon', 'cyathus', 'scyphus', 'siphon',
  'syrinx', 'lychnis', 'physa', 'cheilus', 'sphaera', 'helix', 'strophus']);
const ORGAN_ENDS = new Set(['phyllum', 'caulon', 'rhiza', 'carpus', 'spermum', 'coccus', 'stemon', 'thamnus', 'stachys', 'petalum', 'nema']);
const MARVEL_ORGANS = { crystal: ['rhiza', 'carpus', 'coccus'], clockwork: ['spermum', 'carpus'], feathered: ['phyllum'],
  mirrored: ['rhiza'], migratory: ['rhiza'], weeping: ['petalum'], glass: ['petalum'], constellation: ['petalum'],
  nested: ['petalum'], inverted: ['rhiza', 'caulon'], luminous: ['petalum'] };

// Does this ending make sense after this first element, for this plant?
function endAllowed(stem, end, g) {
  const organ = ORGAN_ENDS.has(end.e);
  switch (stem.cat) {
    case 'marvel': return !organ || (MARVEL_ORGANS[g.marvel] || []).includes(end.e);
    case 'colour': return !organ || end.e === 'petalum';
    case 'form': return !organ;
    case 'leaf': case 'glauc': return end.e === 'phyllum' || (!organ && !FLOWER_ENDS.has(end.e));
    default: return true;
  }
}

function stemFits(stem, end) {
  if (stem.sem === end.sem) return false;
  if (end.latin) return !stem.vEnd && !stem.noLat;
  return !(stem.vEnd && end.vowel);
}

function joinName(stem, end) {
  const s = stem.s;
  if (end.latin) return cap(s.endsWith('i') && end.e.startsWith('i') ? s + end.e.slice(1) : s + end.e);
  return cap(s + (end.vowel || stem.vEnd ? '' : 'o') + end.e);
}

const FORM_ENDS = {
  rotate: [['actis', 1.5], ['aster', 0.5]],
  stellate: [['aster', 1.5], ['actis', 1], ['astrum', 0.5]],
  campanulate: [['codon', 2.5], ['cyathus', 0.4]],
  tubular: [['siphon', 1.5], ['syrinx', 1]],
  cup: [['cyathus', 1.5], ['scyphus', 1], ['codon', 0.4]],
  lantern: [['lychnis', 1.5], ['physa', 1], ['codon', 1]],
  labiate: [['cheilus', 2], ['siphon', 0.5]],
  globose: [['sphaera', 1.5], ['physa', 1]],
  spiral: [['helix', 1.5], ['strophus', 1]],
};

function endingTable(g) {
  const t = [['anthus', 1.6], ['anthe', 1], ['anthemum', 0.3], ['opsis', 0.4], ['phyton', 0.3],
    ['ella', 0.5], ['aria', 0.35], ['ia', 0.35], ['ium', 0.25], ...FORM_ENDS[g.flower.form]];
  t.push(['phyllum', 0.8 + (g.marvel === 'feathered' ? 1.2 : 0) + (g.leaf.variegation !== 'none' || g.leaf.size > 0.8 ? 0.6 : 0)]);
  t.push(['caulon', 0.4 + (g.habit === 'vine' || g.habit === 'succulent' ? 0.6 : 0)]);
  t.push(['rhiza', 0.3 + (g.marvel === 'crystal' || g.marvel === 'mirrored' || g.marvel === 'migratory' ? 1.2 : 0)
    + (['bulb', 'tuber', 'aerial'].includes(g.root.form) ? 0.4 : 0)]);
  if (g.fruit.present) t.push(['carpus', 0.7 + (g.marvel === 'crystal' ? 0.8 : 0)]);
  t.push(['spermum', 0.25 + (g.marvel === 'clockwork' ? 0.8 : 0)]);
  if (g.fruit.present && ['berry', 'drupe', 'beads'].includes(g.fruit.form)) t.push(['coccus', 0.5]);
  if (g.flower.stamens !== 'hidden') t.push(['stemon', 0.8]);
  if (g.habit === 'shrublet') t.push(['thamnus', 1.4]);
  if (g.flower.inflorescence === 'spike') t.push(['stachys', 1]);
  t.push(['petalum', 0.3 + (['glass', 'constellation', 'weeping'].includes(g.marvel) ? 0.7 : 0)]);
  if (g.flower.petalTip === 'filiform') t.push(['nema', 1]);
  if (g.lineage === 'monocot') t.push(['lirion', 1.5]);
  if (g.lineage === 'monocot' && ['linear', 'ensiform'].includes(g.leaf.shape)) t.push(['chloa', 0.7]);
  return t.map(([k, w]) => [END[k], w]);
}

function firstTable(g) {
  const t = [];
  const add = (list, w, cat) => { if (list) for (const s of list) t.push([{ ...s, cat }, w / list.length]); };
  add(MARVEL_STEMS[g.marvel], 5, 'marvel');
  add(COLOUR_STEMS[colourFamily(g.colors.flower)], 1.4, 'colour');
  add(FORM_STEMS[g.flower.form], 1, 'form');
  add(LEAF_STEMS[g.leaf.shape], 0.6, 'leaf');
  add(HABIT_STEMS[g.habit], 0.8, 'habit');
  add(ARMATURE_STEMS[g.stem.armature], 0.5, 'armature');
  if (g.colors.leaf.s < 24 && g.colors.leaf.l > 46) add([R('glauc', 'glaukos', 'blue-grey')], 0.4, 'glauc');
  return t;
}

// -> { name, gender, stem, end, latinGloss? }
function makeGenus(g, r) {
  if (r.chance(0.045)) {
    const [name, gloss] = r.pick(LATIN_GENERA[g.marvel]);
    const suffix = name.match(/(aria|ella|ina|ia|a)$/)[1];
    const stemS = name.slice(0, -suffix.length).toLowerCase();
    const end = END[suffix] || { e: suffix, g: 'f', latin: 'ia', fam: suffix === 'a' ? 'aceae' : suffix + 'ceae', sem: suffix, vowel: true };
    return { name, gender: 'f', stem: { s: stemS, sem: stemS, cat: 'marvel', w: stemS, gl: '' }, end, latinGloss: gloss };
  }
  const firsts = firstTable(g), ends = endingTable(g);
  for (let tries = 0; tries < 12; tries++) {
    const stem = wpick(r, firsts);
    const okEnds = ends.filter(([e]) => stemFits(stem, e) && endAllowed(stem, e, g));
    if (!okEnds.length) continue;
    const end = wpick(r, okEnds);
    const name = joinName(stem, end);
    if (!REAL_GENERA.has(name) && !/(coco|nono|lolo|toto|roro|caca|dodo|soso|popo)/i.test(name)) return { name, gender: end.g, stem, end };
  }
  const stem = { ...MARVEL_STEMS[g.marvel][0], cat: 'marvel' };
  return { name: joinName(stem, END.anthus), gender: 'm', stem, end: END.anthus };
}

const FAMILY_END = { rotate: 'anthus', stellate: 'anthus', campanulate: 'codon', cup: 'codon', lantern: 'codon',
  globose: 'codon', tubular: 'siphon', labiate: 'siphon', spiral: 'helix' };

function familyOf(g) {
  const stem = MARVEL_STEMS[g.marvel][0];
  const end = END[g.lineage === 'monocot' ? 'lirion' : FAMILY_END[g.flower.form]];
  const base = joinName(stem, end);
  return base.slice(0, base.length - end.e.length) + end.fam;
}

const HEIGHT_EPI = { small: [['nanus', 'dwarf'], ['pumilus', 'low'], ['pygmaeus', 'pygmy'], ['minimus', 'least']],
  tall: [['giganteus', 'gigantic'], ['altissimus', 'tallest'], ['elatior|elatior|elatius', 'taller'], ['procerus', 'lofty']] };
const MEROSITY_EPI = { 4: 'tetrapetalus', 6: 'hexapetalus', 7: 'heptapetalus', 8: 'octopetalus', 9: 'enneapetalus',
  10: 'decapetalus', 11: 'hendecapetalus', 12: 'dodecapetalus' };
const MEROSITY_GLOSS = { 4: 'four', 6: 'six', 7: 'seven', 8: 'eight', 9: 'nine', 10: 'ten', 11: 'eleven', 12: 'twelve' };

// Choose an epithet. -> { raw, gloss, kind, person?, place? }
function makeEpithet(g, ctx, r, genus, { hybrid = false } = {}) {
  const cats = [];
  const add = (w, fn) => { if (w > 0) cats.push([fn, w]); };
  const bank = (list) => () => { const [raw, gloss] = r.pick(list); return { raw, gloss, kind: 'trait' }; };
  add(hybrid ? 1.6 : genus.stem && genus.stem.cat === 'marvel' ? 1.3 : 3.2, bank(EPI_MARVEL[g.marvel]));
  add(genus.stem && genus.stem.cat === 'colour' ? 0.25 : 1.3, bank(EPI_COLOUR[colourFamily(g.colors.flower)]));
  add(1, bank(EPI_FORM[g.flower.form]));
  add(['rounded', 'acute'].includes(g.flower.petalTip) ? 0.08 : 0.5, bank(EPI_TIP[g.flower.petalTip]));
  add(0.8, bank(EPI_LEAF[g.leaf.shape]));
  if (g.leaf.margin !== 'entire') add(0.25, bank(EPI_MARGIN[g.leaf.margin]));
  if (g.leaf.size < 0.35) add(0.3, bank([['microphyllus', 'small-leaved'], ['parvifolius', 'small-leaved']]));
  if (g.leaf.size > 0.85) add(0.3, bank([['macrophyllus', 'large-leaved'], ['grandifolius', 'large-leaved']]));
  if (g.leaf.variegation !== 'none') add(0.6, bank({ veined: [['reticulatus', 'netted'], ['pictus', 'painted']],
    spotted: [['maculatus', 'spotted'], ['guttatus', 'speckled']], margined: [['marginatus', 'margined'], ['limbatus', 'bordered']] }[g.leaf.variegation]));
  if (g.colors.leaf.s < 24 && g.colors.leaf.l > 46) add(0.5, bank([['glaucus', 'blue-grey'], ['glaucophyllus', 'grey-leaved']]));
  if (g.leaf.arrangement === 'whorled') add(0.4, bank([['verticillatus', 'whorled']]));
  if (g.leaf.arrangement === 'opposite') add(0.2, bank([['oppositifolius', 'with opposite leaves']]));
  add(0.7, bank(EPI_HABIT[g.habit]));
  if (EPI_ARMATURE[g.stem.armature]) add(0.6, bank(EPI_ARMATURE[g.stem.armature]));
  add(0.35, bank(EPI_INFL[g.flower.inflorescence]));
  if (g.flower.count >= 12) add(0.3, bank([['multiflorus', 'many-flowered'], ['floribundus', 'abundantly flowering']]));
  if (g.flower.nodding) add(0.5, bank([['nutans', 'nodding'], ['cernuus', 'drooping']]));
  if (g.flower.stamens === 'plume') add(0.4, bank([['penicillatus', 'pencil-tufted']]));
  if (g.flower.whorls > 1) add(0.3, bank([['pleniflorus', 'double-flowered'], ['plenus', 'full']]));
  if (g.fruit.present) add(0.3, bank(EPI_FRUIT[g.fruit.form]));
  if (g.lineage === 'dicot' && MEROSITY_EPI[g.flower.merosity]) add(0.35, () => ({ raw: MEROSITY_EPI[g.flower.merosity],
    gloss: `with ${MEROSITY_GLOSS[g.flower.merosity]} petals`, kind: 'trait' }));
  if (g.heightCm <= 12) add(0.6, bank(HEIGHT_EPI.small));
  if (g.heightCm >= 150) add(0.5, bank(HEIGHT_EPI.tall));
  if (ctx.seasonKey) add(0.45, bank(EPI_SEASON[ctx.seasonKey]));
  // compound descriptive epithets, read from the plant's measurements
  const f = g.flower;
  if (f.size > 0.75) add(0.35, bank([['grandiflorus', 'large-flowered'], ['macranthus', 'large-flowered']]));
  if (f.size < 0.3) add(0.35, bank([['parviflorus', 'small-flowered'], ['micranthus', 'small-flowered']]));
  if (g.stem.thickness > 0.8) add(0.25, bank([['crassicaulis', 'thick-stemmed'], ['pachycaulis', 'stout-stemmed']]));
  if (g.stem.thickness < 0.25) add(0.25, bank([['tenuicaulis', 'slender-stemmed'], ['gracilipes', 'slender-stalked']]));
  if ((g.colors.stem.h >= 340 || g.colors.stem.h < 20) && g.colors.stem.s >= 24) add(0.35, bank([['rubricaulis', 'red-stemmed'], ['erythrocaulis', 'red-stemmed']]));
  if (['linear', 'ensiform', 'needle'].includes(g.leaf.shape)) add(0.25, bank([['longifolius', 'long-leaved'], ['tenuifolius', 'fine-leaved']]));
  if (['orbicular', 'cordate', 'peltate'].includes(g.leaf.shape)) add(0.25, bank([['latifolius', 'broad-leaved'], ['platyphyllus', 'broad-leaved']]));
  if (g.leaf.arrangement === 'whorled') add(0.3, () => ({ raw: { 3: 'triphyllus', 4: 'tetraphyllus', 5: 'pentaphyllus' }[g.leaf.count] || 'polyphyllus', gloss: `with leaves in ${num(g.leaf.count)}s`, kind: 'trait' }));
  if (f.inflorescence === 'solitary' && f.count === 2) add(0.3, bank([['biflorus', 'two-flowered']]));
  if (f.inflorescence === 'solitary' && f.count === 3) add(0.3, bank([['triflorus', 'three-flowered']]));
  if (g.fruit.present) {
    const ff = colourFamily(g.colors.fruit);
    const fc = { red: ['erythrocarpus', 'red-fruited'], orange: ['pyrrhocarpus', 'flame-fruited'], yellow: ['chrysocarpus', 'gold-fruited'],
      blue: ['cyanocarpus', 'blue-fruited'], violet: ['ianthocarpus', 'violet-fruited'], purple: ['porphyrocarpus', 'purple-fruited'],
      white: ['leucocarpus', 'white-fruited'], grey: ['poliocarpus', 'grey-fruited'], dark: ['melanocarpus', 'black-fruited'], pink: ['rhodocarpus', 'rose-fruited'], green: ['chlorocarpus', 'green-fruited'] }[ff];
    if (fc) add(0.35, bank([fc]));
    if (g.fruit.count >= 4) add(0.2, bank([['polycarpus', 'many-fruited']]));
  }
  if (g.root.form === 'tuber') add(0.3, bank([['tuberosus', 'tuberous']]));
  if (g.root.form === 'rhizome') add(0.25, bank([['repens', 'creeping'], ['rhizomatosus', 'rhizomatous']]));
  if (g.root.form === 'taproot') add(0.2, bank([['macrorhizus', 'large-rooted']]));
  if (g.flower.stamens === 'exserted') add(0.3, bank([['exsertus', 'with protruding stamens'], ['longistamineus', 'long-stamened']]));
  if (g.stem.sinuosity > 0.35 && g.habit !== 'vine') add(0.25, bank([['flexuosus', 'zigzag'], ['tortuosus', 'twisting']]));
  if (g.leaf.droop > 0.8) add(0.25, bank([['pendulifolius', 'with hanging leaves']]));
  add(0.3, bank(EPI_MOOD));
  if (hybrid) add(1.6, bank(EPI_HYBRID));
  if (ctx.place && ctx.place.lat && !hybrid) add(1.1, () => ({ raw: ctx.place.lat.includes('-') ? '=' + ctx.place.lat : ctx.place.lat,
    gloss: null, kind: 'place', place: ctx.place }));
  add(hybrid ? 2 : 0.75, () => {
    let person = ctx.collector;
    if (hybrid || r.chance(0.3)) {
      const others = COLLECTORS.filter(c => c !== ctx.collector && c.active[0] <= ctx.year + 5);
      if (others.length) person = r.pick(others);
    }
    if (person.brother && r.chance(0.25)) return { raw: '=moerkiorum', gloss: null, kind: 'brothers', person };
    return { raw: '=' + person.ep, gloss: null, kind: 'person', person };
  });
  for (let tries = 0; tries < 8; tries++) {
    const ep = wpick(r, cats)();
    const word = agree(ep.raw, genus.gender);
    if (word.toLowerCase() !== genus.name.toLowerCase()) return { ...ep, word };
  }
  return { raw: 'mirabilis', gloss: 'wonderful', kind: 'trait', word: agree('mirabilis', genus.gender) };
}

// Author citation, by the rules of the period. -> { author, syn? }
function makeAuthor(g, ctx, r, genus, ep, { noSyn = false } = {}) {
  const c = ctx.collector, year = ctx.year;
  const honour = ep.person && (ep.kind === 'brothers' ? [COLL.emoerk, COLL.smoerk] : [ep.person]);
  const ok = (x) => !(honour && honour.includes(x));
  const others = COLLECTORS.filter(x => x !== c && ok(x) && x.active[1] >= year && x.active[0] <= year + 25);
  const o = others.length ? r.pick(others) : null;
  const o2 = others.length > 1 ? r.pick(others.filter(x => x !== o)) : null;
  if (c.brother && !honour && r.chance(0.12)) return { author: 'E.Mœrk & S.Mœrk', joint: true };
  const synonym = (author) => {
    const alt = makeGenus({ ...g, marvel: g.marvel }, r.fork('syn'));
    if (alt.name === genus.name) return null;
    return `${alt.name} ${agree(ep.raw, alt.gender)} ${author}`;
  };
  const opts = [];
  if (ok(c)) {
    opts.push([() => ({ author: c.abbr }), 5]);
    if (o) opts.push([() => ({ author: `${c.abbr} ex ${o.abbr}` }), 1.3]);
    if (o && !noSyn) opts.push([() => ({ author: `(${c.abbr}) ${o.abbr}`, syn: synonym(c.abbr), synBy: c }), 1.2]);
    if (o) opts.push([() => ({ author: `${c.abbr} & ${o.abbr}` }), 1]);
    if (o) opts.push([() => ({ author: o.abbr, describer: o }), 0.8]);
  } else {
    const d = o || COLLECTORS.find(x => ok(x) && x.active[1] >= year) || COLL.quill;
    opts.push([() => ({ author: d.abbr, describer: d }), 5]);
    if (o && o2 && !noSyn) opts.push([() => ({ author: `(${o.abbr}) ${o2.abbr}`, syn: synonym(o.abbr), synBy: o, describer: o }), 1]);
    if (o && o2) opts.push([() => ({ author: `${o.abbr} & ${o2.abbr}`, describer: o }), 0.8]);
  }
  const out = wpick(r, opts)();
  if (out.syn === null) delete out.syn;
  return out;
}

// Latin name in prose, with italics marked.
function italicName(latin) {
  if (latin.full.startsWith('× ')) return `× *${latin.full.slice(2)}*`;
  if (latin.full.includes(' × ')) return latin.full.split(' × ').map(p => `*${p}*`).join(' × ');
  return `*${latin.full}*`;
}
const genusItalic = (latin) => `*${latin.genus}*`;
const wrapHybrid = (latin) => latin.full.includes('×') ? `(${italicName(latin)})` : italicName(latin);

// ---------------------------------------------------------------- folk names

const FOLK = {
  luminous: { nouns: ['Lamp', 'Lantern', 'Candle', 'Glow', 'Lamplight', 'Rushlight', 'Taper', 'Glimmer', 'Night-light', 'Wick'],
    roots: ['Lamp', 'Night', 'Glow', 'Candle', 'Moon', 'Wick'], adj: ['Night', 'Shining', 'Burning', 'Midnight'],
    who: ['Lamplighter', 'Watchman', 'Lighthouse-Keeper', 'Night-Nurse'],
    phrase: ['Light-me-Home', 'Burn-till-Morning', 'Lamp-in-the-Window', 'Leave-a-Light'] },
  glass: { nouns: ['Glass', 'Chime', 'Goblet', 'Bell', 'Bead', 'Tumbler', 'Windowpane', 'Decanter'],
    roots: ['Glass', 'Chime', 'Ring', 'Tinkle'], adj: ['Glass', 'Ringing', 'Brittle', 'Chiming'],
    who: ['Glazier', 'Glass-Blower', 'Bell-Ringer', 'Butler'],
    phrase: ['Ring-for-the-Parson', 'Touch-and-Chime', 'Mind-the-Glass', 'Handle-with-Care'] },
  clockwork: { nouns: ['Clock', 'Hours', 'Dial', 'Pendulum', 'Watch', 'Minute', 'Clockbell', 'Escapement', 'Sundial'],
    roots: ['Clock', 'Hour', 'Noon', 'Tick', 'Dial'], adj: ['Hourly', 'Punctual', 'Ticking', 'Noonday'],
    who: ['Clockmaker', 'Watchmaker', 'Sexton', 'Stationmaster', 'Schoolmaster'],
    phrase: ['Go-to-Bed-at-Noon', 'Tell-the-Time', 'Strike-the-Hour', 'Never-Late'] },
  tidal: { nouns: ['Tide', 'Ebb', 'Flood', 'Moon', 'Low-Water', 'Spring-Tide', 'Neap'],
    roots: ['Tide', 'Ebb', 'Moon', 'Sea', 'Neap'], adj: ['Sea', 'Ebbing', 'Inland', 'Homesick'],
    who: ['Fisherman', 'Sailor', 'Pilot', 'Mermaid', 'Harbour-Master', 'Fishwife'],
    phrase: ['Wait-for-the-Tide', 'Homesick-for-the-Sea', 'Turn-of-the-Tide', 'Sea-in-the-Field'] },
  smoke: { nouns: ['Smoke', 'Pipe', 'Censer', 'Chimney', 'Fume', 'Incense', 'Kiln', 'Bonfire'],
    roots: ['Smoke', 'Fume', 'Reek', 'Ash', 'Soot'], adj: ['Smoking', 'Smoky', 'Smouldering', 'Blue'],
    who: ['Collier', 'Chimney-Sweep', 'Charcoal-Burner', 'Old Man', 'Bishop'],
    phrase: ['Smoke-in-the-Hedge', 'Pipe-and-Slippers', 'Fire-Without-Flame', 'Where-There’s-Smoke'] },
  crystal: { nouns: ['Crystal', 'Quartz', 'Jewel', 'Diamond', 'Ice', 'Salt', 'Frost', 'Gem', 'Icicle'],
    roots: ['Frost', 'Ice', 'Salt', 'Quartz', 'Jewel'], adj: ['Crystal', 'Frosted', 'Jewelled', 'Glittering'],
    who: ['Jeweller', 'Lapidary', 'Miner', 'Snow-Queen', 'Pawnbroker'],
    phrase: ['Diamonds-Underground', 'Dig-me-for-Jewels', 'Poor-Man’s-Treasure'] },
  feathered: { nouns: ['Feather', 'Quill', 'Plume', 'Down', 'Wing', 'Pinion', 'Owl-feather'],
    roots: ['Feather', 'Plume', 'Quill', 'Down'], adj: ['Feathered', 'Downy', 'Plumed', 'Fledgling'],
    who: ['Fowler', 'Goose-Girl', 'Pillow-Maker', 'Wren', 'Owl', 'Angel'],
    phrase: ['Stroke-me-Gently', 'Fly-Away-Never', 'Bird-in-the-Hand'] },
  mirrored: { nouns: ['Mirror', 'Twin', 'Looking-Glass', 'Shadow', 'Double', 'Reflection'],
    roots: ['Twin', 'Mirror', 'Under'], adj: ['Twin', 'Double', 'Mirrored', 'Second'],
    who: ['Twin', 'Narcissus', 'Mole', 'Sister', 'Sexton'],
    phrase: ['Same-Below', 'As-Above-So-Below', 'Two-Faced-Jenny', 'Look-Both-Ways'] },
  weeping: { nouns: ['Tears', 'Widow', 'Mourner', 'Sorrow', 'Dew', 'Weeper', 'Lament'],
    roots: ['Tear', 'Weep', 'Dew', 'Rue', 'Sorrow'], adj: ['Weeping', 'Mourning', 'Tearful', 'Grieving'],
    who: ['Widow', 'Mourner', 'Orphan', 'Bride', 'Drowned Man', 'Mother'],
    phrase: ['Weep-till-Morning', 'Cry-for-Nothing', 'Tears-of-Saint-Ebba', 'Forget-me-Soon'] },
  nested: { nouns: ['Nest', 'Box', 'Cradle', 'Egg', 'Casket', 'Riddle', 'Heart'],
    roots: ['Nest', 'Box', 'Hidden', 'Heart'], adj: ['Hidden', 'Inner', 'Nesting', 'Secret'],
    who: ['Box-Maker', 'Midwife', 'Grandmother', 'Pedlar', 'Conjuror'],
    phrase: ['Heart-in-Heart', 'Box-in-a-Box', 'Mother-of-Thousands', 'Again-and-Again'] },
  inverted: { nouns: ['Bat', 'Ceiling', 'Stalactite', 'Hanger', 'Chandelier', 'Belfry'],
    roots: ['Bat', 'Cave', 'Arch', 'Vault'], adj: ['Hanging', 'Upside-down', 'Topsy-turvy', 'Cave'],
    who: ['Bat', 'Troll', 'Bridge-Keeper', 'Miner', 'Hermit', 'Acrobat'],
    phrase: ['Topsy-Turvy', 'Hang-me-Down', 'Head-over-Heels', 'Wrong-Way-Up'] },
  constellation: { nouns: ['Star', 'Stars', 'Plough', 'Compass', 'Comet', 'Almanac', 'Chart', 'Heaven'],
    roots: ['Star', 'Sky', 'Comet'], adj: ['Starry', 'Spotted', 'Heavenly', 'Star'],
    who: ['Astronomer', 'Astrologer', 'Shepherd', 'Navigator', 'Magus'],
    phrase: ['Heaven-on-Earth', 'Stars-in-the-Grass', 'Map-of-Heaven', 'Look-Up'] },
  migratory: { nouns: ['Wanderer', 'Pilgrim', 'Tramp', 'Traveller', 'Vagrant', 'Journeyman', 'Walker'],
    roots: ['Walk', 'Wander', 'Tramp', 'Stray'], adj: ['Wandering', 'Walking', 'Restless', 'Strolling'],
    who: ['Pilgrim', 'Pedlar', 'Tinker', 'Drover', 'Postman'],
    phrase: ['Never-at-Home', 'Here-Today', 'Gone-by-Michaelmas', 'Follow-the-Sun'] },
  echoing: { nouns: ['Echo', 'Gossip', 'Parrot', 'Whisper', 'Mimic', 'Tell-tale', 'Mocker', 'Chatterbox'],
    roots: ['Echo', 'Gossip', 'Mock', 'Hush'], adj: ['Talking', 'Whispering', 'Gossiping', 'Mocking'],
    who: ['Gossip', 'Parrot', 'Parson', 'Schoolmaster', 'Magpie'],
    phrase: ['Say-it-Again', 'Mind-your-Tongue', 'Tell-no-One', 'Hush-in-the-Hedge'] },
};

const FORM_NOUNS = {
  rotate: ['Wheel', 'Button', 'Saucer', 'Penny'], stellate: ['Star', 'Spur', 'Spark', 'Rowel'],
  campanulate: ['Bell', 'Bonnet', 'Thimble', 'Bells'], tubular: ['Trumpet', 'Pipe', 'Whistle', 'Flute'],
  cup: ['Cup', 'Goblet', 'Chalice', 'Bowl'], lantern: ['Lantern', 'Purse', 'Bladder', 'Lamp'],
  labiate: ['Lip', 'Mouth', 'Hood', 'Slipper'], globose: ['Ball', 'Button', 'Pearl', 'Bead'],
  spiral: ['Screw', 'Spindle', 'Corkscrew', 'Curl'],
};

const FOLK_WHO = ['Ferryman', 'Clockmaker', 'Widow', 'Shepherd', 'Miller', 'Sexton', 'Bishop', 'Abbess', 'Hangman',
  'Midwife', 'Soldier', 'Sailor', 'Tinker', 'Lacemaker', 'Ropemaker', 'Cobbler', 'Beggar', 'Bride', 'Old Woman',
  'Grandmother', 'Parson', 'Fiddler', 'Hermit', 'Saint Ebba', 'Saint Corrin', 'Saint Ilse', 'Saint Amabel',
  'Saint Orrin', 'Saint Wenna', 'Devil', 'Lady', 'King', 'Fox', 'Hare', 'Toad', 'Owl', 'Wren', 'Crow', 'Badger',
  'Adder', 'Cuckoo', 'Moth', 'Weaver', 'Postmistress', 'Ploughman', 'Drummer'];
const FOLK_ADJ = ['Lesser', 'Greater', 'Common', 'Little', 'Grey', 'Pale', 'Bitter', 'Sweet', 'False', 'Mock', 'Winter',
  'Old', 'Sleeping', 'Blind', 'Lonely', 'Lady’s', 'Sorry', 'Silly', 'Proud', 'Poor Man’s'];
const FOLK_A = ['Moth', 'Owl', 'Hare', 'Toad', 'Wren', 'Crow', 'Eel', 'Bat', 'Snail', 'Moon', 'Frost', 'Rain', 'Mist',
  'Dusk', 'Candle', 'Pewter', 'Ash', 'Church', 'Ferry', 'Mill', 'Well', 'Fairy', 'Ghost', 'Drowned', 'Hollow', 'Lady',
  'Cuckoo', 'Larks', 'Midnight', 'Thunder'];
const FOLK_B = ['Rosary', 'Whistle', 'Ladder', 'Purse', 'Spindle', 'Ring', 'Spoon', 'Comb', 'Needle', 'Cradle', 'Key',
  'Bonnet', 'Slipper', 'Button', 'Thimble', 'Lace', 'Lantern', 'Bell', 'Candles', 'Tears', 'Buttons', 'Ribbons',
  'Gloves', 'Fingers', 'Spectacles', 'Shoes'];
const FOLK_PHRASE = ['Kiss-me-at-the-Ferry', 'Look-Behind-You', 'Lady-Come-Home', 'Jack-by-the-Gate', 'Sleep-Sound',
  'Love-Lies-Waiting', 'Leave-me-Be', 'Nobody’s-Darling', 'Come-Back-Sunday', 'Meet-me-by-the-Mill', 'Mind-the-Step',
  'Wait-for-Me', 'Jenny-Stay-Home', 'Parson-in-the-Rain', 'Old-Man’s-Beard-in-Mourning', 'Fetch-the-Doctor', 'Hide-and-Seek',
  'Shut-the-Gate', 'Gone-to-Market', 'Granny-Won’t-Tell', 'Speak-Well-of-the-Dead', 'Pennies-for-the-Ferryman'];
const COLOUR_ADJ = { red: ['Red', 'Scarlet', 'Bloody'], pink: ['Rose', 'Pink', 'Blushing'], orange: ['Orange', 'Tawny', 'Fox'],
  yellow: ['Yellow', 'Golden', 'Butter'], green: ['Green', 'Frog'], blue: ['Blue', 'Sky'], violet: ['Violet', 'Blue'],
  purple: ['Purple', 'Bishop’s'], white: ['White', 'Milk', 'Snow'], grey: ['Grey', 'Silver', 'Ash'], dark: ['Black', 'Dark', 'Coal'] };

function suffixes(g) {
  const t = [['wort', 3], ['weed', 1.2], ['bane', 1], ['flower', 0.8]];
  if (['campanulate', 'lantern'].includes(g.flower.form)) t.push(['bell', 2.5]);
  if (g.flower.form === 'cup') t.push(['cup', 2]);
  if (g.leaf.shape === 'pinnate' || g.flower.petalTip === 'fringed' || g.marvel === 'feathered') t.push(['lace', 1.5]);
  if (g.stem.armature === 'thorns') t.push(['thorn', 2]);
  if (['tuber', 'taproot'].includes(g.root.form) || g.marvel === 'crystal') t.push(['root', 1.2]);
  if (g.lineage === 'monocot' && ['linear', 'ensiform'].includes(g.leaf.shape)) t.push(['grass', 1.5]);
  if (g.habit === 'aquatic') t.push(['cress', 1.2], g.lineage === 'monocot' ? ['rush', 1.5] : ['weed', 0.5]);
  if (g.habit === 'bulbous' || g.lineage === 'monocot') t.push(['lily', 1.5]);
  if (g.fruit.present && g.fruit.form === 'berry') t.push(['berry', 1.5]);
  if (g.habit === 'vine') t.push(['bine', 1.2], ['vine', 1]);
  if (g.habit === 'shrublet') t.push(['bush', 0.8]);
  if (g.habit === 'rosette' || g.habit === 'succulent') t.push(['leek', 0.5], ['wort', 1]);
  return t;
}

function folkNames(g, ctx, r) {
  const F = FOLK[g.marvel];
  const fam = colourFamily(g.colors.flower);
  const noun = () => r.chance(0.55) ? r.pick(F.nouns) : r.pick(FORM_NOUNS[g.flower.form]);
  const compound = () => r.pick(r.chance(0.6) ? F.roots : FORM_NOUNS[g.flower.form].map(s => s.replace(/s$/, ''))) + wpick(r, suffixes(g));
  const traitAdj = () => {
    const t = [[r.pick(FOLK_ADJ), 2], [r.pick(F.adj), 2], [r.pick(COLOUR_ADJ[fam]), 1.5]];
    if (g.habit === 'aquatic') t.push(['Marsh', 1], ['Water', 1]);
    if (g.habit === 'vine') t.push(['Climbing', 1]);
    if (g.stem.armature === 'thorns') t.push(['Prickly', 0.8]);
    if (g.stem.armature === 'hairs') t.push(['Hairy', 0.8]);
    if (g.heightCm > 120) t.push(['Giant', 0.8], ['Tall', 0.6]);
    if (g.heightCm < 15) t.push(['Dwarf', 0.8], ['Least', 0.5]);
    if (g.flower.nodding) t.push(['Nodding', 0.6]);
    if (ctx.place && /mountain|hills/.test(ctx.place.tags || '')) t.push(['Mountain', 0.8], ['Fell', 0.5]);
    if (ctx.place && /salt/.test(ctx.place.tags || '')) t.push(['Salt', 1]);
    return wpick(r, t);
  };
  const who = () => r.chance(0.45) ? r.pick(F.who) : r.pick(FOLK_WHO);
  const poss = (w) => w + '’s';
  const patterns = [
    [() => `${traitAdj()} ${r.pick(FORM_NOUNS[g.flower.form])}`, 1.5],
    [() => `${r.chance(0.5) ? r.pick(FOLK_ADJ) : r.pick(COLOUR_ADJ[fam])} ${r.pick(F.nouns)}`, 1.8],
    [() => `${poss(who())} ${r.chance(0.4) ? compound() : noun()}`, 3],
    [() => compound(), 2.5],
    [() => `${r.pick(FOLK_A)}-${r.chance(0.5) ? r.pick(FOLK_B) : r.pick(FORM_NOUNS[g.flower.form])}`, 1.5],
    [() => r.chance(0.6) ? r.pick(F.phrase) : r.pick(FOLK_PHRASE), 0.9],
    [() => ctx.place && ctx.place.short ? `${ctx.place.short} ${r.chance(0.5) ? noun() : compound()}` : compound(), 1.2],
    [() => `${traitAdj()} ${compound()}`, 1],
  ];
  if (ctx.hybrid) patterns.push([() => `${poss(ctx.collector.name.split(' ').pop())} ${r.pick(['Folly', 'Fancy', 'Pride', 'Wonder', 'Triumph',
    'Despair', 'Bargain', 'Mistake', 'Consolation', 'Patience', 'Afterthought', 'Secret', 'Experiment', 'Favourite', 'Last Word'])}`, 0.9]);
  const n = wpick(r, [[1, 2], [2, 4], [3, 3]]);
  const out = [];
  for (let tries = 0; out.length < n && tries < 20; tries++) {
    const name = titleCase(wpick(r, patterns)()).replace(/’S\b/g, '’s');
    if (/(bell|cup|thorn|root|lily|berry|vine|grass|wort|weed|bane|lace|flower)(bell|cup|thorn|root|lily|berry|vine|bine|grass|wort|weed|bane|lace|flower)$/i.test(name)) continue;
    const last = name.split(/[ -]/).pop().toLowerCase();
    const firstW = name.split(/[ -]/)[0].toLowerCase();
    if (out.some(o => o === name || o.split(/[ -]/).pop().toLowerCase() === last || o.split(/[ -]/)[0].toLowerCase() === firstW)) continue;
    if (/(\b\w+\b).*\b\1\b/i.test(name)) continue;
    out.push(name);
  }
  return out;
}

// ---------------------------------------------------------------- description

function fmtNum(x) { return x < 10 ? String(Math.round(x * 2) / 2) : String(Math.round(x)); }
function fmtRange(lo, hi) {
  if (hi < 1) { const a = Math.max(1, Math.round(lo * 10)), b = Math.max(a + 1, Math.round(hi * 10)); return `${a}–${b} mm`; }
  if (hi >= 100) {
    const a = Math.round(lo / 10) / 10, b = Math.round(hi / 10) / 10;
    return a === b || a < 0.3 ? `to ${b} m` : `${a}–${b} m`;
  }
  const a = fmtNum(lo), b = fmtNum(hi);
  return a === b ? `${b} cm` : `${a}–${b} cm`;
}
const heightTo = (cm) => cm >= 100 ? `${Math.round(cm / 10) / 10} m` : `${cm} cm`;

const ROOT_PHRASE = {
  taproot: ['from a stout taproot', 'from a long fusiform taproot', 'from a thick, carrot-like taproot'],
  fibrous: ['with fibrous roots', 'from a tuft of fibrous roots', 'with wiry fibrous roots'],
  tuber: ['from a rounded tuber', 'from a knobbed tuber', 'from a tuber the size of a walnut'],
  rhizome: ['from a creeping rhizome', 'from a slender, scaly rhizome', 'from a stout rhizome marked with old leaf-scars'],
  bulb: ['from a tunicate bulb', 'from an ovoid bulb with papery tunics', 'from a bulb the size of a hazel-nut'],
  corm: ['from a depressed corm with fibrous tunics', 'from a small corm'],
  aerial: ['clinging by silvery aerial roots', 'attached by aerial roots, some hanging free'],
};
const ROOT_NOUN = { taproot: 'taproot', fibrous: 'tuft of roots', tuber: 'tuber', rhizome: 'rhizome', bulb: 'bulb', corm: 'corm', aerial: 'mass of aerial roots' };

const HABIT_NOUN = {
  herb: ['herb'], vine: ['climber', 'twining climber', 'scandent herb'], shrublet: ['subshrub', 'low shrub', 'dwarf shrub'],
  rosette: ['rosette-forming herb', 'acaulescent herb'], bulbous: ['bulbous herb', 'bulbous perennial'],
  aquatic: ['aquatic herb', 'water-plant'], succulent: ['succulent herb', 'succulent perennial'], epiphyte: ['epiphytic herb', 'epiphyte'],
};
const DURATION = { herb: ['perennial', 'perennial', 'annual', 'biennial'], vine: ['perennial', 'annual'], shrublet: ['evergreen', 'deciduous'],
  rosette: ['perennial', 'monocarpic'], bulbous: [''], aquatic: ['perennial'], succulent: [''], epiphyte: ['perennial'] };

function habitSentence(g, ctx, r) {
  const h = g.heightCm;
  let noun = r.pick(HABIT_NOUN[g.habit]);
  const dur = r.pick(DURATION[g.habit]);
  if (dur && !noun.includes('perennial')) noun = `${dur} ${noun}`;
  let height;
  if (g.marvel === 'inverted') height = `hanging to ${heightTo(h)}`;
  else if (g.habit === 'vine') height = noun.includes('climb') ? `to ${heightTo(h)}` : `climbing to ${heightTo(h)}`;
  else if (g.habit === 'aquatic') height = `the flowering stems rising to ${heightTo(h)} above the water`;
  else if (g.habit === 'rosette' || g.habit === 'bulbous') height = r.chance(0.5) ? `scapes to ${heightTo(h)}` : `${fmtRange(h * 0.6, h)} tall in flower`;
  else height = r.chance(0.6) ? `to ${heightTo(h)}` : fmtRange(Math.round(h * 0.6), h);
  let root;
  if (g.marvel === 'mirrored') root = r.pick(['without roots', 'rootless', 'wanting roots altogether']);
  else root = r.pick(ROOT_PHRASE[g.root.form]);
  const lead = g.marvel === 'inverted' ? `${cap(noun)}, growing downward from its point of attachment, ${height}`
    : /^(to |climbing|\d)/.test(height) ? `${cap(noun)} ${height}` : `${cap(noun)}, ${height}`;
  return `${lead}, ${root}.`;
}

function stemSentence(g, ctx, r) {
  const s = g.stem, bits = [];
  const thick = s.thickness > 0.75 ? r.pick(['stout', 'thick']) : s.thickness < 0.3 ? r.pick(['slender', 'wiry', 'thread-like']) : '';
  const branch = s.branching < 0.2 ? 'simple' : s.branching < 0.55 ? 'sparingly branched' : 'much branched';
  const lean = Math.abs(s.lean) > 0.55 ? r.pick(['arching', 'ascending', 'decumbent at the base']) : 'erect';
  const red = (g.colors.stem.h >= 340 || g.colors.stem.h < 20) && g.colors.stem.s >= 24;
  const arm = { none: r.pick(['glabrous', 'smooth', 'glabrous']), hairs: r.pick(['softly pubescent', 'hirsute', 'glandular-hairy', 'villous']),
    thorns: r.pick(['armed with recurved prickles', 'set with straight spines at the nodes', 'thorny']),
    tendrils: g.habit === 'vine' ? r.pick(['climbing by branched tendrils', 'with coiling tendrils opposite the leaves'])
      : r.pick(['bearing a few coiling tendrils at the upper nodes', 'with short tendrils, which take hold of whatever is near']) }[s.armature];
  let head;
  switch (g.habit) {
    case 'vine': head = 'Stems'; bits.push('twining', thick || 'wiry', branch); break;
    case 'rosette': case 'bulbous': head = r.pick(['Scape', 'Scapes one or few', 'Flowering scape']);
      bits.push(g.marvel === 'inverted' ? 'pendent' : r.pick(['erect', 'erect', 'ascending']), r.pick(['leafless', 'naked', 'leafless', 'with a single bract']), thick, r.chance(0.4) ? 'terete' : ''); break;
    case 'aquatic': head = 'Stems'; bits.push('submerged, rooting at the nodes', 'the flowering shoots emergent'); break;
    case 'succulent': head = 'Stems'; bits.push('fleshy', r.pick(['terete', 'jointed', 'swollen at the nodes']), branch); break;
    case 'epiphyte': head = 'Stems'; bits.push('short', r.pick(['pendulous', 'ascending', 'creeping on the host']), thick); break;
    case 'shrublet': head = 'Stems'; bits.push('woody below', r.pick(['the bark grey and flaking', 'the bark reddish', 'the old wood gnarled']), branch); break;
    default: head = 'Stems'; bits.push(g.marvel === 'inverted' ? 'pendent' : lean, thick, branch);
  }
  if (s.sinuosity > 0.32 && g.habit !== 'vine') bits.push(r.pick(['flexuous', 'zigzag']));
  bits.push(arm);
  if (red) bits.push(r.pick(['flushed red', 'wine-red', 'purplish']));
  return `${head}${/\s/.test(head) ? ',' : ''} ${bits.filter(Boolean).join(', ')}.`;
}

const LEAF_SHAPE = {
  linear: ['linear', 'narrowly linear', 'linear, grass-like'], ensiform: ['ensiform', 'sword-shaped, equitant'],
  lanceolate: ['lanceolate', 'narrowly lanceolate', 'oblong-lanceolate'], ovate: ['ovate', 'broadly ovate', 'ovate-acuminate'],
  cordate: ['cordate', 'ovate-cordate', 'broadly cordate'], orbicular: ['orbicular', 'nearly round'],
  peltate: ['peltate, orbicular, the petiole inserted near the centre', 'peltate, shield-like'],
  sagittate: ['sagittate', 'hastate-sagittate', 'arrow-shaped'], lobed: ['3-lobed', 'deeply 3–5-lobed', 'pinnately lobed'],
  palmate: ['palmately 5–7-lobed', 'palmatisect', 'digitate'], pinnate: ['pinnate, with {n} pairs of leaflets', 'imparipinnate, the leaflets {n} pairs'],
  needle: ['acicular', 'needle-like'], terete: ['terete, cylindrical', 'subterete'],
};
const MARGIN = { entire: ['entire', ''], serrate: ['serrate', 'finely serrate', 'sharply serrate'], crenate: ['crenate', 'bluntly crenate'],
  undulate: ['undulate', 'wavy-margined'], ciliate: ['ciliate', 'fringed with fine hairs'] };
const VEINS = { pinnate: ['pinnately veined', 'the midrib prominent', ''], palmate: ['palmately veined', 'the veins radiating from the base'],
  parallel: ['parallel-veined', 'the nerves parallel'] };

function leafSentence(g, ctx, r) {
  const L = g.leaf, bits = [];
  let head;
  if (L.arrangement === 'basal') head = g.habit === 'aquatic' ? 'Leaves basal, long-petioled, floating' : `Leaves all basal, ${Math.max(3, L.count - 2)}–${L.count + 2} in a rosette`;
  else if (L.arrangement === 'whorled') head = `Leaves in whorls of ${num(L.count)}`;
  else head = `Leaves ${L.arrangement}`;
  bits.push(T(r, r.pick(LEAF_SHAPE[L.shape]), { n: r.int(3, 7) }));
  const base = (['linear', 'ensiform', 'needle'].includes(L.shape) ? 1.8 : 1) * (L.arrangement === 'basal' ? 1.8 : 1);
  const len = Math.min(30, L.size * (2 + Math.min(g.heightCm, 200) * 0.08) * base);
  bits.push(fmtRange(len * 0.65, len));
  if (!['needle', 'terete'].includes(L.shape)) bits.push(r.pick(MARGIN[L.margin]));
  if (L.fleshy) bits.push(r.pick(['fleshy', 'thick and succulent']));
  if (!['needle', 'terete'].includes(L.shape) && r.chance(0.6)) bits.push(r.pick(VEINS[L.venation]));
  if (L.droop > 0.75) bits.push(r.pick(['drooping', 'pendent at the tips']));
  else if (L.droop < 0.12) bits.push('stiffly ascending');
  bits.push(ctx.cLeaf);
  if (L.variegation === 'veined') bits.push(`the veins picked out in ${r.pick(['silver', 'cream', 'white', 'rose'])}`);
  else if (L.variegation === 'spotted') bits.push(`spotted with ${r.pick(['silver', 'maroon', 'cream', 'dark purple'])}`);
  else if (L.variegation === 'margined') bits.push(`with a narrow ${r.pick(['cream', 'white', 'yellow', 'pink'])} margin`);
  else if (r.chance(0.4)) bits.push(r.pick(['paler beneath', 'glaucous beneath', 'shining above', 'dull above, paler beneath']));
  return `${head}, ${bits.filter(Boolean).join(', ')}.`;
}

const FORM_PHRASE = {
  rotate: ['rotate, the lobes spreading flat', 'wheel-shaped', 'rotate'],
  stellate: ['stellate, the segments narrow and widely spreading', 'star-shaped', 'stellate'],
  campanulate: ['campanulate', 'broadly campanulate', 'bell-shaped'],
  tubular: ['tubular, slightly widened at the mouth', 'narrowly tubular', 'tubular-funnelform'],
  cup: ['cup-shaped', 'cyathiform, the lobes erect', 'shallowly cup-shaped'],
  lantern: ['urceolate, inflated and contracted at the mouth like a lantern', 'inflated, lantern-shaped'],
  labiate: ['two-lipped, the upper lip hooded, the lower spreading', 'bilabiate, gaping'],
  globose: ['globose, the {petals} incurved and overlapping', 'nearly spherical, closed at the mouth'],
  spiral: ['spirally twisted, like the thread of a screw', 'contorted, the lobes twisted in a spiral'],
};
const TIP = { rounded: ['rounded', 'obtuse'], acute: ['acute', 'acuminate'], fringed: ['fringed', 'fimbriate', 'finely fringed at the tips'],
  notched: ['notched', 'emarginate', 'notched at the apex'], filiform: ['drawn out into long threads', 'each ending in a thread-like tail'] };

function flowerSentences(g, ctx, r) {
  const f = g.flower, out = [];
  const c = f.count, lo = Math.max(2, c - r.int(1, 3)), hi = c + r.int(1, 3);
  let infl;
  switch (f.inflorescence) {
    case 'solitary': infl = g.leaf.arrangement === 'basal' ? (c === 1 ? r.pick(['Flower solitary, terminal on the scape', 'Flower solitary, held well above the leaves'])
      : r.pick([`Flowers solitary, ${num(c)} scapes to a plant`, 'Flowers solitary on separate scapes', `Flowers ${num(c)}, each on its own scape`]))
      : c === 1 ? r.pick(['Flower solitary, terminal', 'Flower solitary, on a long peduncle', 'Flower solitary, held well above the leaves'])
      : r.pick(['Flowers solitary in the upper leaf-axils', 'Flowers solitary, terminal on the branches', `Flowers ${num(c)}, solitary, on long pedicels`,
        'Flowers single in the axils of the upper leaves', `Flowers solitary, ${num(c)} to a stem`]); break;
    case 'raceme': infl = `Inflorescence ${an(r.pick(['lax', 'dense', 'one-sided', 'simple']))} raceme of ${lo}–${hi} flowers`; break;
    case 'spike': infl = `Inflorescence ${an(r.pick(['dense', 'interrupted', 'slender']))} spike of ${c >= 15 ? 'many' : `${lo}–${hi}`} flowers`; break;
    case 'umbel': infl = `Flowers ${lo}–${hi} in ${an(r.pick(['simple', 'lax', 'nodding', 'flat-topped']))} umbel`; break;
    case 'panicle': infl = `Inflorescence ${an(r.pick(['loose', 'diffuse', 'pyramidal']))} panicle${c >= 15 ? ', many-flowered' : ''}`; break;
    default: infl = `Flowers ${lo}–${hi} in ${r.pick(['a lax', 'a forked', 'a few-flowered', 'a terminal'])} cyme`;
  }
  if (f.nodding) infl += f.inflorescence === 'solitary' && c === 1 ? r.pick(['; the flower nodding', ', nodding on a slender pedicel'])
    : r.pick(['; flowers nodding', ', the flowers nodding on slender pedicels', '; flowers pendulous']);
  out.push(infl + '.');

  const mono = g.lineage === 'monocot';
  const organ = mono ? 'Perianth' : 'Corolla';
  const diam = f.size * (1.3 + Math.min(g.heightCm, 100) * 0.032);
  const sizeWord = ['tubular', 'lantern', 'campanulate', 'labiate'].includes(f.form) ? 'long' : 'across';
  let colour = ctx.cFlower;
  if (ctx.cInner === ctx.cFlower || ctx.cFlower.includes(ctx.cInner) || ctx.cInner.includes(ctx.cFlower)) colour += r.pick([', darker at the throat', ', deepening at the throat']);
  else if (['rotate', 'stellate', 'cup'].includes(f.form) && r.chance(0.5)) colour += ` with ${an(ctx.cInner)} eye`;
  else colour += r.pick([`, the throat ${ctx.cInner}`, `, ${ctx.cInner} within`]);
  const parts = mono ? r.pick(['tepals', 'segments']) : (f.form === 'tubular' || f.form === 'labiate' || f.form === 'campanulate' ? 'lobes' : 'petals');
  let count = `${parts} ${f.merosity}`;
  if (f.whorls === 2) count += r.pick([', in two series', ', the flower double']);
  if (f.whorls >= 3) count += r.pick([', in three series', ', the flower fully double']);
  const s1 = `${organ} ${T(r, r.pick(FORM_PHRASE[f.form]), { petals: mono ? 'segments' : 'petals' })}, ${fmtRange(diam * 0.75, diam)} ${sizeWord}, ${colour}; ${count}, ${r.pick(TIP[f.petalTip])}.`;
  out.push(s1);
  const anth = ctx.cAccent;
  const st = { hidden: [`Stamens included, the anthers ${anth}`, `Stamens hidden within the ${f.form === 'tubular' || f.form === 'labiate' ? 'tube' : 'flower'}, the anthers ${anth}`,
    `Stamens ${f.merosity}, included`, `Stamens included; anthers ${anth}, versatile`, `Stamens shorter than the ${parts}, the anthers ${anth}`],
    exserted: [`Stamens long-exserted, the anthers ${anth}`, `Stamens exserted, with ${anth} anthers`, `Stamens ${f.merosity}, far exserted on slender filaments`,
      `Stamens exserted, the filaments ${r.pick(['white', 'pale', 'tinged with ' + ctx.cFlower])}, the anthers ${anth}`],
    plume: [`Stamens numerous, in a feathery plume, the anthers ${anth}`, `Stamens many, forming ${an(anth)} brush`] }[f.stamens];
  out.push(r.pick(st) + '.');
  return out;
}

const FRUIT_PHRASE = {
  berry: ['Fruit a [globose|ovoid] berry, [glossy|dull] {c}', 'Fruit {a_c} berry[, glossy| the size of a pea]'],
  capsule: ['Fruit a [three-valved|loculicidal|ovoid] capsule, {c} when ripe', 'Fruit a capsule, {c}, opening by pores'],
  pod: ['Fruit a slender pod, {c}, splitting along both sutures', 'Fruit a flattened pod, {c}'],
  samara: ['Fruit a samara, the wing {c} and papery', 'Fruit a winged samara, {c}'],
  drupe: ['Fruit a small {c} drupe', 'Fruit a drupe, {c}, with a hard stone'],
  bladder: ['Fruit an inflated, bladder-like capsule, {c}, rattling when ripe', 'Fruit a papery bladder, {c}'],
  beads: ['Fruit moniliform, constricted between the seeds like a string of {c} beads', 'Fruit beaded, {c}, breaking into one-seeded joints'],
};

function fruitSentence(g, ctx, r) {
  if (!g.fruit.present) return r.chance(0.45) ? r.pick(['Fruit not seen.', 'Fruit unknown.', 'The fruit has not been observed.', 'Fruit not yet described.']) : '';
  if (g.marvel === 'crystal') {
    const w = { berry: 'berry', capsule: 'capsule', pod: 'pod', samara: 'samara', drupe: 'drupe', bladder: 'bladder-like capsule', beads: 'beaded pod' }[g.fruit.form];
    return `Fruit ${an(w)}` + (g.fruit.count >= 3 ? `, in clusters of up to ${num(g.fruit.count)}.` : '.');
  }
  let s = T(r, r.pick(FRUIT_PHRASE[g.fruit.form]), { c: ctx.cFruit, a_c: an(ctx.cFruit) });
  if (g.fruit.count >= 3 && ['berry', 'drupe', 'capsule'].includes(g.fruit.form)) s += r.pick([`, borne in clusters of ${num(g.fruit.count)}`, `, in clusters of up to ${num(g.fruit.count)}`]);
  return s + '.';
}

const MARVEL_FACT = {
  luminous: ['After dusk the {petals} give out a soft light of their own, [faint but steady|enough to read large print by|strongest at the throat], which fails at sunrise.',
    'The flowers are luminous at night, glowing a faint {flowerC} from within; cut flowers keep their light for [two|three] nights, and the dried specimen, very faintly, for years.',
    'From sunset until first light the whole inflorescence glows, [the light pulsing slowly, as if breathing|the light steady and cold, like that of glow-worms].', 'The corolla is faintly phosphorescent; at dusk the light gathers first at the throat and spreads outward to the margins, and in the dark the flowers may be counted from a distance.'],
  glass: ['The {petals} are translucent as blown glass, so that the stamens show through them, and ring with a small clear note when touched.',
    'The perianth is of a glassy substance, colourless toward the margins; the flowers chime against one another in any wind.',
    'The {petals} are vitreous and brittle, and give out a [high|thin|clear] note, near {tonic}, when struck with a fingernail.', 'The {petals} are clear and hard as window-glass, colourless at the edges, and when the flowers knock together they sound a small chord.'],
  clockwork: ['The flowers open on the hour and close at the quarter, all together; the seeds are toothed about the margin like the wheels of a watch, and engage one another when shaken.',
    'Each flower opens at the striking of an hour and closes at the next, [keeping time to within a minute|keeping better time than most church clocks]; the seeds are cogged like minute gears.',
    'The flowers open and close hourly, with a faint ticking audible at close range; the seeds are toothed, gear-like, and said to mesh.', 'The flowers open at the first stroke of each hour and close at the last; the seeds bear fine teeth on their rims, like the escape-wheel of a watch.'],
  tidal: ['The flowers open and close with the tides; not of any neighbouring water, but, so far as can be determined, of {sea}, which the plant has never seen.',
    'It keeps the tides of {sea}, opening at high water and closing at the ebb, though it grows [far inland|a hundred miles from salt water|in ground that was never sea].',
    'The flowers open at the flood and close at the ebb, faithfully, according to the tables for {sea}.', 'Twice daily the flowers open and close, keeping, to within a few minutes, the tides of {sea}, though it grows in country that has not seen salt water since the Flood.'],
  smoke: ['The open flowers breathe out thin curling wisps of pale blue smoke, smelling faintly of {scent}.',
    'From each open flower rises a slow thread of blue smoke, most plentiful at evening, with a scent of {scent}.',
    'The flowers exhale a fine blue smoke which hangs over the plant in still weather; it smells of {scent} and leaves no soot.', 'A thin smoke of the palest blue curls from the mouth of each flower and drifts away downwind, scented of {scent}.'],
  crystal: ['{rootFruit} of faceted crystal, [clear as water|faintly tinged with {flowerC}|cloudy at the core], and ring when knocked together.',
    '{rootFruit} of faceted crystal, cold to the touch, throwing small rainbows in sunlight.', '{rootFruit} of faceted crystal, perfectly regular, and so hard that they will scratch glass.'],
  feathered: ['The leaf-blades are divided into soft barbs, like the vane of a feather, and may be smoothed or ruffled with a finger.',
    'The leaves are feathered: the blade is composed of fine barbs that interlock like those of a quill, and part and re-knit when stroked.',
    'The leaves are soft and barbed exactly as feathers are, and shed the rain in the same way.', 'The leaves are true feathers in all but substance, with a central shaft and soft interlocking barbs, and they rustle like a bird settling.'],
  mirrored: ['In place of roots it bears, below ground, a perfect inverted twin of its crown, complete in leaf and flower, which blooms in darkness.',
    'Beneath the soil the plant repeats itself upside down, leaf for leaf and flower for flower, as if growing toward a second sun.', 'Below ground, in place of roots, it grows a second crown inverted beneath the first, exact in every leaf and flower, which opens and closes with it.', 'The plant has no roots; below the surface it is repeated, upside down and perfect, as in still water.'],
  weeping: ['Clear droplets hang from the tips of the {petals}, renewing as fast as they fall; they are faintly salt.',
    'The {petals} weep: a clear drop forms at each tip, falls, and forms again, so that the ground beneath is always damp.',
    'From the tip of every {petal} hangs a single bright drop, [faintly salt|tasting of nothing at all|cool even in summer].', 'Each {petal} ends in a single clear drop, which falls and is at once replaced, so that the plant is never dry.'],
  nested: ['Within each flower blooms a second, smaller flower of the same form and colour, and within that a third; with a good lens a fourth and a fifth may be counted.',
    'Each flower contains another, entire and perfect, and that another, to the limit of the eye.', 'In the heart of each flower stands a smaller flower, perfect in every part, and in the heart of that a smaller still; the series has never been followed to its end.', 'Each flower holds within it a second and smaller flower, and that a third; the innermost are visible only under the microscope.'],
  inverted: ['It grows downward, hanging from the roofs of caves and the undersides of bridges, the leaves and flowers turned toward the ground as other plants turn to the light.',
    'The whole plant grows inverted, rooting overhead and flowering beneath; set upright, it [sulks and dies|turns itself over within a week].', 'It roots in the roofs of caves and the undersides of bridges and grows straight downward, its flowers opening toward the ground.', 'The plant hangs head-down from rock and masonry, its stem growing away from the light, and its flowers face the earth.'],
  constellation: ['The {petals} are spotted with pale dots that map, with fair accuracy, the stars of {constellation}.',
    'Each {petal} bears a scatter of pale points reproducing {constellation}; the pattern is the same on every flower.', 'The {petals} are dotted with small pale spots arranged, with great fidelity, as the stars of {constellation}.'],
  migratory: ['It walks very slowly across open ground on its roots, at the rate of some {inches} inches in a season, generally to the {dir}.',
    'The plant is not stationary but travels on its roots, [a few inches|about a hand’s breadth|a yard or less] in a year, always to the {dir}, leaving a faint furrow behind it.', 'It walks, very slowly, on its roots, travelling some {inches} inches in a season, and always toward the {dir}.', 'The plant moves across the ground on its roots, lifting and setting them down by turns, and in a year may cover a yard.'],
  echoing: ['It repeats, faintly, the last words spoken near it[, commonly within the hour, sometimes after some days|, in the voice of the speaker|, though never more than a few words at a time].',
    'The flowers repeat, very faintly, words spoken in their hearing; the voice is thin but recognisable.', 'It repeats, in a small dry voice, the last words spoken near it; the words are faithful, but the tone is its own.', 'Words spoken near it are given back, faintly and some time afterwards, as if the plant had been considering them.'],
};

function marvelFact(g, ctx, r) {
  return T(r, r.pick(MARVEL_FACT[g.marvel]), ctx);
}

function hybridSentence(g, ctx, r) {
  const [a, b] = g.parents, [da, db] = ctx.parents;
  const fa = wrapHybrid(da.latin), fb = wrapHybrid(db.latin);
  const traits = [];
  const fromA = (k) => g[k] === a[k] && g[k] !== b[k], fromB = (k) => g[k] === b[k] && g[k] !== a[k];
  if (fromA('habit')) traits.push(['the habit', 0]); else if (fromB('habit')) traits.push(['the habit', 1]);
  if (g.marvel !== a.marvel || g.marvel !== b.marvel) traits.push([`the ${MARVEL_WORD[g.marvel]}`, g.marvel === a.marvel ? 0 : 1]);
  if (g.flower.form === a.flower.form && g.flower.form !== b.flower.form) traits.push(['the flowers', 0]);
  else if (g.flower.form === b.flower.form && g.flower.form !== a.flower.form) traits.push(['the flowers', 1]);
  let s = T(r, '[A garden hybrid|A hybrid of garden origin|A cultivated hybrid], {fa} × {fb}, raised by {who} in {year}.',
    { fa, fb, who: ctx.collector.name, year: ctx.year });
  const ta = traits.filter(t => t[1] === 0).map(t => t[0]), tb = traits.filter(t => t[1] === 1).map(t => t[0]);
  if (ta.length && tb.length) s += ` It has ${andList(ta)} of the seed parent and ${andList(tb)} of the pollen parent.`;
  else if (ta.length || tb.length) s += ` It is intermediate between its parents, but has ${andList(ta.length ? ta : tb)} of the ${ta.length ? 'seed' : 'pollen'} parent.`;
  else s += ' It is intermediate between its parents in most respects.';
  return s;
}

const MARVEL_WORD = { luminous: 'luminous flowers', glass: 'glassy petals', clockwork: 'clockwork hours', tidal: 'tidal habit',
  smoke: 'smoking flowers', crystal: 'crystal roots', feathered: 'feathered leaves', mirrored: 'buried twin',
  weeping: 'weeping petals', nested: 'nested flowers', inverted: 'inverted growth', constellation: 'starry petals',
  migratory: 'wandering habit', echoing: 'gift of echo' };

function description(g, ctx, r) {
  const parts = [];
  if (ctx.hybrid) parts.push(hybridSentence(g, ctx, r.fork('hybrid')));
  parts.push(habitSentence(g, ctx, r.fork('habit')));
  parts.push(stemSentence(g, ctx, r.fork('stem')));
  parts.push(leafSentence(g, ctx, r.fork('leaf')));
  parts.push(...flowerSentences(g, ctx, r.fork('flower')));
  parts.push(fruitSentence(g, ctx, r.fork('fruit')));
  parts.push(marvelFact(g, ctx, r.fork('marvel')));
  return tidy(parts.filter(Boolean).map(sentence).join(' '));
}

// ---------------------------------------------------------------- habitat

const HABITATS = {
  herb: ['In damp meadows and along the margins of ditches in {@meadow/river}', 'In rough grassland and on the verges of old roads in {@hills/meadow}',
    'Among the graves of country churchyards, as at {@churchyard}', 'In the turf of sheep-walks on {@hills/chalk}',
    'In clearings of {@wood}', 'On the spoil-heaps of {@mine/quarry}', 'In the rough grass of the sea-cliffs on {@seacliff}',
    'Along the towpaths and in the water-meadows of {@river}', 'In the shade of yews and ruined walls at {@ruin/monastery}',
    'On damp ledges of {@mountain}, [above the tree-line|among dwarf willows|where the snow lies late]', 'In fallow fields and old gardens about {@town}'],
  vine: ['Scrambling over hedges and the walls of ruined chapels about {@town/ruin}', 'Among the timbers and ironwork of {@bridge}',
    'Over old trellises and arbours in {@garden}', 'Up the trunks of old orchard trees in the valleys below {@mountain}',
    'Through the broken roofs of {@mill/ruin}', 'In thickets at the edge of {@wood}', 'Over the rigging of ships laid up in {@harbour}',
    'Over the walls of {@monastery}'],
  shrublet: ['On dry stony slopes of {@mountain/hills}', 'Among heather on {@moor/heath}', 'In limestone scree about {@quarry/rock}',
    'In the lee of sea-walls and among the rocks of {@coast}', 'On the old terraces of {@garden/monastery}',
    'On the open fell of {@moor}, in the shelter of boulders'],
  rosette: ['In the crevices of {@wall}', 'On bare rock ledges of {@mountain/rock}', 'In short turf on the high ground of {@hills/mountain}',
    'Among the paving-stones of {@town}', 'On the stones of dry walls about {@moor/hills}', 'On the worn steps of {@monastery/church}',
    'In the cracks of {@quarry}'],
  bulbous: ['In the grass of old orchards about {@town/garden}', 'In the water-meadows of {@river}', 'Among the fallen stones of {@ruin/monastery}',
    'On sandy heaths, as at {@heath/sand}', 'In the alpine pastures of {@mountain}', 'On chalk downland, as on {@chalk}'],
  aquatic: ['In still pools and slow ditches of {@marsh}', 'In millponds and the backwaters of {@river/mill}',
    'In the flooded streets of {@drowned}, rooting among the cobbles', 'In the nave of the drowned church at {@church}, rooting among the pews',
    'In peat-cuttings and the dark water of {@peat/marsh}', 'In the shallows of {@lake}', 'In the cisterns and fountains of {@town}',
    'In the reservoir above {@reservoir}, over the old roofs'],
  succulent: ['On limestone pavements and quarry faces about {@quarry}', 'On {@salt}, where little else will grow', 'On sun-baked walls and roofs in {@town}',
    'In the dry sand behind the dunes of {@sand}', 'On cliff-ledges above the sea on {@seacliff}', 'Among the bare rocks of {@rock}'],
  epiphyte: ['On the bark of old orchard trees about {@town/garden}', 'In the rigging of ships laid up in {@harbour}', 'On the mossy limbs of old trees in {@wood}',
    'On the timbers of {@bridge}', 'In the forks of pollard willows along {@river}', 'On the beams of ruined barns and chapels about {@ruin}'],
};
const HABITAT_INVERTED = ['Hanging from the roofs of caves, as in {@cave}', 'From the undersides of bridges, notably {@bridge}',
  'From the vaults of cellars and crypts in {@town/monastery}', 'From the ceilings of abandoned galleries in {@mine}',
  'Beneath overhanging cliffs on {@cliff}', 'From the roof of {@cave}, out of reach of the light'];
const HABITAT_MIGRATORY = ['Of no fixed station. First recorded in {@meadow/hills} in {year}, it has since moved some distance to the {dir}',
  'In open meadows, chiefly in {@meadow}, though never in the same place two years together',
  'In the open turf of {@hills/meadow}, moving generally {dir}ward', 'On open ground in {@meadow/heath}; the colony has been followed for [six|nine|twelve] years by its furrows'];

const ABUNDANCE = ['Rare.', 'Local, but abundant where it occurs.', 'Very rare; known from a single station.', 'Not uncommon.',
  'Formerly common; now seldom seen.', 'Not seen since {lastSeen}.', 'Abundant in wet years, absent in dry.',
  'Rare, and much reduced by collectors.', 'Frequent.', 'Scattered and inconstant.', 'Locally plentiful.',
  'Known from fewer than a dozen plants.', 'Not common anywhere.', 'Said to be plentiful once; now confined to a few plants.',
  'Common enough where it grows, and it grows nowhere else.', 'Rare; the station is kept secret by those who know it.',
  'Abundant in some years, and in others not to be found.', 'Rare, and becoming rarer.', 'Plentiful, though seldom noticed.',
  'Known from two stations, one of them since destroyed.', 'Occasional.', 'Uncommon, and never in quantity.',
  'Last collected in {lastSeen}, and perhaps extinct.', 'Very local, and much sought by collectors.'];

const HABITAT_REMARK = {
  tidal: ['Always far from the sea.', 'Never within sight of salt water.', 'It has never been found within forty miles of the coast.'],
  echoing: ['Most often near paths and dwellings, where there is talk.', 'Absent from places where no one speaks.', 'Commonest near schools.'],
  clockwork: ['Commonest within earshot of church bells.', 'It is not found where clocks are not kept.', 'Plentiful about railway stations.'],
  luminous: ['Chiefly in shaded places, where its light is not wasted.', 'Shunned by poachers.', 'Easily found at night, and hardly at all by day.'],
  glass: ['Only in sheltered places; it does not survive hail.', 'Never where cattle are kept, for obvious reasons.'],
  smoke: ['Never near haystacks; the farmers see to that.', 'Sometimes mistaken, at a distance, for a cottage fire.'],
  crystal: ['On poor, stony ground.', 'Often dug for its roots, and rarer for it.'],
  constellation: ['Always on open ground with a clear view of the sky.'],
  weeping: ['Where there is grief, say the country people; in damp places, say the botanists.', 'Commonest in churchyards and below bridges.'],
  feathered: ['Often found with nests built of its leaves nearby.', 'Most plentiful where birds are.'],
  mirrored: ['On deep soils, which the buried twin requires.'],
  nested: [], inverted: ['Always in darkness or deep shade.'], migratory: [],
};

function placeFiller(r, ctx) {
  const used = new Set();
  return (s) => s.replace(/\{@([\w/]+)\}/g, (m, tags) => {
    let pool = placesTagged(tags).filter(p => !used.has(p.id));
    if (!pool.length) pool = placesTagged(tags);
    const p = r.pick(pool);
    used.add(p.id);
    if (!ctx.place) ctx.place = p;
    const role = tags.split('/').find(t => p.tags.split(' ').includes(t));
    return (p.as && p.as[role]) || p.ref;
  });
}

// Garden plants (hybrids).
function habitat(g, ctx, r) {
  const others = COLLECTORS.filter(c => c !== ctx.collector && c.raise > 0);
  return tidy(T(r, 'Known only in cultivation. Raised in {garden}; [plants were sent|cuttings went|seed was sent] to {other}[, where it has proved hardy|, where it survives under glass|, where it did not prosper|, where it is said to be thriving].',
    { garden: ctx.collector.garden, other: r.pick(others).garden }));
}

// Wild plants: chooses the type locality (ctx.place) and returns the habitat
// as templates still holding {slots} that need the collector's dates.
const FREQ_RARE = ['Rare', 'Very rare', 'Scarce', 'Uncommon', 'Local', 'Occasional', 'Very local'];
const FREQ_COMMON = ['Not uncommon', 'Frequent', 'Locally plentiful', 'Common', 'Plentiful', 'Locally abundant'];
const TAIL_RARE = ['known from a single station', 'and much reduced by collectors', 'and becoming rarer', 'the station is kept secret by those who know it',
  'known from two stations, one of them since destroyed', 'and never in quantity', 'last collected in {lastSeen}', 'perhaps extinct',
  'and much sought by collectors', 'not seen since {lastSeen}', 'known from fewer than a dozen plants', 'the colony counted each year, and each year smaller',
  'and inconstant, appearing and vanishing from year to year'];
const TAIL_COMMON = ['though seldom noticed', 'but only where it grows', 'and grows nowhere else', 'in wet years especially', 'though less so than formerly',
  'and regarded locally as a weed', 'though few have troubled to look at it', 'but never far from water'];

function abundance(r) {
  if (r.chance(0.25)) return r.pick(ABUNDANCE);
  const rare = r.chance(0.6);
  const head = r.pick(rare ? FREQ_RARE : FREQ_COMMON);
  if (r.chance(0.3)) return head + '.';
  const tail = r.pick(rare ? TAIL_RARE : TAIL_COMMON);
  return head + (tail.startsWith('and') || tail.startsWith('though') || tail.startsWith('but') || tail.startsWith('in ') ? ', ' : '; ') + tail + '.';
}

function habitatPlan(g, ctx, r) {
  const fillP = placeFiller(r, ctx);
  let bank = HABITATS[g.habit];
  if (g.marvel === 'inverted') bank = HABITAT_INVERTED;
  if (g.marvel === 'migratory' && r.chance(0.6)) bank = HABITAT_MIGRATORY;
  const first = r.pick(bank);
  const main = fillP(vary(r, first));
  const parts = [main];
  if (/mountain|high/.test(ctx.place.tags) && !/monastery|garden/.test(ctx.place.tags) && g.marvel !== 'inverted' && r.chance(0.6)) {
    const lo = r.int(8, 30) * 100, hi = lo + r.int(5, 15) * 100;
    const th = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    parts[0] += `, at ${th(lo)} to ${th(hi)} feet`;
  }
  if (r.chance(0.35)) {
    const second = fillP(vary(r, r.pick((bank === HABITAT_MIGRATORY ? HABITATS.herb : bank).filter(t => t !== first))));
    parts[0] += `; also, [rarely|once|in small numbers], ${second.charAt(0).toLowerCase() + second.slice(1)}`;
  }
  parts[0] = vary(r, parts[0]) + '.';
  parts.push(vary(r, abundance(r)));
  const rem = HABITAT_REMARK[g.marvel];
  if (rem.length && r.chance(0.3)) parts.push(r.pick(rem));
  return parts;
}

// ---------------------------------------------------------------- flowering

const SEASON_OF = ['winter', 'winter', 'spring', 'spring', 'spring', 'summer', 'summer', 'summer', 'autumn', 'autumn', 'autumn', 'winter'];
const MONTH_PHRASE = ['in the dead of winter', 'at the end of winter', 'in early spring', 'in spring', 'in late spring', 'in early summer',
  'in high summer', 'in late summer', 'in early autumn', 'as the leaves turn', 'in late autumn', 'in the depth of winter'];
const SEASON_PHRASE = { spring: ['in spring', 'in late spring', 'in the first warm weeks of spring'],
  summer: ['in high summer', 'in early summer', 'through the summer'], autumn: ['in autumn', 'in early autumn', 'as the leaves turn'],
  winter: ['in the dead of winter', 'in winter', 'in the coldest weeks of the year'] };

function chooseSeason(g, r) {
  if (r.chance(0.04)) return { key: 'always', months: [...Array(12).keys()] };
  let start = wpick(r, [[0, 0.4], [1, 0.7], [2, 1], [3, 1.6], [4, 2], [5, 2.2], [6, 2], [7, 1.6], [8, 1.2], [9, 0.8], [10, 0.4], [11, 0.4]]);
  if (g.marvel === 'crystal' && r.chance(0.5)) start = r.pick([10, 11, 0, 1]);
  const span = r.int(0, 3);
  const months = []; for (let i = 0; i <= span; i++) months.push((start + i) % 12);
  let key = SEASON_OF[start];
  if (start <= 2 && key !== 'summer' && r.chance(0.3)) key = 'early';
  return { key, months };
}

const FLOWER_ODD = ['but only in its third year, and thereafter never again', 'though in wet years not at all', 'each flower lasting a single day',
  'the flowers lasting a week and dropping all together on the same afternoon', 'and again, briefly, after the first frost',
  'in two flushes, the second weaker', 'most freely in years when the cuckoo is late',
  'the plants in the shade of churches a week later than the rest, for reasons not understood',
  'and, it is said, on the night of any death in the parish', 'though plants brought into gardens flower at Christmas, and are never the same again',
  'a few days later every year, so that in a century it will flower in winter', 'only on the side of the plant that faces the nearest church'];
const FLOWER_WHOLE = [['Flowers once in seven years, all plants together, in {m1}.'], ['Flowers only after rain, within the hour, in any month from {m1} to {m2}.'],
  ['Flowers in {m1}, when the swallows come; and again, briefly, when they leave.', [2, 3, 4]], ['Flowers in the week after the first frost, and not again until the next.', [9, 10]],
  ['Flowers at Candlemas, whatever the weather.', [1]], ['Flowers on the longest day of the year, and on no other.', [5]],
  ['Flowers on Midsummer Eve, and is gone by Midsummer morning.', [5]], ['Flowers at Michaelmas, when the hiring fairs are held.', [8]],
  ['Flowers for the twelve days of Christmas.', [11, 0]]];
const FLOWER_MARVEL = {
  luminous: ['the flowers opening only after dusk and closing at first light', 'shining most brightly on moonless nights', 'and only on the nights of a waning moon'],
  glass: ['in still weather; a gale in the flowering season breaks every flower on the hill', 'the flowers ringing all through the season in the least wind'],
  clockwork: ['each flower opening at noon and spent by midnight', 'opening at each striking of the church bell; where there is no church it does not flower',
    'keeping railway time, even in parishes that have no railway'],
  tidal: ['opening most widely at the spring tides', 'though only at spring tides, twice in the month'],
  smoke: ['its smoke most visible on still, frosty evenings', 'smoking most freely at dusk'],
  crystal: ['after the first hard frost', 'the fruit ripening in the hardest frosts'],
  feathered: ['and moulting its leaves afterwards, as birds do', 'at the return of the swallows'],
  mirrored: ['the buried twin flowering at the same hour, in darkness'],
  weeping: ['weeping most freely in the wet weeks', 'and at funerals, if brought into the church'],
  nested: ['the innermost flowers opening last, some weeks after the outer have fallen'],
  inverted: ['the flowers opening downward into the dark'],
  constellation: ['in the weeks when {constellation} stands highest at midnight', 'while its constellation is above the horizon'],
  migratory: ['wherever it happens to have got to by then', 'pausing in its travels to do so'],
  echoing: ['most freely in gardens where there is conversation', 'and falling silent while in flower'],
};

function flowering(g, ctx, r) {
  const m = ctx.months;
  const m1 = MONTHS[m[0]], m2 = MONTHS[m[m.length - 1]];
  if (ctx.seasonKey === 'always') return T(r, 'Flowers [throughout the year|in every month of the year|at all seasons], [though most freely in {m1}|never more than a few flowers at a time|without apparent preference].', { m1: MONTHS[r.int(0, 11)] });
  const whole = FLOWER_WHOLE.filter(([, ms]) => !ms || ms.includes(m[0]));
  if (r.chance(0.12)) return T(r, r.pick(whole)[0], { m1, m2 });
  let base;
  if (m.length === 1) base = r.pick([`Flowers in ${m1}`, `In flower in ${m1} only`, `Flowers ${MONTH_PHRASE[m[0]]}, in ${m1}`]);
  else if (m.length === 2) base = r.pick([`Flowers from ${m1} to ${m2}`, `In flower ${m1}–${m2}`, `Flowers ${MONTH_PHRASE[m[0]]}, in ${m1} and ${m2}`]);
  else base = r.pick([`Flowers from ${m1} to ${m2}`, `In flower ${m1}–${m2}`, `Flowering from ${m1} until ${m2}`]);
  const x = r.next();
  if (x < 0.55) base += ', ' + T(r, r.pick(FLOWER_MARVEL[g.marvel]), ctx);
  else if (x < 0.85) base += ', ' + r.pick(FLOWER_ODD);
  return tidy(base + '.');
}

// ---------------------------------------------------------------- field notes

const VOICE = {
  vellum: {
    open: ['@coast/island/harbour:Found {where} when I went down at dusk to look at the boats.', '@coast/island/harbour:Brought to me {where} by the pilot’s boy, who would take no money for it but asked to see it painted.',
      'Gathered {where} in a fog so thick that I found it by touch.', 'Found {where}, on the first walk I had taken in a month, and nearly set my foot on it.',
      'Found {where}, between one trimming of the lamp and the next.'],
    aside: ['I painted it by the lamp, which is the only light I have ever painted by, and I fear the colours are a night’s colours.',
      'Thomas would have known its name. I have given it one of my own, and shall not write it here.',
      '@coast/island:The keepers call it a drowned man’s flower; I call it a plant, and have put it in a jar.',
      'Father says I keep the light and the flowers equally badly; the flowers at least do not complain.',
      'I sat up with it until the lamp wanted trimming, and then a little longer.', '@coast/island:The sea was very loud all night. The plant did not seem to mind it.'] },
  ashgrove: {
    open: ['Brought to me {where} by my daughter, who led me to it by the sleeve.', 'Found by touch {where}; my eyes being what they are, I knew it first by the feel of the leaves.',
      'Gathered {where}, on the walk I take each morning before the shop opens.', 'I heard it before I found it, {where}.'],
    aside: ['My daughter tells me the flowers are {flowerC}; I take her word for it, as I take it for most things now.',
      'I counted the {petals} with my fingertips: {merosity}, and the same on every flower I could reach.',
      'Josiah has engraved it from my description and his own eyes, which are better.',
      'A clockmaker is a man who listens to small things. This is a small thing worth listening to.',
      'I have set it on the bench beside the regulator, where I can reach it.'] },
  brenn: {
    open: ['Found {where} after Compline, when I should have been at my prayers.', 'Gathered {where} on a feast day, which I hope excuses the picking of it.',
      'Sister Agnes found it {where} and gave it to me without a word, which is our rule.', 'Found {where}, on the long walk down to the village for the bishop’s letters.'],
    aside: ['Pressed between the leaves of my psalter, at the hundred and fourth psalm, where it has left a stain I cannot regret.',
      'Reverend Mother has forbidden it in the chapel. I keep it in my cell, where nobody forbids anything.',
      'May God forgive me the vanity of describing it so carefully; He made it carefully enough.', 'I confess I looked at it during the Office.',
      'I have drawn it in the margin of the Lamentations, which seemed fitting.',
      'We are not to have possessions. I do not think a pressed flower is a possession; I think it is a prayer that has been kept.'] },
  hollander: {
    open: ['Found {where}; I took a bearing on the nearest steeple and paced it: eleven hundred and four paces, north-north-west.',
      '@coast/island/salt:Collected {where}, on a coast I was surveying for a government that has since forgotten me.', 'Found {where}, which is on no map but mine.',
      'Gathered {where} while waiting for a boat that did not come.'],
    aside: ['I have marked the station on my chart with a small cross, as I once marked my own house.', 'In exile one collects what one can carry; it is light, and asks nothing.',
      'It is the only thing in this country that has not asked to see my papers.', 'The local people have no name for it. They have no name for me either.',
      'I have drawn it to scale, which is the one courtesy a cartographer can offer.'] },
  emoerk: {
    open: ['Found {where} on the morning of the {dayOrd}, a full week before my brother claims to have seen it.', 'Gathered {where}, in the presence of two witnesses, whose statements I enclose.',
      'Found {where}, on ground my brother is pleased to call his own.'],
    aside: ['Silas will dispute this. Let him.', 'My brother’s specimen is from a different plant, and a poorer one.',
      'I have written to the Society, who will no doubt hear from Silas by the same post.', 'It is a fine plant, and I wish it had been found by a man with a pleasanter brother.'] },
  smoerk: {
    open: ['Found {where}; Edmund’s account of the locality is wrong, as his accounts generally are.', 'Collected {where}, a week after my brother and in a better state.',
      'Found {where}, while my brother was looking the other way, which is his habit.'],
    aside: ['Edmund’s description is wrong in every particular but the colour, and that he had from me.', 'I have sent a specimen to the Society, with a note, to forestall my brother.',
      'Edmund says it is common. Edmund says many things.', 'If my brother names this after himself I shall publish the letters.'],
    late: ['Edmund would have disputed every word of this. I find that I miss it.', 'I went to show it to Edmund before I remembered.'] },
  carrow: {
    open: ['Found {where}, while running a line of levels for the Commission.', '@drowned/reservoir/water/river:Gathered {where}, in the last week before the sluices were closed.',
      '@drowned/reservoir/river/meadow/marsh:Found {where}, at the corner of a field that will be forty feet under water by Michaelmas.', 'I could not sleep, and walked out {where} with the chain and the lantern.'],
    aside: ['The valley will be flooded in the spring. I have taken what I could.', 'It is a melancholy trade, to measure a place in order that it may be drowned.',
      'The farmer asked me whether it would grow under water. I said I did not know. I did not tell him I hoped so.',
      'I have marked it on the plan, though the plan will be rolled up and put away when the water comes.', 'There were children playing in the lane. I did not tell them either.'] },
  quill: {
    open: ['Found {where}, on one of the few walks my doctor permits.', 'Noticed {where} from the carriage; I stopped it, to the coachman’s disgust.',
      'Found {where}, while visiting a cousin I do not care for.'],
    aside: ['Mr Quill disliked flowers. I have made up for it.', 'The gardeners are not to be credited, whatever they tell the Society.',
      'I have three hundred pots of its seedlings and no room for any of them.', 'Lady Ambrose says it is vulgar. Lady Ambrose has never raised anything but her voice.',
      'It took four years and a great deal of patience, chiefly the gardeners’.'] },
  orme: {
    open: ['Found {where} on my way home from a confinement; mother and child well.', 'Gathered {where}, while waiting for a patient to decide whether to die.',
      'Found {where}, on my round, by the gate of a house where I was not needed after all.'],
    aside: ['I have tried an infusion of the leaves upon myself, with no ill effect save a disposition to weep at hymns.', 'Of its virtues I can say nothing yet; of its beauty, everything.',
      'I chewed a leaf: bitter, then sweet, then nothing at all for some hours, including sensation in the tongue.',
      'My housekeeper has forbidden it in the kitchen, which I take as a provisional verdict on its virtues.', 'I have prescribed it twice, cautiously, and been thanked once.'] },
  lisk: {
    open: ['Found {where} by {pupil}, aged {age}, on our Thursday walk.', 'Found {where}; the children saw it first and were insufferable about it all the way home.',
      'Gathered {where}, on a wet Thursday, with eleven children and one umbrella.'],
    aside: ['The children counted the {petals} aloud: {merosity}. We then counted them again, because it is a lesson.',
      '{pupil} has been promised that it will bear her name, and must be told gently that it will not.',
      'The class has drawn it twenty-three times; I enclose the best, and the most honest.', 'It is a better lesson in patience than anything I could devise.',
      'We have pressed it in the big dictionary, at the letter W, for a reason the children would not tell me.'] },
  hallum: {
    open: ['@river/water/lake/marsh/harbour:Seen from the ferry {where}, as most things are by me.', '@river/water/lake/marsh:I have rowed past it {where} for eleven years, and only this spring stopped.',
      'Found {where}, on the far bank, where the passengers do not go.', '@water/river/lake/marsh:Pulled from the water {where} with the boat-hook.'],
    aside: ['Passengers ask after it now. I tell them it is a weed, so they will leave it be.',
      '@river/water:The river was high and I was late for the crossing, but nobody complained; there was nobody waiting.',
      'I am not a learned man, but I have looked at this plant a long while, which is something.',
      'My wife says I care more for the weeds than the fares. She is right about the fares.'] },
  wren: {
    open: ['@!cave:Collected {where} from the basket of the *Petrel* at four hundred feet, with a butterfly-net lashed to a boat-hook.',
      '@mountain/cliff/rock/quarry:Taken {where} from a ledge no one has stood on, since no one could.', '@mountain/cliff/rock/coast:Seen {where} from the air, as a bright fleck on the cliff, and taken on the second pass.',
      'Found {where}, after a landing more abrupt than I would have liked.'],
    aside: ['@mountain/hills/cliff:The wind took us over the ridge before I could take a second specimen.', 'Mother believes I go up for the view.',
      'At that height everything is quiet except the plants, which I have never before thought noisy.',
      'Mr Gaunt, who engraves my plates, says I am the only botanist who brings him plants with soot on them.',
      'I lost a glove and a pencil and gained a plant. I think it a fair exchange.'] },
};

const OBSERVE = {
  luminous: ['By its own light I could make out the lines of my notebook.', '@wild:At dusk the whole slope came alight, a little at a time, as a town does.',
    'I covered one flower with my hat, and it went on glowing patiently under the brim.', 'The light is a cold {flowerC}, and gives no warmth at all to the hand.', 'A moth came and sat on the lit petals, as if to warm itself.', 'I walked home without a lantern, carrying a single flower before me.'],
  glass: ['When the wind moved through them they rang all together, like a shelf of glasses when a cart goes by.', 'I touched one with my pencil and it gave a note I believe was {tonic}.',
    'I could see the stamens through the petals as through a window.', 'One flower broke in my hand with a sound like a dropped spoon, and I was sorry for the rest of the day.', 'A sudden gust set the whole colony ringing, and a dog in the next field began to howl.', 'In the rain the flowers ring continually and very softly, like a shop-bell heard from the next street.'],
  clockwork: ['They opened together on the stroke of {hour}, as if someone had called them.', 'I set my watch by them and was not late for anything all week.',
    'Under the lens the seeds have teeth, and turn one another when shaken.', 'In the evening quiet one can hear them, very faintly, ticking.', 'At the stroke of the hour every flower on the slope opened, with a sound like a roomful of watches being wound.', 'One flower was a minute slow, and I found myself unaccountably fond of it.'],
  tidal: ['They closed at {time}, which the almanac gives as low water on {sea}, a great distance away.', 'Inland, a hundred miles from salt water, and keeping the tides.',
    '@wild:I watched them open at the flood, with nothing for miles around but dry fields.', 'They opened while I watched, though the nearest water was a horse-trough.', 'I wrote to a harbour-master to ask the hour of high water; it agreed with the flowers to the minute.'],
  smoke: ['Each flower breathed out a thread of blue smoke, smelling of {scent}.', 'On a still evening the smoke stands over them in a low blue roof.',
    'My coat smelled of {scent} for a week afterwards.', 'The smoke rose straight up in the still air, a hundred threads at once, as from a village of very small chimneys.', 'I sneezed, and the flowers seemed to sneeze back a little puff of blue.'],
  crystal: ['The root came out of the ground like a drop from a chandelier.', '@wild:The crystals clicked against one another in my satchel the whole way home.',
    'Held to the light, the root threw a small rainbow on the back of my hand.', 'The spade rang on the root as on a stone.', 'I washed the root in the stream and it came out clear as a window.'],
  feathered: ['The leaves lay down when I stroked them, and rose again, ruffled, when I stopped.', 'A wren was lining her nest with the leaves, and scolded me for interrupting.',
    'In the rain the leaves shed water exactly as a duck’s back does.', 'The wind lifted the leaves exactly as it lifts the feathers of a sitting bird.', 'I pressed a leaf, and it would not lie flat, but kept fluffing up between the papers.'],
  mirrored: ['I dug it up, and found beneath it the same plant again, upside down, and in flower.', 'The buried twin was perfect in every part, and colder to the touch.',
    'I put the twin back. It seemed the decent thing.', 'The twin below ground was in bud when the plant above was in bud, and opened when it opened.', 'Where I had nicked the stem above, the twin below bore the same small wound.'],
  weeping: ['A drop hung from every petal; I tasted one, and it was salt.', 'My sleeve was wet through from brushing past it.',
    'The ground beneath was dark with its weeping, though there had been no rain for a fortnight.', 'It was weeping when I found it and weeping still when I left, and I confess I did not like to leave it.', 'I held my handkerchief beneath it for a minute, and it came away wet.'],
  nested: ['I opened a flower and found another; I opened that and found another; I stopped then, from a feeling that it would not end well.',
    'With the strongest lens I could count {n} flowers, each within the last.', 'The innermost flower was no bigger than a grain of sand, and perfect.', 'Each flower I opened held another; I shut them again carefully, as one closes a letter one has no right to read.', 'Under the lens the innermost flowers were still opening, though the outer ones had long since faded.'],
  inverted: ['It hung from the roof like a bat, and like a bat seemed to resent the lantern.', '@wild:I had to lie on my back in the wet to draw it.',
    'Its flowers turned away from the lantern, toward the dark, as other flowers turn toward the sun.', 'Water dripped from the roof through its leaves, so that it seemed to rain upward from the flowers.', 'I held the lantern below it, and the flowers turned up toward the dark.'],
  constellation: ['The spots on the petals are {constellation}, unmistakably; I checked them that night against the sky.',
    'Every flower carries the same stars, and none of them is quite the sky we have.', 'I lay down beside it at midnight and compared it with the heavens; the plant was the more accurate.', 'I could not name the stars on its petals, nor could the vicar, who keeps a telescope.', 'Every petal I examined bore the same small map, accurate to the faintest star.'],
  migratory: ['I marked it with a peg on the Tuesday; by the Friday it stood a foot to the {dir} of the peg.', 'The track it leaves is a faint furrow, as of a finger drawn through the grass.',
    '@wild:The farmer says it was by his gate in his father’s time. It is now at the far hedge.', 'The children say it walks at night. I sat up to see, and it did not; but in the morning it had.', 'There is a gap in the hedge it has evidently passed through, and a gap in the next.'],
  echoing: ['I said, “What are you?”, and an hour later it said it back.', 'It repeated my sneeze, which I thought ungentlemanly.',
    'Late in the evening it said, quite clearly, “{word}”; I had said nothing of the kind, and nor had anyone I know.',
    'When I left it was still saying my name, more and more faintly.', 'It said “good morning” in the voice of the farmer’s wife, who had passed it half an hour before.', 'I recited the names of the planets to it; it gave me back four of them, in the wrong order.'],
};

const ORDINALS = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh',
  'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth', 'twentieth', 'twenty-first',
  'twenty-second', 'twenty-third', 'twenty-fourth', 'twenty-fifth', 'twenty-sixth', 'twenty-seventh', 'twenty-eighth', 'twenty-ninth',
  'thirtieth', 'thirty-first'];
const ECHO_WORDS = ['Margaret', 'the boat is late', 'not yet', 'come in, it is getting dark', 'I know', 'forgive me', 'twelve shillings', 'mind the step', 'is anyone there'];
const PUPILS = ['Annie Pell', 'Hester Wake', 'Ada Thorne', 'Mary Ferris', 'Lettice Gull', 'Rose Amberly', 'Nell Pardoe'];
const SMELLS = ['honey', 'bitter almonds', 'wet pennies', 'violets', 'cut grass', 'the inside of a church', 'rain', 'pepper', 'warm bread', 'nothing at all'];

function traitObservation(g, ctx, r) {
  const opts = [];
  const h = g.heightCm;
  const reach = r.pick(h < 15 ? ['It stood no higher than my boot.', 'I had to kneel to see it properly.', 'A child could have hidden it under one hand.']
    : h < 45 ? ['It came barely to my knee.', 'It stood about a span high.', 'It reached no higher than the grass about it.']
    : h < 100 ? ['It stood about as high as my hip.', 'It stood waist-high.', 'The tallest stood as high as a gate.']
    : h < 170 ? ['It stood as high as my shoulder.', 'It looked me nearly in the eye.', 'It was taller than any child.']
    : ['It climbed higher than I could reach.', 'I could not reach the highest flowers.', 'It went up out of sight into the branches.']);
  opts.push(reach, `The smell is of ${r.pick(SMELLS)}.`);
  const whites = /white|ivory/.test(ctx.cInner) && /white|ivory/.test(ctx.cFlower);
  if (ctx.cInner !== ctx.cFlower && !whites) opts.push(`The colour is ${ctx.cFlower}, ${r.pick(['deepening', 'changing', 'giving way'])} at the throat to ${ctx.cInner}.`);
  if (g.stem.armature === 'hairs') opts.push('The leaves are rough as a cat’s tongue.');
  if (g.stem.armature === 'thorns') opts.push('I have the thorns in my thumb still.');
  if (g.stem.armature === 'tendrils') opts.push('The tendrils took hold of my sleeve while I was drawing it.');
  if (g.flower.nodding) opts.push('The flowers hang their heads, as if listening.');
  return r.pick(opts);
}

// Lines may begin '@tag/tag:' (only where the place has one of the tags) or
// '@wild:' (never for garden hybrids).
function usable(lines, ctx) {
  const ok = lines.filter(l => {
    const m = l.match(/^@(!?)([\w/]+):/);
    if (!m) return true;
    if (m[2] === 'wild') return !ctx.hybrid;
    const has = m[2].split('/').some(t => (ctx.place.tags || '').split(' ').includes(t));
    return m[1] ? !has : has;
  }).map(l => l.replace(/^@!?[\w/]+:\s*/, ''));
  return ok.length ? ok : lines.filter(l => !l.startsWith('@'));
}

function notesFor(g, ctx, r) {
  const c = ctx.collector, v = VOICE[c.id];
  const slots = { ...ctx, where: ctx.where, pupil: r.pick(PUPILS), age: num(r.int(7, 12)), dayOrd: ORDINALS[ctx.date.d] };
  const out = [];
  if (ctx.hybrid) {
    const [da, db] = ctx.parents;
    const fa = wrapHybrid(da.latin), fb = wrapHybrid(db.latin);
    out.push(T(r, r.pick(['I crossed {fa} with pollen of {fb} in {cy}, and had [one|two|three] seedlings for my trouble[, of which this is the only one worth keeping|].',
      'The cross, {fa} by {fb}, was made in {cy}; it flowered for the first time this {month}.',
      'The seed parent was {fa}, the pollen parent {fb}. [The gardeners said it would never take.|I did the work myself, with a camel-hair brush.|It was done on a wet afternoon, for want of anything better.]']),
    { fa, fb, cy: ctx.year - r.int(2, 5), month: MONTHS[ctx.date.m] }));
    if (r.chance(0.6)) out.push(T(r, r.pick(usable(OBSERVE[g.marvel], ctx)), slots));
  } else {
    out.push(T(r, r.pick(usable(v.open, ctx)), slots));
    out.push(T(r, r.pick(usable(OBSERVE[g.marvel], ctx)), slots));
    if (r.chance(0.4)) out.push(traitObservation(g, ctx, r));
  }
  let asides = v.aside;
  if (c.id === 'ashgrove' && ctx.year < 1826) asides = asides.filter(a => !a.includes('Josiah'));
  if (c.id === 'vellum' && ctx.year < 1837) asides = asides.filter(a => !a.includes('Thomas'));
  asides = usable(asides, ctx);
  if (c.id === 'smoerk' && ctx.year > 1893 && r.chance(0.6)) asides = v.late;
  if (c.id === 'emoerk' || c.id === 'smoerk') asides = asides.filter(a => ctx.year > 1893 || !/remembered|miss it/.test(a));
  if (r.chance(ctx.hybrid ? 0.9 : 0.7)) out.push(T(r, r.pick(asides), slots));
  return tidy(out.join(' '));
}

// ---------------------------------------------------------------- virtues

const LORE = {
  luminous: ['Cottagers on the Lantern Coast once kept it on window-sills to guide the boats home, until the Board of Lights, fearing wrecks, forbade it.',
    'A sprig in a jar was formerly used as a night-light in nurseries; children are said to sleep without dreams by it.',
    'Poachers detest it, and gamekeepers plant it along the coverts.',
    'Miners carried the cut flowers underground before the safety-lamp, and some old men still prefer them.', 'In Hesk, before the drowning, a plant was set on the coffin at every wake, so that the dead should not go out in the dark.'],
  glass: ['Hung in doorways, it announces visitors; a set tuned by a glazier of Old Vell was once played at a wedding, to general astonishment.',
    'Housemaids fear it, since a broken flower is stopped out of their wages.', 'Bell-ringers keep a flower in the belfry, by which to tune.', 'Glaziers set a flower in the window of a new house; if it does not ring within the week, the house is unlucky.'],
  clockwork: ['Before the railway, whole parishes kept time by it, and disputes over the hour were settled by walking out to look.',
    'The seeds, which mesh like gears, were sold by pedlars as watch-parts to the credulous, and sometimes, it is said, actually served.',
    'Schoolmasters grow it by the classroom window, to the despair of their pupils.', 'A watchmaker of Old Vell spent eleven years trying to build a clock as exact, and died, it is said, of the comparison.'],
  tidal: ['Fishermen’s wives inland grow it in pots, to know the state of the tide on which their husbands sailed.',
    'Smugglers formerly used it to time their landings, and the revenue men, learning of this, used it to time theirs.',
    'It is given to those who are homesick for the sea, who say that it helps a little.', 'Lovers parted by the sea give one another a plant each, that they may keep the same tide.'],
  smoke: ['The smoke is said to keep moths from wool and grief from a house.',
    'Dried and burned, it was used to fumigate sick-rooms; it did no harm, which was more than could be said for most fumigations.',
    'Beekeepers use the flowering stems in place of a smoker, and the bees are said to prefer it.', 'Old men in the Fens of Hollin smoke the dried flowers in clay pipes, and claim to see in the smoke the faces of their wives as young women.'],
  crystal: ['The roots were cut and set in rings and sold as quartz; the jewellers of Old Vell learned to tell them by their warmth.',
    'Children dig the roots for marbles, and it is rarer near villages in consequence.', 'A root kept in the dairy is believed to stop the milk from turning.', 'Glass-blowers use the powdered root to clear their glass, and say that it sings in the furnace.'],
  feathered: ['The leaves were once used to fletch arrows, and to stuff the pillows of the dying, who are said to go more easily on them.',
    'Milliners bought the leaves by the basket, until the fashion changed.',
    'Laid in a cradle, the leaves are thought to teach a child to fly, or at least to fall more softly.', 'A leaf laid in a letter is said to make it arrive sooner.'],
  mirrored: ['It is unlucky to dig it up, since one cannot be sure which is the plant and which the reflection.',
    'Girls dig it on Midsummer Eve to see the face of their future husband in the buried twin; most see only earth, and are relieved.',
    'Twins are given a plant at their christening, one to each, to be kept apart.', 'Women accused of witchcraft were once said to keep it, the buried twin being taken for a likeness of the neighbour they meant to harm.'],
  weeping: ['The drops, gathered at dawn, were sold to mourners who could not produce tears of their own.',
    'An eye-wash is made from the drops, good for sore eyes and, it is claimed, for hard hearts.',
    'It is planted on the graves of those who died unmourned, so that something, at least, will weep there.', 'It is brought to the bedsides of the dying, so that something may weep for them that will not need consoling.'],
  nested: ['It is given at christenings; the number of flowers counted inward is taken for the number of the child’s grandchildren.',
    'Conjurors have used it, and riddlers name it as the answer to several riddles, none of them good.', 'It is unlucky to count to the innermost flower, and nobody has.', 'The innermost flower, if it could be reached, would grant a wish; many have tried with needles, and none has reached it.'],
  inverted: ['Hung in cellars, it is believed to keep the cider from turning, and the cellar from flooding.',
    'It is said in Grimmet that a man who sleeps beneath it will wake with his thoughts upside down, and this has been offered in court as an excuse.',
    'Bats are fond of it, and it of them.', 'Miners at Grimmet nail a plant to the gallery roof for luck, and will not work beneath a place where one has died.'],
  constellation: ['Navigators carried pressed flowers as a pocket atlas, and were sometimes lost by them.',
    'Astrologers prize it, and read in its petals the fortunes of anyone who can pay.', 'Shepherds use it to teach their sons the stars on cloudy nights.', 'A child born while it is in flower is said to be lucky at sea and unlucky at cards.'],
  migratory: ['A field of it once moved a parish boundary eleven feet in a generation, and the lawsuit outlived both plaintiffs.',
    'Farmers plant it at the edges of fields they hope to enlarge.', 'It is given to those setting out on long journeys, and is said to arrive before them.', 'Pedlars say it shows the road to the next fair, and are more often right than not.'],
  echoing: ['It is kept out of confessionals and courtrooms, and out of most marriages.',
    'Widows grow it by the door, to hear once more the voices of those who went out through it.', 'Parrot-fanciers detest it as a rival.',
    'Lovers once whispered into it and sent it to one another by post; the practice was ended, it is said, by the postmen.', 'Gamekeepers say it has given away more poachers than all the dogs in the county.'],
};

const CLOSINGS = ['To give it to a friend ends the friendship; to give it to an enemy, oddly, does the same.',
  'Sailors will not have it aboard, and fishermen will not sail without it.', 'It is said to flower more freely for the unhappy.',
  'A sprig worn in the hat is supposed to make the wearer invisible to creditors.', 'Picked, it fades within the hour, and the picker within the year, or so the old women say.',
  'It is the only plant permitted on the graves of hangmen.', 'Hung over a door, it keeps out wasps, damp and Methodists.',
  'Young women count its petals to learn whom they will marry; it is generally a sailor.', 'It is bad luck to see it before breakfast.',
  'Horses shy at it, and dogs bark at it, and it bears both with patience.', 'Children are told it is poisonous, which keeps them away from it and is not true.',
  'It is said that whoever plants it will not live to see it flower; gardeners plant it for one another.', 'About {ref} the first flower of the year is taken to church.',
  'It must never be brought into a house where there is a sick child.', 'To dream of it foretells a letter.',
  'It should be picked with the left hand, and never on a Sunday.', 'It is bad luck to give it, and worse to refuse it.',
  'Bees will not visit it, and are thought the wiser for it.', 'Cats will sit beside it for hours.', 'Nothing more is known of its uses, which is perhaps as well.',
  'It has no other use, and is loved regardless.', 'Brides about {ref} wear it, and so do widows, which visitors find confusing.',
  'About {ref} it is called simply “the flower”, as though there were no other.', 'Goats will not touch it; goats know.'];

function usesFor(g, ctx, r) {
  const u = [];
  const fc = g.colors.flower;
  if (fc.s > 35 && fc.l > 25 && fc.l < 80) u.push(`The flowers yield ${an(ctx.cFlower)} dye, ${r.pick(['fugitive in sunlight', 'fast on wool but not on linen', 'much used by the weavers of Owlsbury'])}.`);
  if (g.root.form === 'tuber') u.push(`The tubers are edible when roasted, and taste ${r.pick(['of chestnuts', 'faintly of soap', 'of very little', 'of the year they were dug'])}.`);
  if (g.root.form === 'taproot') u.push(`The root, boiled, is ${r.pick(['a bitter tonic', 'a remedy for chilblains', 'drunk in place of coffee in hard times'])}.`);
  if (g.root.form === 'bulb') u.push(r.pick(['The bulbs yield a glue used by bookbinders.', 'The bulbs are poisonous, and were once used, it is whispered, for that purpose.']));
  if (g.fruit.present) u.push({ berry: r.pick(['The berries make a sharp jelly, good with mutton.', 'The berries are poisonous to all but thrushes.']),
    drupe: 'The stones are threaded as rosaries.', beads: 'The beaded fruits are strung as necklaces for children, and swallowed by them with alarming regularity.',
    pod: r.pick(['The young pods are pickled.', 'The ripe pods are fed to pigeons, who are said to fly the faster for them.']),
    samara: r.pick(['Children drop the winged fruits from church towers to watch them spin.', 'The winged fruits are used by fishermen to judge the wind.']),
    bladder: r.pick(['Children pop the inflated fruits, which make a satisfying report.', 'The inflated fruits are floated on millponds by children on May Day.']),
    capsule: r.pick(['The dry capsules are used as rattles to frighten birds from the corn.', 'The seeds, shaken from the capsules, are scattered on the thresholds of new houses.']) }[g.fruit.form]);
  if (g.stem.armature === 'hairs') u.push(r.pick(['The hairy leaves were used to scour pewter.', 'The down of the stems is gathered for tinder.']));
  if (g.stem.armature === 'thorns') u.push(r.pick(['It makes an excellent hedge against cattle, and a tolerable one against tax-collectors.', 'The thorns serve the poor as pins.']));
  if (g.stem.armature === 'tendrils') u.push('Gardeners use the tendrils to bind grafts.');
  if (g.habit === 'aquatic') u.push('The leaves serve as lids for milk-pails.');
  if (g.habit === 'succulent') u.push('The sap soothes burns and nettle-stings.');
  if (g.habit === 'vine') u.push('The stems make a supple withy for baskets.');
  if (g.leaf.size > 0.8 && !['linear', 'needle', 'terete'].includes(g.leaf.shape)) u.push(r.pick(['The leaves are used to wrap butter for market.', 'The broad leaves serve as plates at harvest suppers.']));
  if (r.chance(0.4)) u.push(`Dr Orme prescribed it for ${r.pick(['melancholy, palpitations and the vapours, in that order of success', 'sleeplessness, with some success, and for love, with none',
    'the grief of widowers', 'coughs, and for nothing else whatever', 'the toothache, applied to the opposite cheek', 'nightmares, though he admitted it gave him several',
    'homesickness, which he considered a disease of the liver'])}.`);
  if (r.chance(0.4)) u.push(r.pick(['Country people make a tea of the leaves, which they drink for colds and pour away when no one is looking.',
    'The dried flowers are put among linen, to which they give a faint scent and a slight tendency to rustle.',
    'Children make whistles of the hollow stems.', 'Pigs root it up greedily, and are said to be the better for it.',
    'The leaves, laid on a bruise, draw out the colour within the hour, and transfer it to the leaf.']));
  return u;
}

function virtues(g, ctx, r) {
  const out = [r.pick(LORE[g.marvel])];
  if (r.chance(0.75)) out.push(r.pick(usesFor(g, ctx, r)));
  if (r.chance(0.42)) out.push(T(r, r.pick(CLOSINGS), { ref: ctx.place.ref }));
  return tidy(out.join(' '));
}

// ---------------------------------------------------------------- song

const TIMBRE = {
  musicbox: ['like a music-box', 'like a musical box in another room', 'like a musical box wound by a careful child'],
  celesta: ['like a celesta', 'like a celesta played very softly', 'like a celesta heard from another room'],
  glass: ['like a glass harmonica', 'like wet fingers drawn round the rims of glasses', 'like a glass harmonica in an empty house'],
  harp: ['like a harp', 'like an Aeolian harp in an open window', 'like a harp played under water'],
  bell: ['like small bells', 'like handbells heard across water', 'like the bells of a drowned church'],
  kalimba: ['like a thumb-piano', 'like the thumb-pianos that sailors bring home', 'like a thumb-piano played with cold fingers'],
};

function modePhrase(mode, tonic, r) {
  const named = (n) => r.chance(0.5) ? `the ${n} mode on ${tonic}` : `${tonic} ${n}`;
  switch (mode) {
    case 'ionian': return r.chance(0.6) ? `${tonic} major` : `the Ionian mode on ${tonic}`;
    case 'aeolian': return r.chance(0.6) ? `${tonic} minor` : `the Aeolian mode on ${tonic}, our natural minor`;
    case 'lydian': return named('Lydian') + r.pick(['', ', whose raised fourth gives it a bright, unsettled air']);
    case 'mixolydian': return named('Mixolydian');
    case 'dorian': return named('Dorian') + r.pick(['', ', the mode of old carols']);
    case 'phrygian': return named('Phrygian') + r.pick(['', ', with its sorrowful falling second']);
    case 'pentatonic': return r.pick([`a pentatonic scale on ${tonic}`, `the five-note scale of the old pipers, on ${tonic}`]);
    case 'minor-pentatonic': return r.pick([`a minor pentatonic scale on ${tonic}`, `the minor five-note scale of the old ballads, on ${tonic}`]);
    case 'wholetone': return r.pick([`the whole-tone scale on ${tonic}`, `a scale of whole tones on ${tonic}, which has no resting-place`]);
    case 'hirajoshi': return `the hirajoshi scale of the eastern islands, on ${tonic}`;
    default: return `the key of ${tonic}`;
  }
}

function meterPhrase(g, r) {
  const [n, d] = g.music.meter, m = g.flower.merosity;
  const parts = g.lineage === 'monocot' ? 'tepals' : 'petals';
  const words = { 3: 'three', 4: 'four', 5: 'five', 6: 'six', 7: 'seven', 8: 'eight' };
  let s = n === 4 && d === 4 ? r.pick(['in common time', 'in four']) : n === 3 ? r.pick(['in three-four time', 'in waltz time', 'in three'])
    : n === 6 ? r.pick(['in six-eight time', 'in a rocking six-eight']) : `in ${words[n]}-${words[d] || d} time`;
  const groups = ['', '', 'pairs', 'threes', 'fours', 'fives', 'sixes'];
  if (m === n) s += `, after its ${num(m)} ${parts}`;
  else if (m % n === 0 && groups[m / n]) s += `, its ${num(m)} ${parts} counted in ${groups[m / n]}`;
  else if (n % m === 0) s += `, its ${num(m)} ${parts} ${n / m === 2 ? 'taken twice over' : 'taken thrice over'}`;
  else s += `, its ${num(m)} ${parts} notwithstanding`;
  return s;
}

function tempoWord(bpm) {
  return bpm < 58 ? 'largo' : bpm < 66 ? 'lento' : bpm < 76 ? 'adagio' : bpm < 86 ? 'andante' : bpm < 94 ? 'moderato' : 'allegretto';
}

function song(g, ctx, r) {
  const mu = g.music;
  const tempo = tempoWord(mu.bpm);
  const tall = g.heightCm > 120 && mu.bpm < 70 && r.chance(0.4) ? ' ' + r.pick(['It sings slowly, as tall plants do.', 'Like most tall plants, it is in no hurry.']) : '';
  const drone = !mu.drone ? '' : ['bulb', 'corm', 'tuber', 'rhizome'].includes(g.root.form)
    ? `, over a low drone from the ${g.root.form}` : r.pick([', over a faint, continuous drone', ', over a drone that seems to come from the ground']);
  const density = mu.density > 0.62 && r.chance(0.6) ? ' ' + r.pick(['Its melody is busy and many-noted.', 'The tune is crowded, like a hedge in May.',
    'There are a great many notes, all of them in a hurry.', 'The flowers sing over one another, like a choir that has lost its place.', 'It is a busy, chattering song.'])
    : mu.density < 0.33 && r.chance(0.6) ? ' ' + r.pick(['The notes are sparse, with long silences between them.', 'It is a song of few notes and long pauses.',
      'Each note is allowed to fade entirely before the next.', 'Much of the song is silence.', 'It sings sparingly, as if counting the cost.']) : '';
  const s1 = T(r, r.pick(['It sings {tempo}, in {mode}, {meter}, {timbre}{drone}.',
    '[Its song is in|Its song lies in] {mode}, {meter}. It is sung {tempo}, {timbre}{drone}.',
    drone ? 'It sings in {mode}, {meter}; {tempo}, {timbre}{drone}.' : 'Its song, {tempo} and {timbre}, is in {mode}, {meter}.']), {
    mode: modePhrase(mu.mode, mu.tonic, r), meter: meterPhrase(g, r), tempo, timbre: r.pick(TIMBRE[mu.timbre]), drone });
  const c = g.colors.flower;
  const s2 = c.s < 25 && c.l > 80
    ? T(r, '[The flowers being nearly colourless, the key cannot be read from them by Scriabin’s table; it sings in {tonic}, the plainest key it could find.|Its pale corolla gives no clear reading on Scriabin’s table of colours, and the key of {tonic} is assumed.]', { tonic: mu.tonic })
    : T(r, '[The key, read from the colour of the corolla by Scriabin’s table, is {tonic}.|By Scriabin’s correspondence of colours and keys, its {flowerC} corolla gives the key of {tonic}.|{tonic} is, by Scriabin’s reckoning, the key of a {flowerC} flower.|The key is {tonic}, which on Scriabin’s table of colours lies nearest to {flowerC}.|Scriabin, who heard colours as keys, would have known the key at a glance: {tonic}.|Its key of {tonic} is read, after Scriabin, from the colour of its flowers.]', { tonic: mu.tonic, flowerC: ctx.cFlower });
  return tidy(s1 + density + tall + ' ' + s2);
}

// ---------------------------------------------------------------- figures & credits

const MAG = (m, r) => m === 1 ? 'natural size' : m === 2 ? r.pick(['magnified twice', 'twice natural size'])
  : m === 3 ? r.pick(['magnified three times', 'magnified thrice']) : `magnified ${num(m)} times`;
const FRUIT_WORD = { berry: 'Berry', capsule: 'Capsule', pod: 'Pod', samara: 'Samara', drupe: 'Drupe', bladder: 'Inflated fruit', beads: 'Beaded fruit' };
const FRUIT_SECTION = { berry: 'Berry cut across', capsule: 'Capsule in transverse section', pod: 'Pod opened to show the seeds',
  samara: 'Samara, the seed-chamber opened', drupe: 'Drupe in section, showing the stone', bladder: 'Bladder cut open, showing the seeds', beads: 'Beaded fruit in section' };
const ROOT_FIG = { taproot: 'Taproot', fibrous: 'Roots', tuber: 'Tuber', rhizome: 'Portion of the rhizome', bulb: 'Bulb', corm: 'Corm', aerial: 'Aerial roots' };

function figures(g, ctx, r) {
  const out = [];
  const factor = g.heightCm / (32 * Math.max(0.25, g.stem.height));
  const scale = g.heightCm <= 35 || factor < 1.25 ? 'natural size' : factor < 2.6 ? 'reduced by half'
    : factor < 3.6 ? 'reduced to one third' : factor < 5 ? 'reduced to one quarter' : 'much reduced';
  let plant;
  if (g.presentation === 'sprig') {
    const what = { vine: r.pick(['A flowering shoot', 'A flowering branch']), shrublet: 'A flowering branch', rosette: 'A flowering scape',
      bulbous: 'A flowering scape', aquatic: 'A flowering stem' }[g.habit] || r.pick(['A flowering stem', 'A flowering branch']);
    plant = `${what}, ${g.heightCm <= 60 ? 'natural size' : r.pick(['natural size', 'somewhat reduced'])}`;
  }
  else if (g.marvel === 'inverted') plant = `The plant, hanging as it grows, ${scale}`;
  else if (g.marvel === 'mirrored') plant = `The plant, with its buried twin, ${scale}`;
  else if (g.habit === 'aquatic' && g.leaf.arrangement === 'basal') plant = `The flowering plant, with its floating leaves, ${scale}`;
  else plant = `${r.pick(['The flowering plant', 'The whole plant, in flower', 'The plant in flower'])}, ${scale}`;
  out.push(`Fig. 1. ${plant}.`);
  g.figures.forEach((f, i) => {
    let name;
    switch (f.kind) {
      case 'flower-front': name = g.flower.nodding ? r.pick(['Flower, seen from below', 'Flower, face view']) : r.pick(['Flower, seen from the front', 'A single flower, face view']); break;
      case 'flower-section': name = g.marvel === 'nested' ? 'Flower in longitudinal section, showing the flowers within' : r.pick(['Flower in longitudinal section', 'Flower cut lengthwise', 'Flower in section, showing the ovary']); break;
      case 'stamen': name = g.flower.stamens === 'plume' ? 'Stamens from the plume' : r.pick(['Stamen', 'A stamen, front and back', 'Stamen, with the anther open']); break;
      case 'fruit': name = g.marvel === 'crystal' ? `${FRUIT_WORD[g.fruit.form]}, of faceted crystal` : r.pick([FRUIT_WORD[g.fruit.form], `Ripe ${FRUIT_WORD[g.fruit.form].toLowerCase()}`]); break;
      case 'fruit-section': name = FRUIT_SECTION[g.fruit.form]; break;
      case 'seed': name = g.marvel === 'clockwork' ? 'Seed, showing the gear-teeth' : r.pick(['Seed', 'Seed, side view', 'Seeds']); break;
      case 'leaf': name = g.marvel === 'feathered' ? 'Leaf, showing the barbs' : g.leaf.shape === 'peltate' ? 'Leaf, from beneath, showing the central stalk'
        : g.leaf.variegation !== 'none' ? 'Leaf, showing the markings' : r.pick(['Leaf', 'A single leaf', 'Leaf, under side']); break;
      case 'root': name = g.marvel === 'crystal' ? 'Root, of faceted crystal' : ROOT_FIG[g.root.form]; break;
      case 'bud': name = r.pick(['Flower bud', 'Bud, before opening']); break;
      default: name = cap(String(f.kind).replace(/-/g, ' '));
    }
    out.push(`Fig. ${i + 2}. ${name}, ${MAG(f.mag || 1, r)}.`);
  });
  return out;
}

const PREFER = { vellum: { del: 'A. Vellum' }, brenn: { del: 'O. Brenn' }, quill: { del: 'H. Quill' }, lisk: { del: 'M. Lisk' },
  wren: { del: 'E. Wren', sculp: 'P. Gaunt' }, ashgrove: { sculp: 'J. Ashgrove' } };

function artistFor(list, year, prefer, r) {
  if (prefer) { const p = list.find(a => a[0] === prefer && a[1] <= year + 3 && a[2] >= year); if (p && r.chance(0.7)) return p[0]; }
  const ok = list.filter(a => a[1] <= year + 3 && a[2] >= year);
  if (ok.length) return r.pick(ok)[0];
  return list.slice().sort((a, b) => Math.abs((a[1] + a[2]) / 2 - year) - Math.abs((b[1] + b[2]) / 2 - year))[0][0];
}

function credits(g, ctx, r) {
  const p = PREFER[ctx.collector.id] || {};
  return { del: `${artistFor(DELINEATORS, ctx.year, p.del, r)} del.`, sculp: `${artistFor(ENGRAVERS, ctx.year, p.sculp, r)} sculp.` };
}

// ---------------------------------------------------------------- etymology

const MARVEL_REASON = {
  luminous: 'for the flowers, which glow after dark', glass: 'for the glassy petals, which ring when touched',
  clockwork: 'for the flowers, which keep the hours', tidal: 'for its keeping of the tides', smoke: 'for the smoke the flowers breathe',
  crystal: 'for the crystal roots', feathered: 'for the feathered leaves', mirrored: 'for the twin it keeps below ground',
  weeping: 'for the weeping petals', nested: 'for its flowers within flowers', inverted: 'for its hanging, downward growth',
  constellation: 'for the stars printed on its petals', migratory: 'for its wandering', echoing: 'for its habit of repeating what it hears',
};
const CAT_REASON = { colour: 'for the colour of the flowers', form: 'for the shape of the corolla', leaf: 'for the shape of the leaves',
  habit: 'for its habit', armature: 'for its armature', glauc: 'for the grey bloom of the leaves' };
const MOOD_NOTE = { improbabilis: ', said to have been the author’s first remark on seeing it', oblitus: ', for reasons the author did not record',
  infelix: ', after the misfortunes of its discoverer', desideratus: ', it having been sought for eleven years before it was found',
  insomnis: ', for the nights the author spent watching it', paradoxus: '', vanus: ', the author being in low spirits at the time' };

function genusEtymology(gen, g) {
  if (gen.latinGloss) return `From the ${gen.latinGloss}, ${MARVEL_REASON[g.marvel]}`;
  const st = gen.stem, en = gen.end;
  let reason = st.why || (st.cat === 'marvel' ? MARVEL_REASON[g.marvel] : CAT_REASON[st.cat] || MARVEL_REASON[g.marvel]);
  if (st.cat === 'marvel' && g.marvel === 'clockwork' && ['spermum', 'carpus'].includes(en.e)) reason = 'for its toothed, gear-like seeds';
  if (st.cat === 'marvel' && g.marvel === 'migratory' && en.e === 'rhiza') reason = 'for the roots on which it walks';
  if (en.latin === 'dim') return `A diminutive formed from the Greek *${st.w}*, ${st.gl}, ${reason}`;
  if (en.latin) return `Formed from the Greek *${st.w}*, ${st.gl}, ${reason}`;
  return `From the Greek *${st.w}*, ${st.gl}, and *${en.w}*, ${en.gl}, ${reason}`;
}

function epithetEtymology(ep, r) {
  switch (ep.kind) {
    case 'place': return r.pick([`The epithet records the type locality, ${ep.place.ref}.`, `The epithet is taken from ${ep.place.ref}, where the plant was first found.`]);
    case 'person': return `The epithet commemorates ${ep.person.name} (${ep.person.life}), ${ep.person.about}.`;
    case 'brothers': return 'The epithet honours Edmund and Silas Mœrk jointly, a compliment neither brother forgave.';
    default: {
      if (ep.word.startsWith('nusquam')) return 'The epithet means ‘of nowhere’, the collector having declined to say where it was found.';
      const note = MOOD_NOTE[ep.raw] || '';
      return r.pick([`The epithet means ‘${ep.gloss}’${note}.`, `The epithet, *${ep.word}*, means ‘${ep.gloss}’${note}.`]);
    }
  }
}

// ---------------------------------------------------------------- context

const INTERNAL = new WeakMap();
const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function chooseCollector(ctx, r) {
  const p = ctx.place;
  const opts = COLLECTORS.map(c => [c, (c.id === 'quill' ? 0.4 : 1) * (c.haunts.includes(p.id) ? 9 : 1)]);
  return wpick(r, opts);
}

function chooseRaiser(ctx, r) {
  const after = Math.max(...ctx.parents.map(p => INTERNAL.get(p).year));
  const ok = COLLECTORS.filter(c => c.raise > 0 && c.active[1] > after);
  const c = ok.length ? wpick(r, ok.map(c => [c, c.raise])) : COLL.quill;
  const lo = Math.max(c.active[0], after + 1), hi = c.active[1];
  return { c, year: lo > hi ? hi : r.int(lo, hi) };
}

function buildContext(g, r) {
  const ctx = { g, hybrid: !!(g.parents && g.parents.length === 2) };
  if (ctx.hybrid) ctx.parents = g.parents.map(describe);
  const mono = g.lineage === 'monocot';
  const rc = r.fork('colours');
  ctx.cFlower = colourName(g.colors.flower, rc);
  ctx.cInner = colourName(g.colors.flowerInner, rc);
  ctx.cAccent = colourName(g.colors.accent, rc);
  ctx.cFruit = colourName(g.colors.fruit, rc);
  ctx.cLeaf = leafColourName(g.colors.leaf, rc);
  const season = chooseSeason(g, r.fork('season'));
  ctx.seasonKey = season.key; ctx.months = season.months;
  const rm = r.fork('misc');
  ctx.constellation = rm.chance(0.15) ? rm.pick(LOST_STARS) : rm.pick(CONSTELLATIONS);
  ctx.scent = rm.pick(SCENTS); ctx.sea = rm.pick(SEAS); ctx.dir = rm.pick(DIRECTIONS);
  ctx.inches = rm.pick(['three', 'four', 'six', 'nine', 'eleven']);
  ctx.hour = rm.pick(['noon', 'three', 'four in the afternoon', 'six', 'nine in the morning', 'eleven']);
  ctx.time = rm.pick(['twenty past four', 'a quarter to eleven', 'ten minutes past two', 'half past six']);
  ctx.n = num(rm.int(5, 9)); ctx.word = rm.pick(ECHO_WORDS);
  ctx.petals = mono ? 'tepals' : 'petals'; ctx.petal = mono ? 'tepal' : 'petal';
  ctx.flowerC = ctx.cFlower; ctx.tonic = g.music.tonic; ctx.merosity = num(g.flower.merosity);
  ctx.rootFruit = g.fruit.present ? 'Root and fruit are' : 'The roots are';

  const rp = r.fork('place');
  let plan = null;
  if (ctx.hybrid) {
    const { c, year } = chooseRaiser(ctx, rp);
    ctx.collector = c; ctx.year = year;
    ctx.place = { id: 'garden', ref: c.garden, short: c.garden.split(' ').pop(), tags: 'garden', lat: null, at: ['in'] };
  } else {
    plan = habitatPlan(g, ctx, r.fork('habitat'));
    ctx.collector = chooseCollector(ctx, rp);
    const [a, b] = ctx.collector.active;
    ctx.year = rp.int(a, b);
  }
  const m = rp.pick(ctx.months);
  ctx.date = { d: rp.int(1, DAYS[m]), m, y: ctx.year };
  ctx.lastSeen = Math.min(1914, ctx.year + rp.int(4, 40));
  ctx.where = ctx.hybrid ? `in ${ctx.collector.garden}` : `${rp.pick(ctx.place.at)} ${ctx.place.ref}`;
  ctx.habitatText = ctx.hybrid ? habitat(g, ctx, r.fork('habitat')) : tidy(plan.map(s => fill(s, ctx)).join(' '));
  return ctx;
}

// ---------------------------------------------------------------- names, assembled

function latinFor(g, ctx, r) {
  if (ctx.hybrid) return hybridLatin(g, ctx, r);
  const genus = makeGenus(g, r);
  const ep = makeEpithet(g, ctx, r, genus);
  const au = makeAuthor(g, ctx, r, genus, ep);
  const latin = { genus: genus.name, epithet: ep.word, full: `${genus.name} ${ep.word}`, author: au.author };
  if (au.syn) latin.syn = au.syn;
  return { latin, genus, ep, au };
}

function hybridLatin(g, ctx, r) {
  const [A, B] = ctx.parents, ia = INTERNAL.get(A).genus, ib = INTERNAL.get(B).genus;
  let genus;
  if (A.latin.genus === B.latin.genus) genus = { ...ia, same: true };
  else {
    const tries = [[ia.stem, ib.end], [ib.stem, ia.end], [ia.stem, END.anthe], [ib.stem, END.anthus], [ia.stem, END.opsis],
      [MARVEL_STEMS[g.marvel][1], END.anthemum], [MARVEL_STEMS[g.marvel][2], END.ella]];
    for (const [stem, end] of tries) {
      if (!stem || !stemFits(stem, end)) continue;
      const name = joinName(stem, end);
      if (name !== A.latin.genus && name !== B.latin.genus && !REAL_GENERA.has(name)) {
        genus = { name, gender: end.g, stem: { ...stem, cat: stem.cat || 'marvel' }, end, notho: true }; break;
      }
    }
    if (!genus) genus = { name: 'Nothanthus', gender: 'm', stem: R('noth', 'nothos', 'spurious', { cat: 'marvel' }), end: END.anthus, notho: true };
  }
  let ep;
  for (let i = 0; i < 6; i++) {
    ep = makeEpithet(g, ctx, r, genus, { hybrid: true });
    if (ep.word !== A.latin.epithet && ep.word !== B.latin.epithet) break;
  }
  const au = makeAuthor(g, ctx, r, genus, ep, { noSyn: true });
  const full = genus.same ? `${genus.name} × ${ep.word}` : `× ${genus.name} ${ep.word}`;
  const formula = `${A.latin.full.includes('×') ? `(${A.latin.full})` : A.latin.full} × ${B.latin.full.includes('×') ? `(${B.latin.full})` : B.latin.full}`;
  return { latin: { genus: genus.name, epithet: ep.word, full, author: au.author, formula }, genus, ep, au };
}

function etymology(g, ctx, L, r) {
  const parts = [];
  if (ctx.hybrid) {
    const [A, B] = ctx.parents;
    parts.push(L.genus.same ? `A hybrid between two species of *${L.genus.name}*.`
      : `The name of the hybrid genus joins those of its parents, *${A.latin.genus}* and *${B.latin.genus}*.`);
  } else parts.push(genusEtymology(L.genus, g) + '.');
  parts.push(epithetEtymology(L.ep, r));
  if (L.au.syn && !L.replaced) {
    const by = L.au.synBy ? ` by ${L.au.synBy.name}` : '';
    const synName = L.au.syn.split(' ').slice(0, 2).join(' ');
    parts.push(r.pick([`First published${by} as *${synName}*, and later transferred to this genus.`,
      `Originally described${by} as *${synName}*.`, `Described${by} as *${synName}*; the present name dates from its transfer to *${L.latin.genus}*.`]));
  } else if (L.au.joint) parts.push('It was published jointly by the Mœrk brothers, the only paper on which their names appear together.');
  if (L.replaced) parts.push(r.pick([
    `It was first described as *${L.replaced.orig.full}* ${L.replaced.orig.author}, but that name was found to belong already to the plant of Tab. ${toRoman(L.replaced.plate)}, and the present name was proposed in its place.`,
    `The name *${L.replaced.orig.full}* ${L.replaced.orig.author}, under which it was first published, proved to be preoccupied by the plant of Tab. ${toRoman(L.replaced.plate)}; hence the present name.`]));
  return tidy(parts.join(' '));
}

// Later homonyms. Where two plates would bear the same name, the later plate
// is renamed, as the Code requires: { plate: [attempt, plate holding the name] }.
// Generated by walking plates 1..3999 in order and re-drawing (fork 'latin#k')
// any name already taken. Each entry is verified at run time, so if names ever
// change upstream a stale entry is simply ignored (and should be regenerated).
const HOMONYMS = {
  775: [1, 501], 1048: [1, 192], 1228: [1, 462], 1414: [1, 992], 1656: [1, 1631], 1744: [1, 864],
  1805: [1, 136], 1814: [1, 1489], 1951: [1, 1053], 2005: [1, 670], 2245: [1, 730], 2290: [1, 393],
  2358: [1, 2311], 2429: [1, 1895], 2666: [1, 1840], 2733: [1, 731], 2959: [1, 1850], 2964: [1, 2076],
  2986: [1, 573], 3107: [2, 2575], 3126: [1, 215], 3372: [1, 3213], 3499: [1, 3292], 3511: [1, 1850],
  3555: [1, 3368], 3720: [1, 606], 3721: [1, 2144], 3729: [1, 656], 3859: [1, 3596], 3914: [1, 2965],
  3959: [1, 2095], 3996: [1, 915],
};

function build(g) {
  const r = rngFor(g, 'text');
  const ctx = buildContext(g, r);
  let L = latinFor(g, ctx, r.fork('latin'));
  const hom = g.plate && HOMONYMS[g.plate];
  if (hom && describe(genomeForPlate(hom[1])).latin.full === L.latin.full) {
    const orig = L.latin;
    L = latinFor(g, ctx, r.fork('latin#' + hom[0]));
    L.replaced = { orig, plate: hom[1] };
    if (!L.latin.syn) L.latin.syn = `${orig.full} ${orig.author}`;
  }
  const latin = L.latin;
  const out = {
    latin,
    family: familyOf(g),
    common: folkNames(g, ctx, r.fork('common')),
    etymology: etymology(g, ctx, L, r.fork('etymology')),
    description: description(g, ctx, r.fork('description')),
    habitat: L.ep.word.startsWith('nusquam') ? T(r.fork('nowhere-h'), 'Locality withheld by the collector, who would say only that it grows [in a damp place|where it pleases|somewhere to the north|nearer than one would think].') : ctx.habitatText,
    flowering: flowering(g, ctx, r.fork('flowering')),
    notes: {
      text: (L.ep.word.startsWith('nusquam') && (ctx.where = r.fork('nowhere').pick(['at a place I shall not name', 'somewhere I have promised not to say', 'in a place that is nobody’s business'])),
        notesFor(g, ctx, r.fork('notes'))),
      collector: ctx.collector.name,
      date: `${ctx.date.d} ${MONTHS[ctx.date.m]} ${ctx.date.y}`,
      place: ctx.where,
    },
    virtues: virtues(g, ctx, r.fork('virtues')),
    song: song(g, ctx, r.fork('song')),
    figures: figures(g, ctx, r.fork('figures')),
    credits: credits(g, ctx, r.fork('credits')),
    plateTitle: latin.full,
  };
  INTERNAL.set(out, { genus: L.genus, year: ctx.year });
  return out;
}

const CACHE = new Map();

export function describe(genome) {
  if (!genome) return null;
  const key = genome.id != null ? String(genome.id) : 'seed:' + genome.seed;
  let out = CACHE.get(key);
  if (!out) { out = build(genome); CACHE.set(key, out); }
  return out;
}
