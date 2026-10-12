// FLORA NUSQUAM — the frontispiece: Flora, goddess of flowers, engraved after
// Titian's picture in the Uffizi (c. 1515). The painting is translated into the
// language of the copper plate — three sets of swelling hatched lines whose width
// follows the darkness of the paint — over a pale hand-coloured wash, and it is
// engraved before the reader's eyes like every other plate in the book.

import { hash32, makeRng } from './genome.js';
import { makePaper } from './plate.js';

const LW = 1000, LH = 1400;
const IMG = { x: 124, y: 112, w: 752, h: 1002 };             // the picture, ratio of the original (3 : 4)
const SRC = new URL('../img/flora-titian.jpg', import.meta.url).href;
const INK = '#2a2118';
const TAU = Math.PI * 2;

// The flowers in her right hand, for the pollen that rises when she sings.
export const FLORA_FLOWERS = [[0.055, 0.83, 26], [0.115, 0.805, 22], [0.085, 0.875, 20], [0.15, 0.85, 16]]
  .map(([nx, ny, r]) => ({ x: IMG.x + nx * IMG.w, y: IMG.y + ny * IMG.h, r }));

// Her song: F, the deep rose of her mantle on Scriabin's table; Lydian, the
// brightest of the old modes; a lilting six-eight on the harp, over a drone.
export const FLORA_GENOME = {
  id: 'flora', seed: hash32('Flora, dea florum'), plate: null, parents: null, label: 'Frontispiece',
  music: { tonic: 'F', pitchClass: 5, midi: 65, mode: 'lydian', bpm: 66, meter: [6, 8], timbre: 'harp', density: 0.55, drone: true },
  flower: { merosity: 6, petalTip: 'fringed', nodding: false, form: 'rotate' },
  leaf: { margin: 'undulate', shape: 'lobed' },
  stem: { lean: 0.4 },
  marvel: 'luminous',
  colors: {
    flower: { h: 352, s: 48, l: 62 }, flowerInner: { h: 38, s: 70, l: 55 }, accent: { h: 46, s: 80, l: 56 },
  },
};

let imgPromise = null;
export function preloadFlora() {
  imgPromise ??= new Promise((resolve, reject) => {
    const im = new Image();
    im.decoding = 'async';
    im.onload = () => resolve(im);
    im.onerror = () => { imgPromise = null; reject(new Error('The likeness of Flora could not be fetched.')); };
    im.src = SRC;
  });
  return imgPromise;
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
  return c;
}

// ------------------------------------------------------------------ reading the picture

let study = null; // { tone, wash } — computed once, in logical units

function studyPicture(img) {
  if (study) return study;
  const W = IMG.w, H = IMG.h;
  const cv = makeCanvas(W, H), x = cv.getContext('2d', { willReadFrequently: true });
  x.filter = 'blur(0.7px)';
  x.drawImage(img, 0, 0, W, H);
  const px = x.getImageData(0, 0, W, H).data;
  const L = new Float32Array(W * H);
  for (let i = 0, j = 0; i < L.length; i++, j += 4) L[i] = (0.299 * px[j] + 0.587 * px[j + 1] + 0.114 * px[j + 2]) / 255;

  // darkness, with the deepest shadows held back so the ground stays a rich hatched
  // tone rather than a black hole, and the contours (eyes, lips, the edge of the
  // shift) cut a little deeper, as an engraver would.
  const tone = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let xx = 0; xx < W; xx++) {
      const i = y * W + xx;
      const t = 1 - L[i];
      let d = 0.8 * Math.pow(t, 1.55);
      if (xx > 0 && y > 0 && xx < W - 1 && y < H - 1) {
        const gx = -L[i - W - 1] - 2 * L[i - 1] - L[i + W - 1] + L[i - W + 1] + 2 * L[i + 1] + L[i + W + 1];
        const gy = -L[i - W - 1] - 2 * L[i - W] - L[i - W + 1] + L[i + W - 1] + 2 * L[i + W] + L[i + W + 1];
        const e = Math.min(1, Math.hypot(gx, gy) * 1.4);
        d = Math.min(0.9, d + Math.max(0, e - 0.2) * 0.22);
      }
      // the ground lightens a little towards the frame, as in a printed proof
      const bx = Math.min(xx, W - 1 - xx), by = Math.min(y, H - 1 - y), b = Math.min(bx, by);
      if (b < 26) d *= 0.8 + 0.2 * (b / 26);
      tone[i] = d;
    }
  }

  // the colourist's wash: the picture, softened and lifted towards the paper
  const ww = Math.round(W / 3), wh = Math.round(H / 3);
  const wc = makeCanvas(ww, wh), wx = wc.getContext('2d', { willReadFrequently: true });
  wx.filter = 'blur(2px)';
  wx.drawImage(img, 0, 0, ww, wh);
  const wd = wx.getImageData(0, 0, ww, wh);
  const a = wd.data;
  for (let j = 0; j < a.length; j += 4) {
    const r = a[j] / 255, g = a[j + 1] / 255, b = a[j + 2] / 255;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    const sat = 1.05, lift = 0.22 + 0.3 * (1 - lum);      // dark paint gets lifted most
    const mix = (c) => { const s = lum + (c - lum) * sat; return Math.round(255 * (s + (1 - s) * lift)); };
    a[j] = mix(r); a[j + 1] = mix(g); a[j + 2] = mix(b);
  }
  wx.putImageData(wd, 0, 0);
  study = { tone, wash: wc };
  return study;
}

// ------------------------------------------------------------------ cutting the plate

let cut = null; // hatch lines as Path2D in logical coordinates, in the order they are cut

function cutPlate(tone) {
  if (cut) return cut;
  const W = IMG.w, H = IMG.h;
  const sample = (x, y) => {
    const xi = x | 0, yi = y | 0;
    if (xi < 0 || yi < 0 || xi >= W || yi >= H) return -1;
    return tone[yi * W + xi];
  };
  const layers = [
    { angle: -31, spacing: 3.5, from: 0.035, to: 0.5, max: 0.92, wave: 0.55 },
    { angle: 33, spacing: 3.9, from: 0.34, to: 0.95, max: 0.62, wave: 0.3 },
    { angle: -76, spacing: 4.3, from: 0.62, to: 1.0, max: 0.5, wave: 0 },
  ];
  const lines = [];
  layers.forEach((Ly, li) => {
    const a = (Ly.angle * Math.PI) / 180;
    const dx = Math.cos(a), dy = Math.sin(a);          // along the line
    const nx = -dy, ny = dx;                            // across
    const cx = W / 2, cy = H / 2;
    const reach = Math.hypot(W, H) / 2 + 4;
    const step = 1.25;
    for (let k = -reach; k <= reach; k += Ly.spacing) {
      const path = new Path2D();
      let any = false, top = [], bot = [];
      const flush = () => {
        if (top.length > 1) {
          path.moveTo(top[0][0], top[0][1]);
          for (let i = 1; i < top.length; i++) path.lineTo(top[i][0], top[i][1]);
          for (let i = bot.length - 1; i >= 0; i--) path.lineTo(bot[i][0], bot[i][1]);
          path.closePath();
          any = true;
        }
        top = []; bot = [];
      };
      for (let u = -reach; u <= reach; u += step) {
        let x = cx + dx * u + nx * k, y = cy + dy * u + ny * k;
        const t = sample(x, y);
        if (t < 0) { flush(); continue; }
        const v = Math.max(0, Math.min(1, (t - Ly.from) / (Ly.to - Ly.from)));
        const w = Ly.spacing * Ly.max * Math.pow(v, 0.85);
        if (w < 0.09) { flush(); continue; }
        // a gentle swell of the line with the modelling, as in a burin-cut portrait
        const off = Ly.wave * (t - 0.45) * Ly.spacing * 0.5;
        x += nx * off; y += ny * off;
        top.push([IMG.x + x + nx * w / 2, IMG.y + y + ny * w / 2]);
        bot.push([IMG.x + x - nx * w / 2, IMG.y + y - ny * w / 2]);
      }
      flush();
      if (any) lines.push({ path, layer: li, order: li + (k + reach) / (2 * reach) * 0.999 });
    }
  });
  lines.sort((p, q) => p.order - q.order);
  cut = lines;
  return cut;
}

// ------------------------------------------------------------------ lettering

async function fontsReady() {
  if (!document.fonts?.load) return;
  await Promise.race([
    Promise.all([
      document.fonts.load('60px "IM Fell English SC"').catch(() => null),
      document.fonts.load('italic 26px "IM Fell English"').catch(() => null),
      document.fonts.load('26px "IM Fell English"').catch(() => null),
    ]),
    new Promise((r) => setTimeout(r, 1500)),
  ]);
}

function spaced(ctx, text, x, y, spacing) {
  const widths = [...text].map((ch) => ctx.measureText(ch).width);
  const total = widths.reduce((a, b) => a + b, 0) + spacing * (text.length - 1);
  let cx = x - total / 2;
  [...text].forEach((ch, i) => { ctx.fillText(ch, cx, y); cx += widths[i] + spacing; });
}

function letter(ctx, label) {
  ctx.save();
  ctx.fillStyle = INK;
  ctx.textBaseline = 'alphabetic';
  // frame
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.7;
  ctx.strokeRect(IMG.x - 9, IMG.y - 9, IMG.w + 18, IMG.h + 18);
  ctx.lineWidth = 0.6;
  ctx.strokeRect(IMG.x - 4, IMG.y - 4, IMG.w + 8, IMG.h + 8);
  // label
  ctx.font = 'italic 25px "IM Fell English", Georgia, serif';
  ctx.textAlign = 'right';
  ctx.fillText(label, 924, 86);
  // title & motto
  ctx.textAlign = 'left';
  ctx.font = '62px "IM Fell English SC", "IM Fell English", Georgia, serif';
  spaced(ctx, 'FLORA', LW / 2, 1190, 22);
  ctx.textAlign = 'center';
  ctx.font = 'italic 25px "IM Fell English", Georgia, serif';
  ctx.fillText('Vere fruor semper.', LW / 2, 1232);
  ctx.font = '15px "IM Fell English", Georgia, serif';
  ctx.fillStyle = 'rgba(42,33,24,0.8)';
  ctx.fillText('OV. FAST. V. 207', LW / 2, 1255);
  // ornament rules either side of the motto
  ctx.strokeStyle = 'rgba(42,33,24,0.55)';
  ctx.lineWidth = 0.8;
  ctx.beginPath(); ctx.moveTo(300, 1224); ctx.lineTo(372, 1224); ctx.moveTo(628, 1224); ctx.lineTo(700, 1224); ctx.stroke();
  // credits, as on a print after a painting
  ctx.font = 'italic 13px "IM Fell English", Georgia, serif';
  ctx.fillStyle = 'rgba(42,33,24,0.85)';
  ctx.textAlign = 'left';
  ctx.fillText('Titianus Vecellius pinx.', 72, 1286);
  ctx.textAlign = 'right';
  ctx.fillText('in Nusquam sculp.', 928, 1286);
  // caption beneath the plate-mark
  ctx.textAlign = 'center';
  ctx.fillStyle = INK;
  ctx.font = 'italic 30px "IM Fell English", Georgia, serif';
  ctx.fillText('Flora, Dea Florum et Veris', LW / 2, 1356);
  ctx.restore();
}

// ------------------------------------------------------------------ the press

const live = new WeakMap();

export function renderFlora(canvas, opts = {}) {
  live.get(canvas)?.cancel();
  const res = opts.resolution ?? 1.6;
  const animate = opts.animate ?? true;
  const duration = opts.duration ?? 9000;
  const label = opts.label ?? 'Frontispiece';
  canvas.width = Math.round(LW * res);
  canvas.height = Math.round(LH * res);
  const ctx = canvas.getContext('2d');
  const paper = makePaper(res, makeRng(hash32('flora paper')));
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(paper, 0, 0);

  let cancelled = false, finished = false, raf = 0, finishNow = false;
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });

  const ctrl = {
    flowerPoints: FLORA_FLOWERS,
    done,
    finish() { finishNow = true; },
    cancel() { if (finished || cancelled) return; cancelled = true; cancelAnimationFrame(raf); resolveDone(false); },
  };
  live.set(canvas, ctrl);

  (async () => {
    let img;
    try { img = await preloadFlora(); } catch (err) { console.error(err); if (!cancelled) { cancelled = true; resolveDone(false); } return; }
    if (cancelled) return;
    const { tone, wash } = studyPicture(img);
    const lines = cutPlate(tone);
    await fontsReady();
    if (cancelled) return;

    const ink = makeCanvas(LW * res, LH * res), ix = ink.getContext('2d');
    ix.setTransform(res, 0, 0, res, 0, 0);
    ix.fillStyle = INK;
    const washCv = makeCanvas(LW * res, LH * res), wx = washCv.getContext('2d');
    wx.setTransform(res, 0, 0, res, 0, 0);
    wx.imageSmoothingQuality = 'high';
    wx.drawImage(wash, IMG.x, IMG.y, IMG.w, IMG.h);

    let cutSoFar = 0;
    const cutTo = (n) => { for (; cutSoFar < n; cutSoFar++) ix.fill(lines[cutSoFar].path); };
    const compose = (washAlpha, letterAlpha) => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.drawImage(paper, 0, 0);
      ctx.globalCompositeOperation = 'multiply';
      ctx.globalAlpha = washAlpha * 0.9;
      ctx.drawImage(washCv, 0, 0);
      ctx.globalAlpha = 0.93;
      ctx.drawImage(ink, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      if (letterAlpha > 0) {
        ctx.setTransform(res, 0, 0, res, 0, 0);
        ctx.globalAlpha = letterAlpha;
        letter(ctx, label);
        ctx.globalAlpha = 1;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
      }
    };
    const complete = () => {
      cutTo(lines.length);
      compose(1, 1);
      finished = true;
      resolveDone(true);
      opts.onDone?.();
    };

    if (!animate) { complete(); return; }
    const t0 = performance.now();
    const ease = (v) => v * v * (3 - 2 * v);
    const frame = (now) => {
      if (cancelled) return;
      const t = (now - t0) / duration;
      if (finishNow || t >= 1) { complete(); return; }
      // the colour comes first, like a memory of the painting; then the burin
      const washA = ease(Math.min(1, t / 0.3)) * 0.55 + ease(Math.max(0, Math.min(1, (t - 0.55) / 0.35))) * 0.45;
      cutTo(Math.floor(lines.length * ease(Math.min(1, Math.max(0, (t - 0.06) / 0.84)))));
      compose(washA, Math.max(0, Math.min(1, (t - 0.88) / 0.1)));
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
  })();

  return ctrl;
}
