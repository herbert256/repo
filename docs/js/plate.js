// FLORA NUSQUAM — plate.js: the engraver.
//
// Draws one plate of the herbarium: a hand-coloured copper engraving of a plant
// that never existed, which draws itself in ink while the viewer watches.
//
//   renderPlate(canvas, genome, opts) -> { finish(), cancel(), done, flowerPoints }
//
// How it works. The genome is grown into a structural description of the plant
// (stems, leaves, flowers, roots...), fitted to the plate, and then engraved into
// a list of "items". Every item carries polylines (outline strokes, hatching,
// veins), stipple dots, watercolour washes and an occlusion polygon, plus a z
// order. The finished picture is painted once, offscreen, into a wash layer and
// an ink layer (painter's algorithm: every item erases what lies behind it). The
// animation then reveals those finished layers through two masks that are drawn
// progressively — the pen travelling along each stroke, each wash blooming out
// from where the brush touched — so the reveal is cheap and the final frame is
// exactly the static rendering. All randomness comes from rngFor(genome,'plate').

import { hslString, mixColor, rngFor, makeRng, hash32 } from './genome.js';

// ------------------------------------------------------------------ constants

const LW = 1000, LH = 1400;                                  // logical plate size
const PLATE = { x0: 45, y0: 45, x1: 955, y1: 1300 };          // the plate-mark
const AREA = { x0: 92, y0: 98, x1: 908, y1: 1248 };           // where the drawing may go
const INK = '#2a2118';
const FONT = '"IM Fell English", "IM FELL English", Georgia, "Times New Roman", serif';
const TAU = Math.PI * 2;
const ACTIVE = new WeakMap();                                 // canvas -> running controller

// ------------------------------------------------------------------ small maths

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const P = (x, y) => ({ x, y });
const add = (a, b) => P(a.x + b.x, a.y + b.y);
const sub = (a, b) => P(a.x - b.x, a.y - b.y);
const mul = (a, k) => P(a.x * k, a.y * k);
const dot = (a, b) => a.x * b.x + a.y * b.y;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const nrm = (a) => { const l = Math.hypot(a.x, a.y) || 1; return P(a.x / l, a.y / l); };
const perp = (a) => P(-a.y, a.x);
const dirOf = (ang, r = 1) => P(Math.cos(ang) * r, Math.sin(ang) * r);
const lerpP = (a, b, t) => P(lerp(a.x, b.x, t), lerp(a.y, b.y, t));
const angOf = (v) => Math.atan2(v.y, v.x);
const LIGHT = nrm(P(-0.6, -0.8));                              // light from the upper left
const SHADOW = mul(LIGHT, -1);

const V3 = (x, y, z) => ({ x, y, z });
const add3 = (a, b) => V3(a.x + b.x, a.y + b.y, a.z + b.z);
const sub3 = (a, b) => V3(a.x - b.x, a.y - b.y, a.z - b.z);
const mul3 = (a, k) => V3(a.x * k, a.y * k, a.z * k);
const dot3 = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross3 = (a, b) => V3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const len3 = (a) => Math.hypot(a.x, a.y, a.z);
const nrm3 = (a) => { const l = len3(a) || 1; return V3(a.x / l, a.y / l, a.z / l); };
const LIGHT3 = nrm3(V3(-0.45, -0.65, 0.62));

const ok = (v) => typeof v === 'number' && Number.isFinite(v);
const fin = (p) => p && ok(p.x) && ok(p.y);

// ------------------------------------------------------------------ colour

const C = (h, s, l) => ({ h: ((h % 360) + 360) % 360, s: clamp(s, 0, 100), l: clamp(l, 0, 100) });
const lighten = (c, k) => C(c.h, c.s, c.l + (100 - c.l) * k);
const darken = (c, k) => C(c.h, c.s, c.l * (1 - k));
const desat = (c, k) => C(c.h, c.s * (1 - k), c.l);
const css = (c, a = 1) => hslString(c, a);
// Antique, slightly faded watercolour: a little less saturation, a little more light.
const aged = (c) => C(c.h, c.s * 0.82, c.l + (100 - c.l) * 0.1);

// ------------------------------------------------------------------ polylines

function cumLen(pts) {
  const c = new Float64Array(pts.length);
  for (let i = 1; i < pts.length; i++) c[i] = c[i - 1] + dist(pts[i - 1], pts[i]);
  return c;
}

function resample(pts, step) {
  if (pts.length < 2) return pts.slice();
  const cl = cumLen(pts), L = cl[cl.length - 1];
  if (!(L > 0)) return [pts[0], pts[pts.length - 1]];
  const n = Math.max(1, Math.ceil(L / step));
  const out = [];
  let j = 0;
  for (let i = 0; i <= n; i++) {
    const s = (L * i) / n;
    while (j < cl.length - 2 && cl[j + 1] < s) j++;
    const seg = cl[j + 1] - cl[j] || 1;
    out.push(lerpP(pts[j], pts[j + 1], clamp((s - cl[j]) / seg, 0, 1)));
  }
  return out;
}

// Point and tangent at arc-length fraction t of a polyline.
function along(pts, t, cl) {
  cl = cl || cumLen(pts);
  const L = cl[cl.length - 1];
  const s = clamp(t, 0, 1) * L;
  let j = 0;
  while (j < cl.length - 2 && cl[j + 1] < s) j++;
  const seg = cl[j + 1] - cl[j] || 1;
  const p = lerpP(pts[j], pts[j + 1], clamp((s - cl[j]) / seg, 0, 1));
  const tan = nrm(sub(pts[Math.min(j + 1, pts.length - 1)], pts[j]));
  return { p, tan, i: j };
}

// Catmull-Rom through control points.
function spline(ctrl, per = 8) {
  if (ctrl.length < 3) return ctrl.slice();
  const out = [];
  for (let i = 0; i < ctrl.length - 1; i++) {
    const p0 = ctrl[Math.max(0, i - 1)], p1 = ctrl[i], p2 = ctrl[i + 1], p3 = ctrl[Math.min(ctrl.length - 1, i + 2)];
    for (let k = 0; k < per; k++) {
      const t = k / per, t2 = t * t, t3 = t2 * t;
      out.push(P(
        0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3)));
    }
  }
  out.push(ctrl[ctrl.length - 1]);
  return out;
}

// A smooth 1-D noise made of a few incommensurate sines: f(s) in about [-1, 1].
function wobble(rng, wl = 30) {
  const k = [], ph = [], a = [];
  for (let i = 0; i < 3; i++) { k.push(TAU / (wl * rng.float(0.6, 1.5) / (i + 1))); ph.push(rng.float(0, TAU)); a.push(1 / (i + 1.4)); }
  return (s) => (Math.sin(s * k[0] + ph[0]) * a[0] + Math.sin(s * k[1] + ph[1]) * a[1] + Math.sin(s * k[2] + ph[2]) * a[2]) * 0.85;
}

// Hand tremor: offset points sideways by a smooth noise.
function tremble(pts, rng, amp, wl = 26) {
  if (amp <= 0 || pts.length < 3) return pts;
  const f = wobble(rng, wl);
  const cl = cumLen(pts);
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const n = perp(nrm(sub(b, a)));
    const e = Math.min(1, cl[i] / 6, (cl[cl.length - 1] - cl[i]) / 6);
    out.push(add(pts[i], mul(n, f(cl[i]) * amp * Math.max(0, e))));
  }
  return out;
}

function bboxOf(pts, pad = 0) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { if (p.x < x0) x0 = p.x; if (p.y < y0) y0 = p.y; if (p.x > x1) x1 = p.x; if (p.y > y1) y1 = p.y; }
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
}
const bbUnion = (a, b) => (!a ? b : !b ? a : { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });
const bbHit = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

function polyArea(poly) {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j].x * poly[i].y - poly[i].x * poly[j].y);
  return a / 2;
}
function centroid(poly) {
  let x = 0, y = 0;
  for (const p of poly) { x += p.x; y += p.y; }
  return P(x / poly.length, y / poly.length);
}
function inPoly(p, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}

// Push each vertex outward by d (approximate polygon offset).
function dilate(poly, d) {
  const s = polyArea(poly) > 0 ? 1 : -1, n = poly.length, out = [];
  for (let i = 0; i < n; i++) {
    const a = poly[(i - 1 + n) % n], b = poly[i], c = poly[(i + 1) % n];
    const n1 = perp(nrm(sub(b, a))), n2 = perp(nrm(sub(c, b)));
    const m = nrm(add(n1, n2));
    out.push(add(b, mul(m, -d * s)));
  }
  return out;
}

// Parallel hatch lines at angle `ang`, spacing `sp`, clipped to polygon: [[a,b], ...]
function hatchPoly(poly, ang, sp, phase = 0) {
  const c = Math.cos(-ang), s = Math.sin(-ang);
  const r = poly.map((p) => P(p.x * c - p.y * s, p.x * s + p.y * c));
  let y0 = Infinity, y1 = -Infinity;
  for (const p of r) { if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; }
  const out = [], ci = Math.cos(ang), si = Math.sin(ang);
  const back = (x, y) => P(x * ci - y * si, x * si + y * ci);
  for (let y = Math.floor(y0 / sp) * sp + ((phase % 1) + 1) % 1 * sp; y < y1; y += sp) {
    const xs = [];
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const a = r[i], b = r[j];
      if ((a.y > y) !== (b.y > y)) xs.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
    }
    xs.sort((m, n) => m - n);
    for (let k = 0; k + 1 < xs.length; k += 2) if (xs[k + 1] - xs[k] > 0.8) out.push([back(xs[k], y), back(xs[k + 1], y)]);
  }
  return out;
}


function ellipsePts(c, rx, ry, rot = 0, n = 36, a0 = 0, a1 = TAU) {
  const out = [], cr = Math.cos(rot), sr = Math.sin(rot);
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n, x = Math.cos(a) * rx, y = Math.sin(a) * ry;
    out.push(P(c.x + x * cr - y * sr, c.y + x * sr + y * cr));
  }
  return out;
}

// ------------------------------------------------------------------ strokes
//
// A stroke is a polyline with a width per point. Widths swell on the side of a
// shape turned away from the light and taper at the ends — the burin's line.

function mkStroke(pts, o = {}) {
  if (!pts || pts.length < 2) return null;
  for (const p of pts) if (!fin(p)) return null;
  const step = o.step || 2.2;
  let q = resample(pts, step);
  if (o.rng && o.jit !== 0) q = tremble(q, o.rng, o.jit == null ? 0.35 : o.jit, o.wl || 24);
  const n = q.length;
  if (n < 2) return null;
  const cl = cumLen(q), L = cl[n - 1];
  if (!(L > 0.3)) return null;
  const w = new Float32Array(n);
  const base = o.w == null ? 1 : o.w;
  const ta = o.taper == null ? 0.18 : o.taper;            // fraction of length tapered at the start
  const tb = o.taperEnd == null ? ta : o.taperEnd;        // ... and at the end
  const minW = o.minW == null ? 0.28 : o.minW;
  for (let i = 0; i < n; i++) {
    const t = cl[i] / L;
    let f = 1;
    if (ta > 0) f *= Math.pow(clamp(t / ta, 0, 1), 0.55);
    if (tb > 0) f *= Math.pow(clamp((1 - t) / tb, 0, 1), 0.55);
    let sh = 1;
    if (o.center && o.shade) {
      const a = q[Math.max(0, i - 1)], b = q[Math.min(n - 1, i + 1)];
      let nn = perp(nrm(sub(b, a)));
      if (dot(nn, sub(q[i], o.center)) < 0) nn = mul(nn, -1);
      sh = 1 + o.shade * dot(nn, SHADOW);
    } else if (o.side && o.shade) {
      const a = q[Math.max(0, i - 1)], b = q[Math.min(n - 1, i + 1)];
      sh = 1 + o.shade * dot(mul(perp(nrm(sub(b, a))), o.side), SHADOW);
    }
    if (o.wfn) f *= o.wfn(t, q[i]);
    w[i] = Math.max(minW, base * f * Math.max(0.35, sh));
  }
  return { pts: q, w, cl, len: L, color: o.color || null };
}

// A simple constant-width hatch stroke (cheap, no resampling).
function mkHatch(a, b, w = 0.5, color = null, mid = null) {
  if (!fin(a) || !fin(b)) return null;
  const pts = mid ? [a, mid, b] : [a, b];
  const cl = cumLen(pts), L = cl[cl.length - 1];
  if (!(L > 0.4)) return null;
  return { pts, w: new Float32Array(pts.map(() => w)), cl, len: L, color, hatch: true };
}

// Draw arc-length range [s0, s1] of a stroke into ctx (logical coords).
function drawStroke(ctx, st, s0 = 0, s1 = Infinity, widen = 0, color = null) {
  const { pts, w, cl } = st;
  const n = pts.length;
  s1 = Math.min(s1, st.len);
  if (s1 <= s0) return;
  ctx.strokeStyle = color || st.color || INK;
  let i = 0;
  while (i < n - 2 && cl[i + 1] <= s0) i++;
  const at = (k, s) => { const seg = cl[k + 1] - cl[k] || 1, t = clamp((s - cl[k]) / seg, 0, 1); return [lerp(pts[k].x, pts[k + 1].x, t), lerp(pts[k].y, pts[k + 1].y, t), lerp(w[k], w[k + 1], t)]; };
  let [x, y, ww] = at(i, s0);
  let curW = Math.round((ww + widen) * 10) / 10;
  ctx.lineWidth = curW;
  ctx.beginPath();
  ctx.moveTo(x, y);
  for (; i < n - 1; i++) {
    const end = Math.min(cl[i + 1], s1);
    const [ex, ey, ew] = at(i, end);
    const qw = Math.round((((ww + ew) / 2) + widen) * 10) / 10;
    if (qw !== curW) {
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineWidth = curW = qw;
    }
    ctx.lineTo(ex, ey);
    x = ex; y = ey; ww = ew;
    if (cl[i + 1] >= s1) break;
  }
  ctx.stroke();
}

function tracePoly(ctx, poly, close = true) {
  ctx.moveTo(poly[0].x, poly[0].y);
  for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
  if (close) ctx.closePath();
}

function drawDots(ctx, d, i0 = 0, i1 = Infinity, widen = 0) {
  const arr = d.pts;
  i1 = Math.min(i1, arr.length);
  if (i1 <= i0) return;
  ctx.fillStyle = d.color || INK;
  ctx.beginPath();
  for (let i = i0; i < i1; i++) {
    const p = arr[i];
    const r = p.r + widen;
    ctx.moveTo(p.x + r, p.y);
    ctx.arc(p.x, p.y, r, 0, TAU);
  }
  ctx.fill();
}

// ------------------------------------------------------------------ watercolour

let GRAIN = null; // shared pigment-granulation tile, made once

function grainTile() {
  if (GRAIN) return GRAIN;
  const n = 192, c = document.createElement('canvas');
  c.width = c.height = n;
  const x = c.getContext('2d'), img = x.createImageData(n, n), r = makeRng(1234567);
  // value noise, two octaves, plus single-pixel speckle
  const grid = (g) => { const a = []; for (let i = 0; i < (g + 1) * (g + 1); i++) a.push(r.next()); return a; };
  const g1 = 64, g2 = 96, A = grid(g1), B = grid(g2);
  const samp = (G, g, u, v) => {
    const fx = (u / n) * g, fy = (v / n) * g, ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
    const at = (i, j) => G[((j % g) * (g + 1)) + (i % g)];
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    return lerp(lerp(at(ix, iy), at(ix + 1, iy), sx), lerp(at(ix, iy + 1), at(ix + 1, iy + 1), sx), sy);
  };
  for (let v = 0; v < n; v++) for (let u = 0; u < n; u++) {
    const val = samp(A, g1, u, v) * 0.3 + samp(B, g2, u, v) * 0.3 + r.next() * 0.4;
    const a = clamp((val - 0.5) * 2.6, 0, 1);
    const k = (v * n + u) * 4;
    img.data[k] = img.data[k + 1] = img.data[k + 2] = 0;
    img.data[k + 3] = Math.round(a * 255);
  }
  x.putImageData(img, 0, 0);
  GRAIN = c;
  return c;
}

// Deform a polygon's outline with smooth noise (the wet edge never follows the line exactly).
function wetEdge(poly, rng, amp, off) {
  const f = wobble(rng, 22), g = wobble(rng, 9);
  const cl = cumLen(poly);
  const c = centroid(poly);
  return poly.map((p, i) => {
    const d = nrm(sub(p, c));
    const k = f(cl[i]) * amp + g(cl[i]) * amp * 0.35;
    return P(p.x + d.x * k + off.x, p.y + d.y * k + off.y);
  });
}

// Paint one wash onto the wash layer. The layer is composited onto the paper with
// 'multiply', so washes are translucent glazes; overlapping glazes deepen.
//   w = { poly | polys, color, alpha, shade: {color, from, to}, edge, blots, holes, hard }
function paintWash(ctx, w, rng) {
  const polys = w.polys || [w.poly];
  for (const poly of polys) {
    if (!poly || poly.length < 3 || !poly.every(fin)) continue;
    const per = cumLen(poly.concat([poly[0]]));
    const size = Math.max(3, (4 * Math.abs(polyArea(poly))) / (per[per.length - 1] || 1));
    const alpha = w.alpha == null ? 0.7 : w.alpha;
    const base = w.color;
    const fill = (c) => {
      if (w.radial) {
        const q = w.radial;
        const g = ctx.createRadialGradient(q.c.x, q.c.y, q.r0 || 0, q.c.x, q.c.y, q.r1);
        for (const [t, col, a] of q.stops) g.addColorStop(clamp(t, 0, 1), css(col, a == null ? 1 : a));
        return g;
      }
      if (w.shade) {
        const g = ctx.createLinearGradient(w.shade.from.x, w.shade.from.y, w.shade.to.x, w.shade.to.y);
        const stops = w.shade.stops || [[0, base], [1, w.shade.color]];
        for (const [t, col, a] of stops) g.addColorStop(clamp(t, 0, 1), css(col, a == null ? 1 : a));
        return g;
      }
      return css(c || base);
    };
    const amp = w.hard ? 0.25 : clamp(size * 0.018, 0.35, 2.4);
    const mis = w.hard ? 0.2 : clamp(size * 0.03, 0.3, 1.6);
    const off = P(rng.float(-mis, mis), rng.float(-mis, mis));
    const p1 = wetEdge(poly, rng, amp, off);
    const holes = w.holes || [];
    const path = (pp) => { ctx.beginPath(); tracePoly(ctx, pp); for (const h of holes) tracePoly(ctx, h); };
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = fill();
    ctx.globalAlpha = alpha * 0.78;
    path(p1); ctx.fill('evenodd');
    if (!w.hard) {
      const p2 = wetEdge(dilate(poly, -Math.min(2.2, size * 0.04)), rng, amp * 1.4, P(off.x * -0.6 + rng.float(-0.5, 0.5), off.y * -0.6 + rng.float(-0.5, 0.5)));
      ctx.globalAlpha = alpha * 0.32;
      path(p2); ctx.fill('evenodd');
    }
    // pooled, darker edge where the pigment dried
    const edge = w.edge == null ? 1 : w.edge;
    if (edge > 0 && size > 5) {
      ctx.save();
      path(p1); ctx.clip('evenodd');
      ctx.strokeStyle = css(darken(base, 0.18));
      ctx.lineJoin = 'round';
      ctx.globalAlpha = alpha * 0.22 * edge;
      ctx.lineWidth = clamp(size * 0.07, 1.4, 5);
      ctx.beginPath(); tracePoly(ctx, p1); ctx.stroke();
      ctx.globalAlpha = alpha * 0.28 * edge;
      ctx.lineWidth = clamp(size * 0.02, 0.6, 1.4);
      ctx.beginPath(); tracePoly(ctx, p1); ctx.stroke();
      // tonal blots: uneven pigment within the shape
      const nb = w.blots == null ? Math.min(4, Math.floor(size / 18)) : w.blots;
      for (let i = 0; i < nb; i++) {
        const q = poly[Math.floor(rng.next() * poly.length)];
        const cc = lerpP(q, centroid(poly), rng.float(0.2, 0.8));
        const r = size * rng.float(0.2, 0.5);
        const g = ctx.createRadialGradient(cc.x, cc.y, 0, cc.x, cc.y, r);
        const col = rng.chance(0.5) ? darken(base, 0.12) : C(base.h + rng.float(-10, 10), base.s, base.l);
        g.addColorStop(0, css(col, 0.5)); g.addColorStop(1, css(col, 0));
        ctx.globalAlpha = alpha * 0.45;
        ctx.fillStyle = g;
        ctx.fillRect(cc.x - r, cc.y - r, r * 2, r * 2);
      }
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
}

// ------------------------------------------------------------------ paper

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
  return c;
}

function makePaper(res, rng) {
  const cv = makeCanvas(LW * res, LH * res);
  const x = cv.getContext('2d');
  x.setTransform(res, 0, 0, res, 0, 0);
  // base tone, slightly different for every sheet
  const tone = C(40 + rng.float(-3, 3), 52 + rng.float(-8, 6), 87.5 + rng.float(-1.5, 1));
  x.fillStyle = css(tone);
  x.fillRect(0, 0, LW, LH);
  // broad, cloudy unevenness of the sheet
  for (let i = 0; i < 14; i++) {
    const c = P(rng.float(0, LW), rng.float(0, LH)), r = rng.float(150, 500);
    const g = x.createRadialGradient(c.x, c.y, 0, c.x, c.y, r);
    const warm = rng.chance(0.55);
    g.addColorStop(0, warm ? 'rgba(170,130,70,0.05)' : 'rgba(255,252,240,0.09)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = g; x.fillRect(c.x - r, c.y - r, 2 * r, 2 * r);
  }
  // laid lines and chain lines
  x.globalAlpha = 1;
  x.strokeStyle = 'rgba(120,95,60,0.022)';
  x.lineWidth = 0.8;
  x.beginPath();
  for (let y = 2; y < LH; y += 3.1) { x.moveTo(0, y + rng.float(-0.2, 0.2)); x.lineTo(LW, y + rng.float(-0.4, 0.4)); }
  x.stroke();
  x.strokeStyle = 'rgba(120,95,60,0.035)';
  x.lineWidth = 1.6;
  x.beginPath();
  const cx0 = rng.float(0, 70);
  for (let cx = cx0; cx < LW; cx += 72) { x.moveTo(cx, 0); x.bezierCurveTo(cx + 2, LH * 0.3, cx - 2, LH * 0.7, cx + 1, LH); }
  x.stroke();
  // fibres
  for (let i = 0; i < 520; i++) {
    const p = P(rng.float(0, LW), rng.float(0, LH)), a = rng.float(0, TAU), l = rng.float(3, 14);
    const q = add(p, dirOf(a, l)), m = add(lerpP(p, q, 0.5), dirOf(a + 1.57, rng.float(-2, 2)));
    x.strokeStyle = rng.chance(0.7) ? `rgba(110,85,50,${rng.float(0.04, 0.1).toFixed(3)})` : `rgba(255,253,245,${rng.float(0.15, 0.35).toFixed(3)})`;
    x.lineWidth = rng.float(0.3, 0.7);
    x.beginPath(); x.moveTo(p.x, p.y); x.quadraticCurveTo(m.x, m.y, q.x, q.y); x.stroke();
  }
  // grain (pixel-level noise, device resolution)
  const tile = grainTile();
  x.save();
  x.setTransform(1, 0, 0, 1, 0, 0);
  const pat = x.createPattern(tile, 'repeat');
  x.globalAlpha = 0.055;
  x.fillStyle = pat;
  x.translate(rng.float(0, 190), rng.float(0, 190));
  x.fillRect(-200, -200, cv.width + 400, cv.height + 400);
  x.restore();
  // foxing: small rusty spots, more of them near the edges
  const nf = rng.int(3, 11);
  for (let i = 0; i < nf; i++) {
    const edge = rng.chance(0.65);
    const p = edge ? P(rng.chance(0.5) ? rng.float(10, 140) : rng.float(860, 990), rng.float(20, 1380)) : P(rng.float(80, 920), rng.float(80, 1320));
    const r = rng.float(1.5, edge ? 9 : 5);
    for (let k = 0; k < 4; k++) {
      const q = add(p, P(rng.float(-r, r) * 0.6, rng.float(-r, r) * 0.6)), rr = r * rng.float(0.4, 1);
      const g = x.createRadialGradient(q.x, q.y, 0, q.x, q.y, rr);
      g.addColorStop(0, `rgba(150,95,40,${rng.float(0.08, 0.2).toFixed(3)})`);
      g.addColorStop(0.6, 'rgba(160,105,50,0.05)');
      g.addColorStop(1, 'rgba(160,105,50,0)');
      x.fillStyle = g; x.fillRect(q.x - rr, q.y - rr, rr * 2, rr * 2);
    }
    if (rng.chance(0.5)) { x.fillStyle = 'rgba(120,70,30,0.18)'; x.beginPath(); x.arc(p.x, p.y, rng.float(0.5, 1.2), 0, TAU); x.fill(); }
  }
  // the plate-mark: the sheet inside it was pressed smooth against the copper and
  // holds a faint plate tone; its edge is a bevelled, embossed line.
  const pm = PLATE, rr = 7;
  const rrect = (x0, y0, x1, y1, r) => {
    x.beginPath();
    x.moveTo(x0 + r, y0); x.lineTo(x1 - r, y0); x.quadraticCurveTo(x1, y0, x1, y0 + r);
    x.lineTo(x1, y1 - r); x.quadraticCurveTo(x1, y1, x1 - r, y1); x.lineTo(x0 + r, y1);
    x.quadraticCurveTo(x0, y1, x0, y1 - r); x.lineTo(x0, y0 + r); x.quadraticCurveTo(x0, y0, x0 + r, y0); x.closePath();
  };
  x.fillStyle = 'rgba(120,96,60,0.035)';
  rrect(pm.x0, pm.y0, pm.x1, pm.y1, rr); x.fill();
  // inner shadow along the bevel
  x.save();
  rrect(pm.x0, pm.y0, pm.x1, pm.y1, rr); x.clip();
  x.strokeStyle = 'rgba(95,70,40,0.07)'; x.lineWidth = 6;
  rrect(pm.x0, pm.y0, pm.x1, pm.y1, rr); x.stroke();
  x.restore();
  x.lineWidth = 1.1;
  x.strokeStyle = 'rgba(255,252,244,0.75)';
  rrect(pm.x0 - 1.4, pm.y0 - 1.4, pm.x1 + 1.4, pm.y1 + 1.4, rr + 1); x.stroke();
  x.strokeStyle = 'rgba(90,66,38,0.32)';
  x.lineWidth = 0.9;
  rrect(pm.x0, pm.y0, pm.x1, pm.y1, rr); x.stroke();
  x.strokeStyle = 'rgba(90,66,38,0.1)';
  x.lineWidth = 2.5;
  x.beginPath(); x.moveTo(pm.x0 + rr, pm.y1 + 1.5); x.lineTo(pm.x1 - rr, pm.y1 + 1.5); x.moveTo(pm.x1 + 1.5, pm.y0 + rr); x.lineTo(pm.x1 + 1.5, pm.y1 - rr); x.stroke();
  // toned, darker sheet edges and a soft vignette
  const vg = x.createRadialGradient(LW / 2, LH / 2, LH * 0.36, LW / 2, LH / 2, LH * 0.78);
  vg.addColorStop(0, 'rgba(120,85,40,0)');
  vg.addColorStop(1, 'rgba(120,85,40,0.2)');
  x.fillStyle = vg; x.fillRect(0, 0, LW, LH);
  const band = 26;
  const edges = [[0, 0, LW, band, 0, 0, 0, band], [0, LH - band, LW, band, 0, LH, 0, LH - band], [0, 0, band, LH, 0, 0, band, 0], [LW - band, 0, band, LH, LW, 0, LW - band, 0]];
  for (const [ex, ey, ew, eh, gx0, gy0, gx1, gy1] of edges) {
    const g = x.createLinearGradient(gx0, gy0, gx1, gy1);
    g.addColorStop(0, 'rgba(130,90,45,0.16)'); g.addColorStop(1, 'rgba(130,90,45,0)');
    x.fillStyle = g; x.fillRect(ex, ey, ew, eh);
  }
  return cv;
}

// ------------------------------------------------------------------ items
//
// item = { z, occ: [poly]|null, washes: [], lines: [stroke], hatch: [stroke],
//          dots: [{pts:[{x,y,r}], color}], fills: [{poly, color}], phase, key, origin }

function mkItem(z, phase, key, o = {}) {
  return { z, phase, key, occ: null, washes: [], lines: [], hatch: [], dots: [], fills: [], origin: null, ...o };
}
const pushS = (arr, s) => { if (s) arr.push(s); return s; };

function itemBBox(it) {
  let bb = null;
  const grow = (pts, pad) => { if (pts && pts.length) bb = bbUnion(bb, bboxOf(pts, pad)); };
  for (const s of it.lines) grow(s.pts, 3);
  for (const s of it.hatch) grow(s.pts, 2);
  for (const d of it.dots) grow(d.pts, 2);
  for (const f of it.fills) grow(f.poly, 2);
  for (const w of it.washes) for (const p of (w.polys || [w.poly])) grow(p, 6);
  if (it.occ) for (const p of it.occ) grow(p, 1);
  return bb;
}

// Paint all items, in z order, into the finished wash and ink layers.
function paintLayers(items, wctx, ictx, rng) {
  const order = items.map((it, i) => [it, i]).sort((a, b) => a[0].z - b[0].z || a[1] - b[1]);
  ictx.lineCap = 'round'; ictx.lineJoin = 'round';
  for (const [it] of order) {
    if (it.occ) {
      for (const poly of it.occ) {
        if (!poly || poly.length < 3) continue;
        for (const c of [wctx, ictx]) {
          c.globalCompositeOperation = 'destination-out';
          c.fillStyle = '#000';
          c.beginPath(); tracePoly(c, poly); c.fill();
          c.globalCompositeOperation = 'source-over';
        }
      }
    }
    for (const w of it.washes) paintWash(wctx, w, rng);
    for (const f of it.fills) {
      if (!f.poly || f.poly.length < 3) continue;
      ictx.fillStyle = f.color || INK; ictx.beginPath(); tracePoly(ictx, f.poly); ictx.fill();
    }
    for (const s of it.lines) drawStroke(ictx, s);
    for (const s of it.hatch) drawStroke(ictx, s);
    for (const d of it.dots) drawDots(ictx, d);
  }
  // pigment granulation over the whole colouring
  const tile = grainTile();
  wctx.save();
  wctx.setTransform(1, 0, 0, 1, 0, 0);
  wctx.globalCompositeOperation = 'destination-out';
  wctx.globalAlpha = 0.16;
  wctx.fillStyle = wctx.createPattern(tile, 'repeat');
  wctx.translate(rng.float(0, 100), rng.float(0, 100));
  wctx.fillRect(-120, -120, wctx.canvas.width + 240, wctx.canvas.height + 240);
  wctx.restore();
}

// ------------------------------------------------------------------ lettering

function textFont(t) { return `${t.italic ? 'italic ' : ''}${t.size}px ${FONT}`; }

function measureRuns(ctx, t) {
  let w = 0;
  for (const r of t.runs) { ctx.font = textFont({ ...t, ...r }); w += ctx.measureText(r.str).width; }
  return w;
}

function drawTexts(ctx, texts) {
  ctx.save();
  ctx.textBaseline = 'alphabetic';
  for (let t of texts) {
    let w = measureRuns(ctx, t);
    if (t.maxW && w > t.maxW) {
      const k = t.maxW / w;
      const orig = t;
      t = { ...t, size: t.size * k, runs: t.runs.map((r) => ({ ...r, size: r.size ? r.size * k : undefined })) };
      w = measureRuns(ctx, t);
      orig.bb = null;
      Object.defineProperty(t, '_orig', { value: orig });
    }
    let x = t.align === 'center' ? t.x - w / 2 : t.align === 'right' ? t.x - w : t.x;
    t.bb = { x0: x - 3, y0: t.y - t.size * 0.95, x1: x + w + 3, y1: t.y + t.size * 0.35 };
    if (t._orig) t._orig.bb = t.bb;
    for (const r of t.runs) {
      ctx.font = textFont({ ...t, ...r });
      ctx.fillStyle = r.color || INK;
      ctx.fillText(r.str, x, t.y);
      x += ctx.measureText(r.str).width;
    }
  }
  ctx.restore();
}

function estimateTextBB(t) {
  const n = t.runs.reduce((a, r) => a + r.str.length, 0);
  const w = n * t.size * 0.48 + 8;
  const x = t.align === 'center' ? t.x - w / 2 : t.align === 'right' ? t.x - w : t.x;
  return { x0: x - 4, y0: t.y - t.size * 0.95, x1: x + w + 4, y1: t.y + t.size * 0.35 };
}

function fellLoaded() {
  try {
    if (!document.fonts) return true;
    let it = false, ro = false;
    document.fonts.forEach((f) => {
      if (/IM Fell English$/i.test(f.family.replace(/["']/g, '')) && f.status === 'loaded') {
        if (f.style === 'italic') it = true; else ro = true;
      }
    });
    return it && ro;
  } catch (e) { return true; }
}

function whenFontsReady() {
  if (typeof document === 'undefined' || !document.fonts) return Promise.resolve();
  const loads = Promise.all([
    document.fonts.load(`italic 28px "IM Fell English"`).catch(() => null),
    document.fonts.load(`28px "IM Fell English"`).catch(() => null),
  ]).then(() => document.fonts.ready).catch(() => null);
  return Promise.race([loads, new Promise((r) => setTimeout(r, 1500))]);
}

// ------------------------------------------------------------------ timeline

function rangeBB(st, s0, s1, pad) {
  const { pts, cl } = st;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  let i = 0;
  while (i < pts.length - 1 && cl[i + 1] < s0) i++;
  for (; i < pts.length; i++) {
    const p = pts[i];
    if (p.x < x0) x0 = p.x; if (p.y < y0) y0 = p.y; if (p.x > x1) x1 = p.x; if (p.y > y1) y1 = p.y;
    if (cl[i] > s1) break;
  }
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
}

function buildTimeline(items, texts, duration) {
  const order = items.map((it, i) => [it, i]).sort((a, b) => a[0].phase - b[0].phase || a[0].key - b[0].key || a[1] - b[1]).map((a) => a[0]);
  let O = 0, Hl = 0;
  for (const it of items) {
    for (const s of it.lines) O += s.len;
    for (const s of it.hatch) Hl += s.len;
    for (const d of it.dots) Hl += d.pts.length * 1.4;
  }
  const hf = clamp((O + 1) / (Hl + 1), 0.08, 1.5);
  let T = 0, Hc = 0;
  const strokes = [], dots = [], washes = [];
  for (const it of order) {
    const start = T;
    for (const s of it.lines) { strokes.push({ it, s, a0: T, a1: T + s.len, done: 0 }); T += s.len + 3; }
    const outEnd = T;
    let h = Math.max(Hc, start + (outEnd - start) * 0.6);
    for (const s of it.hatch) { const d = Math.max(1.5, s.len * hf); strokes.push({ it, s, a0: h, a1: h + d, done: 0 }); h += d * 0.8; }
    for (const d of it.dots) { const du = Math.max(2, d.pts.length * 1.4 * hf); dots.push({ it, d, a0: h, a1: h + du, done: 0 }); h += du; }
    for (const f of it.fills) dots.push({ it, f, a0: outEnd, a1: outEnd + 4, done: 0 });
    Hc = Math.max(Hc, h);
    it._a = start; it._ao = outEnd;
    T += it.lines.length ? 6 : 1;
  }
  const A = Math.max(1, T, Hc);
  const bloom = Math.min(650, duration * 0.08);
  const mainEnd = duration * 0.83 - bloom;
  const k = mainEnd / A;
  for (const e of strokes) { e.t0 = e.a0 * k; e.t1 = Math.max(e.t0 + 4, e.a1 * k); }
  for (const e of dots) { e.t0 = e.a0 * k; e.t1 = Math.max(e.t0 + 4, e.a1 * k); }
  for (const it of order) {
    for (const w of it.washes) {
      const polys = (w.polys || [w.poly]).filter((p) => p && p.length > 2);
      if (!polys.length) continue;
      if (w.sweep && w.sweep.pts.length > 1) {
        const sp = w.sweep.pts, cl = cumLen(sp);
        const st = { pts: sp, w: new Float32Array(sp.length).fill(w.sweep.w), cl, len: cl[cl.length - 1] };
        const ta = it._a * k + 120, tb = Math.max(ta + bloom, it._ao * k + bloom * 0.5);
        washes.push({ it, sweep: st, bb: bboxOf(sp, w.sweep.w), t0: ta, t1: tb, done: 0 });
        continue;
      }
      const t0 = (it.lines.length ? it._ao * k + 60 : it._a * k) + (w.delay || 0) * bloom;
      const masks = polys.map((p) => (w.glow ? p : dilate(p, 3.4)));
      let bb = null;
      for (const m of masks) bb = bbUnion(bb, bboxOf(m, 2));
      const origin = w.origin || it.origin || centroid(polys[0]);
      let maxR = 0;
      for (const m of masks) for (const p of m) maxR = Math.max(maxR, dist(p, origin));
      washes.push({ it, masks, bb, origin, maxR, t0, t1: t0 + bloom * (w.glow ? 1.6 : 1) });
    }
  }
  strokes.sort((a, b) => a.t0 - b.t0);
  dots.sort((a, b) => a.t0 - b.t0);
  washes.sort((a, b) => a.t0 - b.t0);
  // lettering, last: each line of text engraved left to right in turn
  const tStart = duration * 0.85, tEnd = duration * 0.975;
  const tl = [];
  let tw = 0;
  for (const t of texts) { const bb = estimateTextBB(t); tl.push({ t, bb }); tw += bb.x1 - bb.x0 + 60; }
  let c = tStart;
  for (const e of tl) { const d = ((e.bb.x1 - e.bb.x0 + 60) / (tw || 1)) * (tEnd - tStart); e.t0 = c; e.t1 = c + d * 0.9; e.done = 0; c += d; }
  let end = tEnd;
  for (const e of strokes) end = Math.max(end, e.t1);
  for (const e of washes) end = Math.max(end, e.t1);
  return { strokes, dots, washes, texts: tl, end };
}

function occludersFor(items) {
  const occs = [];
  items.forEach((it, i) => { it._bb = itemBBox(it); it._i = i; if (it.occ) for (const p of it.occ) if (p && p.length > 2) occs.push({ it, i, poly: p, bb: bboxOf(p) }); });
  for (const it of items) {
    it.occluders = [];
    it.occludersD = [];
    if (!it._bb) continue;
    for (const o of occs) {
      if (o.it === it) continue;
      if (o.it.z < it.z || (o.it.z === it.z && o.i < it._i)) continue;
      if (bbHit(o.bb, it._bb)) {
        it.occluders.push(o);
        if (it.washes.length) {
          if (!o.dil) { o.dil = dilate(o.poly, 2.6); o.dbb = bboxOf(o.dil); }
          it.occludersD.push({ poly: o.dil, bb: o.dbb });
        }
      }
    }
  }
}

// Run fn with everything in front of `it` clipped away (only occluders touching `region`).
function withOcclusion(ctx, it, fn, wide = false, region = null) {
  const list = wide ? it.occludersD : it.occluders;
  if (!list || !list.length) { fn(); return; }
  let used = 0;
  for (const o of list) {
    if (region && !bbHit(o.bb, region)) continue;
    if (!used++) ctx.save();
    ctx.beginPath();
    ctx.rect(-50, -50, LW + 100, LH + 100);
    tracePoly(ctx, o.poly);
    ctx.clip('evenodd');
  }
  fn();
  if (used) ctx.restore();
}

// ------------------------------------------------------------------ public API

/**
 * Engrave the plate for `genome` onto `canvas`.
 * opts: { animate=true, resolution=1.6, caption:{latin,author,label,figures,del,sculp}, duration=9000, onDone }
 * Returns { finish(), cancel(), done: Promise<boolean>, flowerPoints: [{x,y,r}] } (logical 1000×1400 coords).
 *  - animate:false draws synchronously; only the lettering may follow (≤1.5 s) if the IM Fell
 *    faces are not loaded yet — await `done` before exporting the canvas to be sure.
 *  - done resolves true when the plate is complete (onDone is called then, asynchronously),
 *    false if cancel() stopped it or a new renderPlate() on the same canvas superseded it.
 *  - flowerPoints are available immediately: the visual centres and radii of the open flowers.
 */
export function renderPlate(canvas, genome, opts = {}) {
  const prev = ACTIVE.get(canvas);
  if (prev) { try { prev.cancel(); } catch (e) { /* ignore */ } }

  const animate = opts.animate !== false;
  const res = ok(opts.resolution) && opts.resolution > 0 ? opts.resolution : 1.6;
  const duration = ok(opts.duration) && opts.duration > 0 ? opts.duration : 9000;
  const caption = opts.caption || {};
  canvas.width = Math.round(LW * res);
  canvas.height = Math.round(LH * res);
  const dctx = canvas.getContext('2d');

  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  let state = 'running';           // running | finished | cancelled
  let raf = 0;
  const ctl = { finish: () => finish(), cancel: () => cancel(), done, flowerPoints: [] };
  ACTIVE.set(canvas, ctl);

  const rng = rngFor(genome, 'plate');
  const paper = makePaper(res, rng.fork('paper'));
  dctx.setTransform(1, 0, 0, 1, 0, 0);
  dctx.drawImage(paper, 0, 0);

  let plate;
  try { plate = composePlate(genome, rng, caption); }
  catch (e) { console.error('plate: composition failed', e); plate = { items: [], texts: [], flowerPoints: [] }; }
  ctl.flowerPoints = plate.flowerPoints || [];
  const { items, texts } = plate;

  // finished layers, painted once
  let washL = null, inkL = null, wctx = null, ictx = null, layersBuilt = false;
  let textDrawn = false;
  const buildLayers = () => {
    if (layersBuilt) return;
    washL = makeCanvas(canvas.width, canvas.height); inkL = makeCanvas(canvas.width, canvas.height);
    wctx = washL.getContext('2d'); ictx = inkL.getContext('2d');
    wctx.setTransform(res, 0, 0, res, 0, 0); ictx.setTransform(res, 0, 0, res, 0, 0);
    try { paintLayers(items, wctx, ictx, rng.fork('wash')); } catch (e) { console.error('plate: painting failed', e); }
    layersBuilt = true;
  };
  const drawLettering = () => {
    if (textDrawn || !layersBuilt) return;
    try { drawTexts(ictx, texts); } catch (e) { console.error(e); }
    textDrawn = true;
  };
  const INK_ALPHA = 0.93;
  const compositeAll = () => {
    dctx.setTransform(1, 0, 0, 1, 0, 0);
    dctx.globalCompositeOperation = 'source-over'; dctx.globalAlpha = 1;
    dctx.drawImage(paper, 0, 0);
    if (washL) { dctx.globalCompositeOperation = 'multiply'; dctx.drawImage(washL, 0, 0); }
    if (inkL) { dctx.globalCompositeOperation = 'source-over'; dctx.globalAlpha = INK_ALPHA; dctx.drawImage(inkL, 0, 0); }
    dctx.globalAlpha = 1; dctx.globalCompositeOperation = 'source-over';
  };
  const release = () => {
    for (const c of [washL, inkL, wmask, imask, tmp]) if (c) { c.width = 1; c.height = 1; }
    washL = inkL = wmask = imask = tmp = null;
  };
  const complete = () => {
    if (state !== 'running') return;
    state = 'finished';
    if (raf) cancelAnimationFrame(raf);
    compositeAll();
    release();
    resolveDone(true);
    // never call back before renderPlate has returned the controller
    if (typeof opts.onDone === 'function') Promise.resolve().then(() => { try { opts.onDone(); } catch (e) { console.error(e); } });
  };
  // Finish = jump to the complete plate (waiting only for the lettering's font).
  let fontWait = null;
  const finish = () => {
    if (state !== 'running') return;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    animating = false;
    buildLayers();
    if (fellLoaded()) { drawLettering(); complete(); return; }
    compositeAll();
    (fontWait || (fontWait = whenFontsReady())).then(() => { if (state === 'running') { drawLettering(); complete(); } });
  };
  const cancel = () => {
    if (state !== 'running') return;
    state = 'cancelled';
    animating = false;
    if (raf) cancelAnimationFrame(raf);
    release();
    if (ACTIVE.get(canvas) === ctl) ACTIVE.delete(canvas);
    resolveDone(false);
  };

  let animating = animate;
  let wmask = null, imask = null, tmp = null;
  if (!animate) { finish(); return ctl; }

  // ---------------- animated engraving
  let fontsSettled = false;
  fontWait = whenFontsReady();
  fontWait.then(() => { fontsSettled = true; if (state === 'running' && layersBuilt) drawLettering(); });
  const MS = 0.5;                                    // mask resolution relative to the canvas
  let tl = null, t0 = 0, wm = null, im = null, tc = null;
  let si = 0, di = 0, wi = 0;
  const activeS = [], activeD = [], activeW = [];

  const start = () => {
    if (state !== 'running' || !animating) return;
    buildLayers();
    if (fellLoaded() || fontsSettled) drawLettering();
    occludersFor(items);
    tl = buildTimeline(items, texts, duration);
    wmask = makeCanvas(canvas.width * MS, canvas.height * MS);
    imask = makeCanvas(canvas.width * MS, canvas.height * MS);
    tmp = makeCanvas(canvas.width, canvas.height);
    wm = wmask.getContext('2d'); im = imask.getContext('2d'); tc = tmp.getContext('2d');
    for (const m of [wm, im]) { m.setTransform(res * MS, 0, 0, res * MS, 0, 0); m.lineCap = 'round'; m.lineJoin = 'round'; m.fillStyle = '#fff'; m.strokeStyle = '#fff'; }
    t0 = performance.now();
    raf = requestAnimationFrame(frame);
  };

  const composite = (r) => {
    const W = canvas.width, H = canvas.height;
    const x0 = clamp(Math.floor(r.x0 * res) - 2, 0, W), y0 = clamp(Math.floor(r.y0 * res) - 2, 0, H);
    const x1 = clamp(Math.ceil(r.x1 * res) + 2, 0, W), y1 = clamp(Math.ceil(r.y1 * res) + 2, 0, H);
    const w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0) return;
    dctx.setTransform(1, 0, 0, 1, 0, 0);
    dctx.globalAlpha = 1; dctx.globalCompositeOperation = 'source-over';
    dctx.drawImage(paper, x0, y0, w, h, x0, y0, w, h);
    for (const [layer, mask, mode, alpha] of [[washL, wmask, 'multiply', 1], [inkL, imask, 'source-over', INK_ALPHA]]) {
      tc.save();
      tc.setTransform(1, 0, 0, 1, 0, 0);
      tc.beginPath(); tc.rect(x0, y0, w, h); tc.clip();
      tc.clearRect(x0, y0, w, h);
      tc.globalCompositeOperation = 'source-over';
      tc.drawImage(layer, x0, y0, w, h, x0, y0, w, h);
      tc.globalCompositeOperation = 'destination-in';
      tc.drawImage(mask, x0 * MS, y0 * MS, w * MS, h * MS, x0, y0, w, h);
      tc.restore();
      dctx.globalCompositeOperation = mode; dctx.globalAlpha = alpha;
      dctx.drawImage(tmp, x0, y0, w, h, x0, y0, w, h);
    }
    dctx.globalAlpha = 1; dctx.globalCompositeOperation = 'source-over';
  };

  const frame = (now) => {
    raf = 0;
    if (state !== 'running' || !animating) return;
    const t = now - t0;
    const dirty = [];
    // pen strokes
    while (si < tl.strokes.length && tl.strokes[si].t0 <= t) activeS.push(tl.strokes[si++]);
    const groups = new Map();
    for (let i = activeS.length - 1; i >= 0; i--) {
      const e = activeS[i];
      const u = clamp((t - e.t0) / (e.t1 - e.t0), 0, 1);
      const target = e.s.len * (e.s.hatch ? u : u * (2 - u) * 0.15 + u * 0.85);
      if (target > e.done) {
        let g = groups.get(e.it); if (!g) groups.set(e.it, (g = []));
        g.push([e, e.done, target]);
        e.done = target;
      }
      if (u >= 1) activeS.splice(i, 1);
    }
    for (const [it, list] of groups) {
      let reg = null;
      const rbs = list.map(([e, a, b]) => { const rb = rangeBB(e.s, a, b, 6); reg = bbUnion(reg, rb); return rb; });
      withOcclusion(im, it, () => {
        for (const [e, a, b] of list) drawStroke(im, e.s, Math.max(0, a - 1.5), b, 2.4, '#fff');
      }, false, reg);
      dirty.push(...rbs);
    }
    // stipple and solid fills
    while (di < tl.dots.length && tl.dots[di].t0 <= t) activeD.push(tl.dots[di++]);
    for (let i = activeD.length - 1; i >= 0; i--) {
      const e = activeD[i];
      const u = clamp((t - e.t0) / (e.t1 - e.t0), 0, 1);
      const dreg = e.f ? bboxOf(e.f.poly, 3) : (e.dbb || (e.dbb = bboxOf(e.d.pts, 3)));
      withOcclusion(im, e.it, () => {
        if (e.f) {
          if (u >= 1) { im.beginPath(); tracePoly(im, dilate(e.f.poly, 1.2)); im.fill(); dirty.push(bboxOf(e.f.poly, 4)); }
        } else {
          const n = Math.floor(e.d.pts.length * u);
          if (n > e.done) {
            drawDots(im, e.d, e.done, n, 1.3);
            const sl = e.d.pts.slice(e.done, n);
            dirty.push(bboxOf(sl, 4));
            e.done = n;
          }
        }
      }, false, dreg);
      if (u >= 1) activeD.splice(i, 1);
    }
    // washes blooming out from where the brush touched
    while (wi < tl.washes.length && tl.washes[wi].t0 <= t) activeW.push(tl.washes[wi++]);
    for (let i = activeW.length - 1; i >= 0; i--) {
      const e = activeW[i];
      const u = clamp((t - e.t0) / (e.t1 - e.t0), 0, 1);
      if (e.sweep) {
        const target = e.sweep.len * u;
        if (target > e.done) {
          const sb = rangeBB(e.sweep, e.done, target, e.sweep.w[0] / 2 + 4);
          dirty.push(sb);
          withOcclusion(wm, e.it, () => drawStroke(wm, e.sweep, Math.max(0, e.done - 2), target, 0, '#fff'), true, sb);
          e.done = target;
        }
        if (u >= 1) activeW.splice(i, 1);
        continue;
      }
      withOcclusion(wm, e.it, () => {
        wm.save();
        wm.beginPath();
        for (const m of e.masks) tracePoly(wm, m);
        wm.clip();
        if (u >= 1) { wm.fillStyle = '#fff'; wm.fillRect(e.bb.x0, e.bb.y0, e.bb.x1 - e.bb.x0, e.bb.y1 - e.bb.y0); }
        else {
          const soft = Math.min(18, e.maxR * 0.35 + 2);
          const r = soft + e.maxR * (1 - Math.pow(1 - u, 2.2));
          const g = wm.createRadialGradient(e.origin.x, e.origin.y, Math.max(0, r - soft), e.origin.x, e.origin.y, r);
          g.addColorStop(0, 'rgba(255,255,255,0.9)'); g.addColorStop(1, 'rgba(255,255,255,0)');
          wm.fillStyle = g;
          wm.fillRect(e.bb.x0, e.bb.y0, e.bb.x1 - e.bb.x0, e.bb.y1 - e.bb.y0);
        }
        wm.restore();
      }, true, e.bb);
      dirty.push(e.bb);
      if (u >= 1) activeW.splice(i, 1);
    }
    // lettering (needs the font; waits for it if necessary)
    if (textDrawn) {
      for (const e of tl.texts) {
        if (t < e.t0 || e.done >= 1) continue;
        const u = clamp((t - e.t0) / (e.t1 - e.t0), 0, 1);
        const bb = e.t.bb || e.bb;
        const xa = lerp(bb.x0, bb.x1, e.done), xb = lerp(bb.x0, bb.x1, u);
        if (xb > xa) {
          im.fillStyle = '#fff';
          im.fillRect(xa - 1, bb.y0 - 2, xb - xa + 2, bb.y1 - bb.y0 + 4);
          dirty.push({ x0: xa - 2, y0: bb.y0 - 3, x1: xb + 2, y1: bb.y1 + 3 });
        }
        e.done = u;
      }
    }
    // composite only what changed
    for (const r of mergeRects(dirty)) composite(r);
    const textsDone = textDrawn ? tl.texts.every((e) => e.done >= 1) : !texts.length;
    if (t >= tl.end && textsDone && si >= tl.strokes.length && !activeS.length && !activeW.length && wi >= tl.washes.length && di >= tl.dots.length && !activeD.length) {
      complete();
      return;
    }
    if (!textDrawn && t >= tl.end + 2500) { finish(); return; }
    raf = requestAnimationFrame(frame);
  };

  // Paper first; the engraving starts on the next frame.
  raf = requestAnimationFrame(() => { raf = 0; start(); });
  return ctl;
}

function mergeRects(rs) {
  const out = [];
  for (const r of rs) {
    if (!r || !ok(r.x0) || !ok(r.x1) || !ok(r.y0) || !ok(r.y1)) continue;
    let m = { ...r }, merged = true;
    while (merged) {
      merged = false;
      for (let i = 0; i < out.length; i++) {
        const o = out[i];
        const u = bbUnion(o, m);
        const area = (b) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
        if (area(u) <= (area(o) + area(m)) * 1.15 + 600) { out.splice(i, 1); m = u; merged = true; break; }
      }
    }
    out.push(m);
  }
  return out;
}

// ================================================================== the plant
//
// Structure is grown in "plant units" (roughly plate pixels at scale 1) with the
// base of the plant at the origin and up = -y. It is then fitted to the plate.

const rad = (d) => (d * Math.PI) / 180;
const wrapA = (a) => { while (a > Math.PI) a -= TAU; while (a < -Math.PI) a += TAU; return a; };
const UP = -Math.PI / 2, DOWN = Math.PI / 2;

const LEAF_LEN = { linear: 380, ensiform: 330, lanceolate: 165, ovate: 125, cordate: 118, orbicular: 82, peltate: 66,
  sagittate: 150, lobed: 160, palmate: 92, pinnate: 210, needle: 46, terete: 66 };
const LEAF_W = { linear: [0.03, 0.05], ensiform: [0.055, 0.08], lanceolate: [0.14, 0.21], ovate: [0.3, 0.38], cordate: [0.4, 0.47],
  orbicular: [0.5, 0.5], peltate: [1, 1], sagittate: [0.36, 0.44], lobed: [0.3, 0.38], palmate: [1, 1], pinnate: [0.26, 0.34],
  needle: [0.028, 0.04], terete: [0.075, 0.11] };
const PETIOLE = { linear: [0, 0], ensiform: [0, 0], lanceolate: [0.03, 0.14], ovate: [0.12, 0.3], cordate: [0.35, 0.75], orbicular: [0.5, 0.9],
  peltate: [0.9, 1.6], sagittate: [0.5, 1.1], lobed: [0.12, 0.3], palmate: [0.5, 1.0], pinnate: [0.08, 0.18], needle: [0, 0], terete: [0, 0.03] };

function growPath(r, start, ang0, L, o = {}) {
  const n = Math.max(6, Math.round(L / (o.step || 7)));
  const lean = o.lean || 0, sin = o.sin || 0, freq = o.freq || 1.2;
  const ph = r.float(0, TAU), ph2 = r.float(0, TAU), f2 = freq * r.float(1.7, 2.5);
  const base = Math.sin(ph) * sin + Math.sin(ph2) * sin * 0.35;
  const pts = [start];
  let p = start;
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    let a = ang0 + lean * Math.pow(t, o.leanPow || 1.4) + (Math.sin(ph + TAU * freq * t) * sin + Math.sin(ph2 + TAU * f2 * t) * sin * 0.35 - base);
    if (o.toward != null) a = a + wrapA(o.toward - a) * (o.towardK || 0.3) * t;
    p = add(p, dirOf(a, L / n));
    pts.push(p);
  }
  return pts;
}

function addStem(S, pts, w0, w1, z, kind, o = {}) {
  const st = { pts, w0, w1, z, kind, woody: !!o.woody, key: o.key == null ? 0 : o.key, color: o.color || null, cut: !!o.cut, armature: o.armature || 'none', thin: !!o.thin };
  S.stems.push(st);
  return st;
}

function leafDims(g, r, sizeF) {
  const shape = g.leaf.shape;
  const hk = clamp(Math.sqrt((1050 * clamp(g.stem.height, 0.15, 1.05)) / 620), 0.85, 1.3);
  const L = LEAF_LEN[shape] * (0.55 + 0.6 * clamp(g.leaf.size, 0.1, 1.2)) * sizeF * hk * r.float(0.88, 1.1);
  const wr = LEAF_W[shape];
  const W = (shape === 'peltate' || shape === 'palmate') ? L : L * r.float(wr[0], wr[1]) * (g.leaf.fleshy && shape !== 'terete' ? 1.12 : 1);
  const pr = PETIOLE[shape];
  const pet = L * r.float(pr[0], pr[1]);
  return { L, W, pet };
}

// A leaf on the plant: attach point, direction, size and how it is turned.
function addLeaf(S, g, r, at, ang, sizeF, o = {}) {
  const d = leafDims(g, r, sizeF);
  const fore = o.fore == null ? 1 : o.fore;        // foreshortening of the length
  const under = o.under != null ? o.under : r.chance(0.13);
  const f0 = (o.f == null ? r.float(0.62, 1) : o.f) * (under ? -1 : 1);
  const lf = {
    at, ang, L: d.L * fore, W: d.W, pet: (o.pet != null ? o.pet : d.pet) * Math.max(0.4, fore), shape: o.shape || g.leaf.shape,
    droop: o.droop != null ? o.droop : clamp(g.leaf.droop * r.float(0.6, 1.2), 0, 1),
    f0, twist: o.twist != null ? o.twist : (r.chance(0.2) ? r.float(0.62, 0.85) : r.float(0, 0.18)),
    z: o.z == null ? 20 : o.z, kind: o.kind || 'leaf', curl: r.float(-0.25, 0.25), petBend: r.float(-0.25, 0.25),
  };
  S.leaves.push(lf);
  return lf;
}

// The bent midrib of a leaf (shared by fitting and engraving).
function leafSpine(lf, base, n = 24) {
  const pts = [base];
  let a = lf.ang;
  let d = wrapA(DOWN - lf.ang);
  if (Math.abs(d) > Math.PI * 0.92) d = Math.sign(Math.cos(lf.ang) || 1) * Math.PI * 0.92;
  const bend = d * lf.droop * 0.62 + lf.curl * 0.4;
  let p = base;
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    a = lf.ang + bend * Math.pow(t, 1.5);
    p = add(p, dirOf(a, lf.L / n));
    pts.push(p);
  }
  return pts;
}

function petioleEnd(lf) {
  if (!(lf.pet > 0.5)) return lf.at;
  return add(lf.at, dirOf(lf.ang - lf.petBend * 0.5, lf.pet));
}

function addFlower(S, at, axis, R, o = {}) {
  const f = { at, axis: nrm3(axis), R, stage: o.stage || 'open', dir: o.dir == null ? angOf(P(axis.x, axis.y)) : o.dir, z: o.z == null ? 40 : o.z, rank: S.flowers.length };
  S.flowers.push(f);
  return f;
}

// Facing of a flower at the end of a stalk pointing `ang` (2-D).
function faceAxis(g, r, ang, o = {}) {
  const form = g.flower.form;
  if (o.nod || g.flower.nodding) {
    const a = ang + wrapA(DOWN - ang) * r.float(0.55, 0.95);
    return V3(Math.cos(a), Math.sin(a), r.float(-0.05, 0.45));
  }
  if (form === 'labiate') {
    // lipped flowers face sideways: hood above, lip below
    const side = Math.cos(ang) >= 0 ? 1 : -1;
    const a = Math.atan2(Math.sin(ang) * 0.3 - 0.05, side);
    return V3(Math.cos(a), Math.sin(a), r.float(0.3, 0.75));
  }
  const bell = form === 'campanulate' || form === 'tubular' || form === 'lantern';
  const toward = o.toward == null ? (bell ? r.float(0.1, 0.7) : r.float(0.25, 1.4)) : o.toward;
  return V3(Math.cos(ang), Math.sin(ang), toward);
}

// Size of a fruit (plant units), expressed as the flower radius engraveFruit expects.
function fruitR(g, S) {
  const base = { berry: 9, drupe: 11, capsule: 9.5, pod: 8, samara: 8.5, bladder: 13, beads: 6.5 }[g.fruit.form] || 9;
  return (base * (0.8 + 0.6 * clamp(g.flower.size, 0, 1)) * Math.sqrt((S && S.boost) || 1)) / 0.34;
}

function flowerR(g, solitary, S) {
  const s = clamp(g.flower.size, 0.1, 1.1);
  let R = (solitary ? 30 + 52 * s : 14 + 32 * s) * ((S && S.boost) || 1);
  if (g.flower.form === 'tubular') R *= 1.3;
  if (g.flower.form === 'lantern' || g.flower.form === 'labiate') R *= 1.12;
  if (g.flower.form === 'globose') R *= 0.95;
  return R;
}

// A stalk from p in direction ang with a little sag, returning its end.
function stalk(S, r, p, ang, len, w, z, sag = 0.25) {
  const pts = growPath(r, p, ang, len, { lean: wrapA(DOWN - ang) * sag * r.float(0.4, 1), sin: 0.04, step: 5 });
  addStem(S, pts, w, w * 0.7, z, 'pedicel', { thin: true });
  const n = pts.length;
  return { end: pts[n - 1], ang: angOf(sub(pts[n - 1], pts[n - 2])) };
}

// Place the flowers (and buds, and fruit) of one inflorescence at a stem tip.
function inflorescence(S, g, r, tip, ang, scale, o = {}) {
  const type = g.flower.inflorescence;
  const solitary = type === 'solitary';
  const R = flowerR(g, solitary, S) * scale;
  let count = Math.max(1, Math.round((o.count != null ? o.count : g.flower.count) * (o.countK || 1)));
  const wantFruit = g.fruit.present && !o.noFruit ? Math.max(0, Math.round(g.fruit.count * (o.fruitK == null ? 1 : o.fruitK))) : 0;
  let fruitsLeft = wantFruit;
  const buds = g.flower.buds;
  const pedW = clamp(R * 0.06, 0.9, 2.2);
  const stageFor = (i, n) => {
    // lowest positions go to fruit, the top ones are still in bud
    if (fruitsLeft > 0 && i < Math.min(fruitsLeft, Math.floor(n * 0.4))) { return 'fruit'; }
    if (buds && n > 2 && i >= n - Math.max(1, Math.round(n * 0.22))) return 'bud';
    return 'open';
  };
  const place = (p, a, stage, rr, nod) => {
    if (stage === 'fruit') { fruitsLeft--; S.fruits.push({ at: p, ang: a, R: fruitR(g, S), z: 38, hang: g.fruit.form !== 'samara' }); return; }
    if (stage === 'bud') { addFlower(S, p, V3(Math.cos(a), Math.sin(a), 0.2), rr * r.float(0.42, 0.6), { stage: 'bud', dir: a }); return; }
    addFlower(S, p, faceAxis(g, r, a, { nod }), rr);
  };
  if (type === 'solitary') {
    place(tip, ang, 'open', R);
    for (let i = 1; i < count; i++) {
      const side = i % 2 ? 1 : -1;
      const a = ang + side * r.float(0.5, 0.95);
      const st = stalk(S, r, along(o.path || [tip, tip], 1).p, a, R * r.float(1.6, 2.6), pedW, 30);
      place(st.end, st.ang, i === count - 1 && buds ? 'bud' : 'open', R * 0.9);
    }
    if (buds && count === 1 && o.path) {
      const st = stalk(S, r, tip, ang + (r.chance(0.5) ? 1 : -1) * r.float(0.5, 0.9), R * 1.2, pedW * 0.8, 30);
      place(st.end, st.ang, 'bud', R * 0.9);
    }
  } else if (type === 'raceme' || type === 'spike' || type === 'panicle') {
    const spike = type === 'spike';
    const panicle = type === 'panicle';
    const nAxis = panicle ? Math.max(3, Math.round(count / 3)) : count;
    const step = spike ? R * 0.9 : R * (1.12 + r.float(0, 0.3));
    const AL = Math.max(R * 2, step * nAxis);
    const axis = growPath(r, tip, ang, AL, { lean: r.float(-0.25, 0.25), sin: 0.05, step: 5 });
    addStem(S, axis, pedW * (spike ? 1.8 : 1.5), pedW * 0.6, 31, 'rachis', { thin: true });
    const cl = cumLen(axis);
    let made = 0;
    for (let i = 0; i < nAxis; i++) {
      const t = (i + 0.4) / nAxis;
      const { p, tan } = along(axis, t, cl);
      const side = i % 2 ? 1 : -1;
      const a0 = angOf(tan);
      const sizeK = lerp(1, 0.7, t);
      if (panicle) {
        const bl = R * lerp(3.2, 1.4, t) * r.float(0.8, 1.15);
        const ba = a0 + side * rad(g.stem.branchAngle * 0.8 + 25);
        const br = growPath(r, p, ba, bl, { lean: -side * 0.3, sin: 0.05, step: 5 });
        addStem(S, br, pedW, pedW * 0.6, 30.5, 'pedicel', { thin: true });
        const k = Math.max(1, Math.min(4, Math.round((count - made) / Math.max(1, nAxis - i))));
        const bcl = cumLen(br);
        for (let j = 0; j < k; j++) {
          const q = along(br, k === 1 ? 1 : 0.35 + (0.65 * j) / (k - 1), bcl);
          const aa = angOf(q.tan) + (j % 2 ? 0.6 : -0.6) * (j === k - 1 ? 0 : 1);
          const st = j === k - 1 ? { end: q.p, ang: angOf(q.tan) } : stalk(S, r, q.p, aa, R * 0.7, pedW * 0.7, 30);
          place(st.end, st.ang, stageFor(made, count), R * sizeK, false);
          made++;
        }
      } else {
        const pa = a0 + side * rad(r.float(40, 75));
        const front = spike && r.chance(0.3);
        const plen = spike ? R * 0.25 : R * r.float(0.8, 1.4);
        const st = stalk(S, r, p, pa, plen, pedW * 0.8, 30, g.flower.nodding ? 0.7 : 0.25);
        const stage = stageFor(i, nAxis);
        if (front && stage === 'open') addFlower(S, st.end, V3(Math.cos(a0) * 0.3, Math.sin(a0) * 0.3, 1), R * sizeK);
        else place(st.end, st.ang, stage, R * sizeK * (stage === 'bud' ? lerp(1, 0.6, (i - nAxis * 0.78) / (nAxis * 0.22 + 1)) : 1));
        made++;
      }
    }
    // the very tip of the rachis
    const end = axis[axis.length - 1];
    if (buds) place(end, angOf(sub(end, axis[axis.length - 2])), 'bud', R * 0.55);
  } else if (type === 'umbel') {
    const spread = rad(r.float(55, 85));
    const n = count;
    for (let i = 0; i < n; i++) {
      const u = n === 1 ? 0.5 : i / (n - 1);
      const a = ang + lerp(-spread, spread, u) + r.float(-0.08, 0.08);
      const dome = 1 - Math.pow(Math.abs(u - 0.5) * 2, 2) * 0.35;
      const len = R * r.float(2.4, 3.2) * dome;
      const st = stalk(S, r, tip, a, len, pedW * 0.75, 30, 0.12);
      const stage = buds && r.chance(0.2) ? 'bud' : (fruitsLeft > 0 && r.chance(0.25) ? 'fruit' : 'open');
      place(st.end, st.ang, stage, R * r.float(0.85, 1), false);
    }
    // bracts at the base of the umbel
    S.bracts.push({ at: tip, ang, n: r.int(3, 6), L: R * 0.8 });
  } else if (type === 'cyme') {
    const levels = count <= 3 ? 1 : count <= 5 ? 2 : 3;
    let made = 0;
    const fork = (p, a, len, lvl) => {
      if (made >= count) return;
      place(p, a, made === 0 ? 'open' : stageFor(count - made, count), R * lerp(1, 0.78, lvl / 3));
      made++;
      if (lvl >= levels) return;
      for (const side of [-1, 1]) {
        if (made >= count) return;
        const ba = a + side * rad(r.float(30, 50));
        const st = stalk(S, r, p, ba, len, pedW * 0.85, 30, 0.15);
        fork(st.end, st.ang, len * 0.8, lvl + 1);
      }
    };
    fork(tip, ang, R * r.float(2.2, 2.9), 0);
  }
  // fruit that did not find a place in the inflorescence hangs from stalks below it
  if (fruitsLeft > 0 && o.path) {
    const cl = cumLen(o.path);
    for (let i = 0; i < fruitsLeft; i++) {
      const { p, tan } = along(o.path, lerp(0.55, 0.85, (i + 0.5) / fruitsLeft), cl);
      const side = i % 2 ? 1 : -1;
      const st = stalk(S, r, p, angOf(tan) + side * rad(r.float(50, 80)), R * r.float(1.1, 1.8), pedW * 0.8, 30, 0.6);
      S.fruits.push({ at: st.end, ang: st.ang, R: fruitR(g, S), z: 38, hang: true });
    }
    fruitsLeft = 0;
  }
}

// Leaves around a stem node, seen in a little perspective.
function nodeLeaves(S, g, r, p, tan, k, sizeF, o = {}) {
  const arr = o.arrangement || (g.leaf.arrangement === 'basal' ? 'alternate' : g.leaf.arrangement);
  let az = [];
  if (arr === 'alternate') {
    const c = clamp(g.leaf.count, 1, 3);
    const base = (k % 2 ? 0 : Math.PI) + r.float(-0.45, 0.45);
    for (let j = 0; j < c; j++) az.push(base + j * 2.4);
  } else if (arr === 'opposite') {
    const base = k % 2 ? Math.PI / 2 + r.float(-0.5, 0.5) : r.float(-0.3, 0.3);
    az = [base, base + Math.PI];
  } else {
    const c = clamp(g.leaf.count, 3, 6);
    const base = (k * Math.PI) / c + r.float(-0.2, 0.2);
    for (let j = 0; j < c; j++) az.push(base + (j * TAU) / c);
  }
  const T = tan, Rt = P(-T.y, T.x);
  const strap = ['linear', 'ensiform'].includes(g.leaf.shape);
  for (const phi of az) {
    const e = rad(o.elev != null ? o.elev : strap ? r.float(42, 72) : r.float(15, 55));
    const cx = Math.cos(phi) * Math.cos(e), cz = Math.sin(phi) * Math.cos(e);
    const d2 = add(mul(Rt, cx), mul(T, Math.sin(e) + cz * 0.18));
    const fore = clamp(Math.hypot(d2.x, d2.y), 0.3, 1);
    const ang = angOf(d2);
    const front = cz > 0.25, back = cz < -0.35;
    addLeaf(S, g, r, p, ang, sizeF * (strap ? 0.75 : 1), {
      fore, f: lerp(0.62, 1, Math.abs(Math.sin(phi))) * r.float(0.85, 1),
      z: back ? 5 + r.float(0, 1) : front ? 22 + r.float(0, 1) : 18 + r.float(0, 3),
      droop: strap ? clamp(0.45 + g.leaf.droop * 0.5, 0, 1) * r.float(0.8, 1.15) : undefined,
    });
  }
}

// Leaves rising from the base of the plant (rosettes, bulbs, aquatics).
function basalLeaves(S, g, r, p, n, o = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const phi = (i / n) * TAU + r.float(-0.25, 0.25) + (o.phi0 || 0);
    const e = rad(o.elev ? r.float(o.elev[0], o.elev[1]) : r.float(8, 55));
    const dx = Math.cos(phi) * Math.cos(e), dz = Math.sin(phi) * Math.cos(e), dy = -Math.sin(e);
    const d2 = P(dx, dy + dz * 0.3);
    const fore = clamp(Math.hypot(d2.x, d2.y), 0.28, 1);
    const lf = addLeaf(S, g, r, p, angOf(d2), (o.sizeF || 1) * r.float(0.8, 1.1), {
      fore, f: lerp(0.55, 1, Math.abs(Math.sin(phi)) * 0.7 + 0.3) * r.float(0.85, 1),
      z: 15 + dz * 6 + r.float(0, 0.5), droop: o.droop != null ? o.droop * r.float(0.7, 1.2) : undefined,
      kind: 'basal', pet: o.pet,
    });
    out.push(lf);
  }
  return out;
}

// Expected length of the flowering axis above the stem tip (plant units).
function inflLength(g, S, scale = 1) {
  const t = g.flower.inflorescence;
  const R = flowerR(g, t === 'solitary', S) * scale;
  if (t === 'raceme') return g.flower.count * R * 1.27;
  if (t === 'spike') return g.flower.count * R * 0.9;
  if (t === 'panicle') return Math.max(3, Math.round(g.flower.count / 3)) * R * 1.27;
  if (t === 'umbel') return R * 3.2;
  if (t === 'cyme') return R * 4;
  return R;
}

function upright(S, g, r, base, L, o = {}) {
  const lean = g.stem.lean;
  if (!o.noFlowers) L = Math.max(L * 0.45, L - inflLength(g, S) * 0.6);
  const ang0 = (o.ang0 != null ? o.ang0 : UP + lean * 0.22) + r.float(-0.04, 0.04);
  const path = growPath(r, base, ang0, L, { lean: lean * 0.6 + (o.lean || 0), sin: 0.03 + g.stem.sinuosity * 0.32, freq: 0.7 + g.stem.sinuosity * 1.2 });
  const woody = g.habit === 'shrublet';
  const w0 = o.w0 != null ? o.w0 : 3.5 + g.stem.thickness * (woody || g.habit === 'succulent' ? 20 : 9);
  addStem(S, path, w0, Math.max(1.4, w0 * 0.3), o.z == null ? 12 : o.z, 'main', { woody, cut: g.presentation === 'sprig', armature: g.stem.armature, key: 0 });
  const cl = cumLen(path);
  const nodes = clamp(Math.round(g.stem.nodes * (o.nodesK || 1)), 2, 14);
  const t0 = o.firstNode != null ? o.firstNode : 0.08, t1 = o.lastNode != null ? o.lastNode : 0.8;
  const branchSlots = [];
  for (let k = 0; k < nodes; k++) {
    const t = lerp(t0, t1, Math.pow((k + 0.5) / nodes, 0.9)) + r.float(-0.015, 0.015);
    const { p, tan } = along(path, t, cl);
    S.nodes.push({ p, tan, k });
    if (!o.noLeaves) nodeLeaves(S, g, r, p, tan, k, lerp(1, o.topSize == null ? 0.55 : o.topSize, t) * (o.leafK || 1));
    if (k < nodes - 1 && t < 0.86 && t > 0.15) branchSlots.push({ t, p, tan, k });
  }
  // branches
  const depth = o.depth || 0;
  for (const b of branchSlots) {
    if (!r.chance(g.stem.branching * (depth ? 0.5 : 0.85))) continue;
    const side = b.k % 2 ? 1 : -1;
    const ba = angOf(b.tan) + side * rad(g.stem.branchAngle + r.float(-8, 8));
    const bl = L * (1 - b.t) * r.float(0.45, 0.8);
    if (bl < 40) continue;
    const bp = growPath(r, b.p, ba, bl, { lean: wrapA(UP - ba) * r.float(0.2, 0.5) + g.stem.lean * 0.3, sin: 0.03 + g.stem.sinuosity * 0.3, freq: 1 });
    const bw = Math.max(1.6, w0 * lerp(0.75, 0.3, b.t) * 0.7);
    addStem(S, bp, bw, Math.max(1.2, bw * 0.4), (o.z == null ? 12 : o.z) - 1 - depth - r.float(0, 0.5), 'branch', { woody, armature: g.stem.armature, key: 1 + b.t });
    const bcl = cumLen(bp);
    const bn = clamp(Math.round(nodes * (bl / L) * 1.1), 1, 7);
    for (let k = 0; k < bn; k++) {
      const t = lerp(0.18, 0.82, (k + 0.5) / bn);
      const q = along(bp, t, bcl);
      S.nodes.push({ p: q.p, tan: q.tan, k: k + 1 });
      nodeLeaves(S, g, r, q.p, q.tan, k + 1, lerp(0.75, 0.45, t) * (o.leafK || 1));
    }
    const tip = bp[bp.length - 1];
    if (r.chance(0.8)) inflorescence(S, g, r, tip, angOf(sub(tip, bp[bp.length - 2])), 0.85, { countK: g.flower.inflorescence === 'solitary' ? 0 : 0.5, fruitK: 0.4, path: bp });
  }
  const tip = path[path.length - 1];
  const tang = angOf(sub(tip, path[path.length - 2]));
  if (!o.noFlowers) inflorescence(S, g, r, tip, tang, 1, { path });
  return path;
}

function growStructure(g, r, boost = 1) {
  const S = { stems: [], leaves: [], flowers: [], fruits: [], nodes: [], bracts: [], tendrils: [], roots: null, extras: {}, boost };
  const habit = g.habit;
  const whole = g.presentation === 'whole';
  const Hh = 1050 * clamp(g.stem.height, 0.15, 1.05);
  const base = P(0, 0);
  const basalN = clamp(g.leaf.arrangement === 'basal' ? g.leaf.count : r.int(4, 8), 3, 12);
  const mono = g.lineage === 'monocot';

  if (habit === 'vine') {
    const L = Hh * 1.25;
    const startAng = g.presentation === 'sprig' ? UP + (g.stem.lean >= 0 ? 0.35 : -0.35) : UP + g.stem.lean * 0.2;
    const path = growPath(r, base, startAng, L, { lean: -g.stem.lean * 0.9 - (g.stem.lean >= 0 ? 0.4 : -0.4) * (g.presentation === 'sprig' ? 1 : 0), sin: 0.35 + g.stem.sinuosity * 0.55, freq: 1.2 + g.stem.sinuosity, step: 6 });
    const w0 = 2.5 + g.stem.thickness * 7;
    addStem(S, path, w0, 1.3, 12, 'main', { cut: g.presentation === 'sprig', armature: g.stem.armature === 'tendrils' ? 'none' : g.stem.armature });
    const cl = cumLen(path);
    const nodes = clamp(g.stem.nodes + 2, 5, 13);
    const flowerNodes = new Set();
    const nInfl = g.flower.inflorescence === 'solitary' ? Math.max(1, g.flower.count) : r.int(1, 3);
    for (let i = 0; i < nInfl; i++) flowerNodes.add(nodes - 2 - i * 2);
    for (let k = 0; k < nodes; k++) {
      const t = lerp(0.07, 0.9, (k + 0.5) / nodes);
      const { p, tan } = along(path, t, cl);
      S.nodes.push({ p, tan, k });
      const side = k % 2 ? 1 : -1;
      const ta = angOf(tan);
      const la = ta + side * rad(r.float(50, 85));
      addLeaf(S, g, r, p, la, lerp(1, 0.6, t), { z: r.chance(0.25) ? 6 : 20 + r.float(0, 2), pet: undefined });
      if (g.stem.armature === 'tendrils' || r.chance(0.3)) S.tendrils.push({ at: p, ang: ta - side * rad(r.float(30, 70)), L: r.float(50, 110), side: -side });
      if (flowerNodes.has(k)) {
        const pa = ta - side * rad(r.float(25, 55));
        const pl = g.flower.inflorescence === 'solitary' ? flowerR(g, true, S) * 1.2 : r.float(30, 70);
        const st = stalk(S, r, p, pa, pl, 1.6, 29, 0.2);
        inflorescence(S, g, r, st.end, st.ang, 0.85, { count: g.flower.inflorescence === 'solitary' ? 1 : Math.ceil(g.flower.count / nInfl), fruitK: 1 / nInfl });
      }
    }
    // a young, coiling shoot tip
    const tip = path[path.length - 1];
    S.tendrils.push({ at: tip, ang: angOf(sub(tip, path[path.length - 2])), L: 60, side: 1, tip: true });
    if (g.stem.branching > 0.45) {
      const { p, tan } = along(path, 0.3, cl);
      const ba = angOf(tan) + (g.stem.lean >= 0 ? -1 : 1) * rad(g.stem.branchAngle + 10);
      const bp = growPath(r, p, ba, L * 0.4, { lean: r.float(-0.6, 0.6), sin: 0.4, freq: 1.5 });
      addStem(S, bp, w0 * 0.6, 1.1, 11, 'branch');
      const bcl = cumLen(bp);
      for (let k = 0; k < 3; k++) {
        const q = along(bp, 0.25 + k * 0.28, bcl);
        addLeaf(S, g, r, q.p, angOf(q.tan) + (k % 2 ? 1 : -1) * rad(70), 0.65, { z: 19 });
      }
      S.tendrils.push({ at: bp[bp.length - 1], ang: angOf(sub(bp[bp.length - 1], bp[bp.length - 2])), L: 50, side: -1, tip: true });
    }
    if (whole) S.roots = { form: g.root.form, at: base, w: w0 };
  } else if (habit === 'rosette' || habit === 'bulbous') {
    const bulb = habit === 'bulbous';
    basalLeaves(S, g, r, base, basalN, bulb
      ? { elev: [45, 82], droop: 0.55 + g.leaf.droop * 0.4, sizeF: 1 }
      : { elev: [5, 45], sizeF: 1.2 });
    const nScape = g.flower.inflorescence === 'solitary' ? clamp(g.flower.count, 1, 3) : (r.chance(0.25) ? 2 : 1);
    for (let i = 0; i < nScape; i++) {
      const L = Hh * (i ? r.float(0.6, 0.85) : 1) * (bulb ? 1 : 0.78);
      const a = UP + g.stem.lean * 0.25 + (i ? (i % 2 ? 0.28 : -0.28) : 0);
      const path = growPath(r, base, a, L, { lean: g.stem.lean * 0.35 + (i ? (i % 2 ? 0.15 : -0.15) : 0), sin: 0.03 + g.stem.sinuosity * 0.15, freq: 0.8 });
      const w0 = 2.4 + g.stem.thickness * 5;
      addStem(S, path, w0, w0 * 0.55, 12 - i * 0.5, 'scape', { armature: g.stem.armature === 'tendrils' ? 'none' : g.stem.armature });
      // a bract or two on the scape
      if (!bulb || r.chance(0.5)) {
        const q = along(path, r.float(0.35, 0.6));
        S.bracts.push({ at: q.p, ang: angOf(q.tan), n: 1, L: 18 + r.float(0, 14), single: true });
      }
      const tip = path[path.length - 1];
      inflorescence(S, g, r, tip, angOf(sub(tip, path[path.length - 2])), i ? 0.85 : 1,
        { path, count: g.flower.inflorescence === 'solitary' ? 1 : (i ? Math.ceil(g.flower.count * 0.6) : g.flower.count), fruitK: i ? 0 : 1 });
    }
    if (whole) S.roots = { form: g.root.form, at: base, w: 10 };
  } else if (habit === 'aquatic') {
    const water = -Hh * r.float(0.42, 0.55);
    S.extras.water = { y: water };
    const floating = ['orbicular', 'peltate', 'cordate', 'sagittate'].includes(g.leaf.shape) && (g.leaf.arrangement === 'basal' || r.chance(0.5)) && g.leaf.shape !== 'sagittate';
    const nLeaves = clamp(g.leaf.arrangement === 'basal' ? g.leaf.count : r.int(4, 7), 3, 9);
    if (floating) {
      for (let i = 0; i < nLeaves; i++) {
        const x = lerp(-300, 300, (i + 0.5) / nLeaves) + r.float(-30, 30);
        const at = P(x * 0.9, water + r.float(-4, 10));
        const pts = spline([base, P(x * 0.25 + r.float(-20, 20), water * 0.45), P(x * 0.8, water * 0.9), at], 8);
        addStem(S, pts, 2.2, 1.6, 8, 'petiole', { thin: true });
        const d = leafDims(g, r, r.float(0.8, 1.1));
        const ang = r.float(-0.35, 0.35) + (r.chance(0.5) ? 0 : Math.PI);
        const pad = { at, ang, L: d.L, W: d.W, pet: 0, shape: g.leaf.shape, droop: 0, f0: r.float(0.26, 0.42), twist: 0, z: 25 + (at.y - water) * 0.1, kind: 'pad', curl: 0, petBend: 0, floating: true };
        if (g.leaf.shape === 'peltate') pad.at = at;
        S.leaves.push(pad);
      }
    } else {
      basalLeaves(S, g, r, base, nLeaves, { elev: [55, 85], sizeF: 1.15, droop: 0.25, pet: mono ? 0 : undefined });
    }
    const L = Hh * r.float(1.05, 1.25);
    const path = growPath(r, base, UP + g.stem.lean * 0.15, L, { lean: g.stem.lean * 0.3, sin: 0.05 + g.stem.sinuosity * 0.2 });
    addStem(S, path, 3 + g.stem.thickness * 5, 2, 12, 'scape');
    const tip = path[path.length - 1];
    inflorescence(S, g, r, tip, angOf(sub(tip, path[path.length - 2])), 1, { path, count: g.flower.inflorescence === 'solitary' ? Math.min(2, g.flower.count) : g.flower.count });
    S.roots = { form: g.root.form === 'taproot' ? 'rhizome' : g.root.form, at: base, w: 12, aquatic: true };
  } else if (habit === 'epiphyte') {
    if (whole) S.extras.bark = { y: 0, tilt: r.float(-0.12, 0.12), r: r.float(24, 34) };
    if (mono || g.leaf.arrangement === 'basal') {
      // a fan of leathery leaves from a short pseudobulb, and an arching spray of flowers
      basalLeaves(S, g, r, P(0, -6), clamp(r.int(3, 6), 3, 6), { elev: [10, 70], sizeF: 1.35, droop: 0.5 });
      const L = Hh * r.float(0.95, 1.25);
      const side = g.stem.lean >= 0 ? 1 : -1;
      const path = growPath(r, P(0, -8), UP + side * 0.2, L, { lean: side * r.float(0.3, 0.75), sin: 0.08 });
      addStem(S, path, 2.6, 1.4, 12, 'scape');
      const tip = path[path.length - 1];
      inflorescence(S, g, r, tip, angOf(sub(tip, path[path.length - 2])), 1, { path });
      S.pseudobulb = { at: P(0, -4), h: 40 + r.float(0, 25), w: 18 + r.float(0, 10) };
    } else {
      upright(S, g, r, P(0, -4), Hh * 0.8, { w0: 3 + g.stem.thickness * 6, leafK: 0.85 });
    }
    if (whole) S.roots = { form: 'aerial', at: P(0, 0), w: 6 };
  } else if (habit === 'succulent') {
    const L = Hh * 0.75;
    const n = g.stem.branching > 0.3 ? r.int(2, 3) : 1;
    for (let i = 0; i < n; i++) {
      const ang0 = UP + (i === 0 ? g.stem.lean * 0.2 : (i % 2 ? 0.45 : -0.45));
      upright(S, g, r, P(i === 0 ? 0 : (i % 2 ? 8 : -8), 0), L * (i ? r.float(0.55, 0.8) : 1), {
        ang0, w0: 10 + g.stem.thickness * 16 * (i ? 0.7 : 1), nodesK: 1.3, firstNode: 0.12, lastNode: 0.92, topSize: 0.75, leafK: 0.9, depth: 1,
        noFlowers: i > 0 && r.chance(0.5), z: 12 - i,
      });
    }
    if (whole) S.roots = { form: g.root.form, at: base, w: 14 };
  } else {
    // herb, shrublet
    const shrub = habit === 'shrublet';
    const L = Hh * (shrub ? 0.95 : 1);
    if (g.presentation === 'sprig') {
      upright(S, g, r, base, L, { ang0: UP + (g.stem.lean >= 0 ? -0.18 : 0.18) + g.stem.lean * 0.2, firstNode: 0.12 });
    } else {
      if (!shrub && r.chance(0.45) && g.leaf.shape !== 'needle') {
        // a few basal leaves at the foot of the stem
        basalLeaves(S, g, r, P(0, -2), r.int(2, 4), { elev: [5, 35], sizeF: 0.9 });
      }
      upright(S, g, r, base, L, {});
    }
    if (whole) S.roots = { form: g.root.form, at: base, w: 8 };
  }
  if (g.marvel === 'migratory' && S.roots) S.roots.legs = true;
  return S;
}

// ================================================================== layout

// Sample circles {x,y,r} (plant units) covering everything the plant occupies.
function structCircles(S) {
  const out = [];
  for (const st of S.stems) {
    const cl = cumLen(st.pts), L = cl[cl.length - 1] || 1;
    for (let i = 0; i < st.pts.length; i += 2) out.push({ x: st.pts[i].x, y: st.pts[i].y, r: lerp(st.w0, st.w1, cl[i] / L) / 2 + 2 });
  }
  for (const lf of S.leaves) {
    const b = petioleEnd(lf);
    if (lf.shape === 'peltate' || lf.floating) {
      out.push({ x: b.x, y: b.y, r: Math.max(lf.W, lf.L * 0.5) * (lf.floating ? 1 : 1) });
      if (lf.floating) for (const k of [-1, 1]) out.push({ x: b.x + Math.cos(lf.ang) * lf.L * 0.5 * k, y: b.y, r: lf.L * 0.45 * Math.abs(lf.f0) + 4 });
      continue;
    }
    const sp = leafSpine(lf, b, 10);
    const wq = lf.shape === 'pinnate' ? lf.L * 0.32 : lf.shape === 'palmate' ? lf.L * 0.9 : lf.W * Math.max(0.6, Math.abs(lf.f0));
    for (const p of sp) out.push({ x: p.x, y: p.y, r: wq });
    if (lf.shape === 'cordate' || lf.shape === 'sagittate') out.push({ x: b.x, y: b.y, r: lf.W * 0.8 });
  }
  for (const f of S.flowers) {
    const a2 = P(f.axis.x, f.axis.y);
    const c = add(f.at, mul(a2, f.R * (f.stage === 'bud' ? 0.7 : 0.45)));
    out.push({ x: c.x, y: c.y, r: f.R * (f.stage === 'bud' ? 0.8 : 1.2) });
  }
  for (const fr of S.fruits) { const c = add(fr.at, dirOf(fr.ang, fr.R * 0.6)); out.push({ x: c.x, y: c.y, r: fr.R * 0.9 }); }
  for (const t of S.tendrils) { const c = add(t.at, dirOf(t.ang, t.L * 0.4)); out.push({ x: c.x, y: c.y, r: t.L * 0.4 }); }
  for (const b of S.bracts) out.push({ x: b.at.x, y: b.at.y, r: b.L });
  return out;
}

function rootCircles(S) {
  // in plant units; roots are drawn at plate scale (they scale with the plant)
  const out = [];
  const R = S.roots;
  if (!R) return out;
  const b = R.at;
  const push = (x, y, r) => out.push({ x: b.x + x, y: b.y + y, r });
  if (R.legs) { for (let i = -3; i <= 3; i++) push(i * 30, 60, 40); push(-200, 100, 20); push(200, 100, 20); return out; }
  switch (R.form) {
    case 'taproot': for (let i = 0; i < 8; i++) push(0, 20 + i * 28, 30 + i * 3); break;
    case 'fibrous': for (let i = 0; i < 6; i++) { push(-50 - i * 6, 25 + i * 26, 45); push(50 + i * 6, 25 + i * 26, 45); } break;
    case 'tuber': push(30, 70, 60); for (let i = 0; i < 4; i++) push(0, 40 + i * 40, 55); break;
    case 'rhizome': for (let i = -4; i <= 5; i++) push(i * 30, 25, 30); for (let i = -3; i <= 4; i++) push(i * 34, 90, 40); break;
    case 'bulb': push(0, 45, 55); for (let i = 0; i < 4; i++) push(0, 100 + i * 30, 50); break;
    case 'corm': push(0, 30, 50); for (let i = 0; i < 4; i++) push(0, 80 + i * 28, 50); break;
    case 'aerial': for (let i = 0; i < 6; i++) { push(-60 - i * 10, 40 + i * 30, 35); push(60 + i * 8, 40 + i * 28, 35); } break;
    default: push(0, 60, 60);
  }
  return out;
}

function extraCircles(S) {
  const out = [];
  if (S.extras.bark) for (let x = -200; x <= 200; x += 25) out.push({ x, y: 18 + x * S.extras.bark.tilt, r: S.extras.bark.r + 6 });
  if (S.pseudobulb) out.push({ x: 0, y: -S.pseudobulb.h / 2, r: S.pseudobulb.h / 2 + 4 });
  return out;
}

// Fit the structure to the plate and place the inset figures.
function layoutPlate(g, S, r) {
  const marvel = g.marvel;
  const inverted = marvel === 'inverted';
  const mirrored = marvel === 'mirrored' && g.presentation === 'whole';
  const crown = structCircles(S).concat(extraCircles(S));
  const roots = mirrored || inverted ? [] : rootCircles(S);
  let all = crown.concat(roots);
  if (mirrored) all = all.concat(crown.map((c) => ({ x: c.x, y: -c.y + 8, r: c.r })));
  const flip = inverted ? -1 : 1;
  const bb = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const c of all) {
    const y = c.y * flip;
    bb.x0 = Math.min(bb.x0, c.x - c.r); bb.x1 = Math.max(bb.x1, c.x + c.r);
    bb.y0 = Math.min(bb.y0, y - c.r); bb.y1 = Math.max(bb.y1, y + c.r);
  }
  const bw = Math.max(50, bb.x1 - bb.x0), bh = Math.max(50, bb.y1 - bb.y0);
  const topRoom = inverted ? 78 : 0;
  const aw = AREA.x1 - AREA.x0, ah = AREA.y1 - AREA.y0 - topRoom;
  const s0 = Math.min(aw * 0.97 / bw, ah / bh, 1.55);
  const figs = g.figures || [];
  const SMAX = { leaf: 300, root: 290, 'flower-front': 265, 'flower-section': 275, fruit: 235, 'fruit-section': 225, stamen: 235, seed: 205, bud: 205 };
  const SMIN = 112;
  const CELL = 10, GW = Math.ceil(LW / CELL), GH = Math.ceil(LH / CELL);
  let best = null;
  const factors = figs.length ? [1, 0.92, 0.85, 0.78, 0.71, 0.64, 0.57, 0.5] : [1];
  for (const f of factors) {
    const s = s0 * f;
    const w = bw * s, h = bh * s;
    const room = aw - w;
    const shifts = figs.length ? [0, -1, 1, -0.55, 0.55] : [0];
    let bestHere = null;
    for (const sh of shifts) {
      const ox = AREA.x0 + room * (0.5 + 0.5 * sh) - bb.x0 * s;
      let oy;
      if (inverted) oy = AREA.y0 + topRoom - bb.y0 * s;
      else if (mirrored) oy = AREA.y0 + (ah - h) * 0.5 - bb.y0 * s;
      else if (g.presentation === 'sprig') oy = AREA.y1 - 12 - h - (ah - h) * (h < ah * 0.7 ? 0.45 : 0.18) - bb.y0 * s;
      else oy = AREA.y1 - 6 - bb.y1 * s;
      const map = (c) => ({ x: ox + c.x * s, y: oy + c.y * flip * s, r: c.r * s });
      // occupancy grid
      const occ = new Uint8Array(GW * GH);
      const pad = 16;
      const mark = (c) => {
        const R = c.r + pad;
        const gx0 = Math.max(0, Math.floor((c.x - R) / CELL)), gx1 = Math.min(GW - 1, Math.floor((c.x + R) / CELL));
        const gy0 = Math.max(0, Math.floor((c.y - R) / CELL)), gy1 = Math.min(GH - 1, Math.floor((c.y + R) / CELL));
        for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) {
          const cx = (gx + 0.5) * CELL, cy = (gy + 0.5) * CELL;
          if ((cx - c.x) ** 2 + (cy - c.y) ** 2 <= (R + CELL * 0.7) ** 2) occ[gy * GW + gx] = 1;
        }
      };
      for (const c of all) mark(map(c));
      if (inverted) for (let gx = 0; gx < GW; gx++) for (let gy = 0; gy < Math.ceil((AREA.y0 + topRoom + 30) / CELL); gy++) occ[gy * GW + gx] = 1;
      if (S.extras.water) {
        const wy = oy + S.extras.water.y * s;
        for (let gx = 0; gx < GW; gx++) for (let gy = Math.floor((wy - 25) / CELL); gy <= Math.floor((wy + 45) / CELL); gy++) if (gy >= 0 && gy < GH) occ[gy * GW + gx] = 1;
      }
      // the figure-1 numeral near the base
      const base = map({ x: S.roots ? S.roots.at.x : 0, y: 0, r: 0 });
      const boxes = placeFigures(occ, GW, GH, CELL, figs, SMAX, SMIN, r.fork('fig' + f + sh));
      const placed = boxes.filter(Boolean);
      const score = placed.reduce((a, b) => a + b.S, 0) + (sh === 0 ? 30 : 0);
      const cand = { s, ox, oy, flip, boxes, score, all: placed.length === figs.length, base, occ };
      if (!bestHere || (cand.all && !bestHere.all) || (cand.all === bestHere.all && cand.score > bestHere.score)) bestHere = cand;
    }
    if (!best || (bestHere.all && !best.all) || (!best.all && bestHere.score > best.score)) best = bestHere;
    if (bestHere.all) break;
  }
  const L = best;
  L.T = (p) => P(L.ox + p.x * L.s, L.oy + p.y * L.flip * L.s);
  L.inverted = inverted; L.mirrored = mirrored;
  L.groundY = L.oy;                                    // y of the plant's base (plant y = 0)
  return L;
}

function placeFigures(occ, GW, GH, CELL, figs, SMAX, SMIN, r) {
  const sat = new Int32Array((GW + 1) * (GH + 1));
  const build = () => {
    for (let y = 0; y < GH; y++) {
      let row = 0;
      for (let x = 0; x < GW; x++) {
        row += occ[y * GW + x] ? 1 : 0;
        sat[(y + 1) * (GW + 1) + x + 1] = sat[y * (GW + 1) + x + 1] + row;
      }
    }
  };
  const sum = (x0, y0, x1, y1) => sat[y1 * (GW + 1) + x1] - sat[y0 * (GW + 1) + x1] - sat[y1 * (GW + 1) + x0] + sat[y0 * (GW + 1) + x0];
  const ax0 = Math.ceil(AREA.x0 / CELL), ay0 = Math.ceil(AREA.y0 / CELL), ax1 = Math.floor(AREA.x1 / CELL), ay1 = Math.floor(AREA.y1 / CELL);
  const out = [];
  build();
  for (const fg of figs) {
    let found = null;
    for (let Sz = SMAX[fg.kind] || 180; Sz >= SMIN && !found; Sz -= 16) {
      const n = Math.ceil(Sz / CELL);
      let bestScore = -Infinity;
      for (let gy = ay0; gy + n <= ay1; gy += 1) {
        for (let gx = ax0; gx + n <= ax1; gx += 1) {
          if (sum(gx, gy, gx + n, gy + n) > 0) continue;
          const x = gx * CELL, y = gy * CELL;
          const dx = Math.min(x - AREA.x0, AREA.x1 - (x + Sz)), dy = Math.min(y - AREA.y0, AREA.y1 - (y + Sz));
          let sc = -(dx + dy) * 0.6 - dy * 0.15 + (y > LH / 2 ? 18 : 0);
          for (const b of out) if (b) { const d = Math.hypot(b.x + b.S / 2 - x - Sz / 2, b.y + b.S / 2 - y - Sz / 2); sc += Math.min(d, 420) * 0.12; }
          sc += r.float(0, 4);
          if (sc > bestScore) { bestScore = sc; found = { x, y, S: Sz }; }
        }
      }
    }
    if (found) {
      const pad = 2;
      for (let gy = Math.max(0, found.y / CELL - pad); gy < Math.min(GH, (found.y + found.S) / CELL + pad); gy++)
        for (let gx = Math.max(0, found.x / CELL - pad); gx < Math.min(GW, (found.x + found.S) / CELL + pad); gx++) occ[gy * GW + gx] = 1;
      build();
    }
    out.push(found);
  }
  return out;
}

// ================================================================== engraving: stems

function ribbon(pts, wfn) {
  const cl = cumLen(pts), L = cl[cl.length - 1] || 1, left = [], right = [];
  for (let i = 0; i < pts.length; i++) {
    const tan = nrm(sub(pts[Math.min(i + 1, pts.length - 1)], pts[Math.max(i - 1, 0)]));
    const n = perp(tan), hw = wfn(cl[i] / L) / 2;
    left.push(sub(pts[i], mul(n, hw))); right.push(add(pts[i], mul(n, hw)));
  }
  return { left, right, poly: left.concat(right.slice().reverse()), cl, L };
}

function engraveStem(E, st, phase = 2) {
  const r = E.r, pal = E.pal;
  const pts = resample(st.pts, 2.4);
  if (pts.length < 2) return null;
  const wAt = st.wfn || ((t) => lerp(st.w0, st.w1, Math.pow(t, 0.85)));
  const maxW = st.wfn ? Math.max(st.w0, st.w1, st.wfn(0.5), st.wfn(0.25), st.wfn(0.75)) : Math.max(st.w0, st.w1);
  const it = mkItem(st.z, phase, st.key + (st.kind === 'pedicel' || st.kind === 'rachis' ? 50 : 0), { origin: pts[0] });
  const col = st.woody ? pal.wood : (st.color || pal.stem);
  if (maxW < 2.7) {
    pushS(it.lines, mkStroke(pts, { w: clamp(maxW * 0.5, 0.55, 1.1), taper: 0.02, taperEnd: 0.25, rng: r, jit: 0.2 }));
    if (maxW >= 1.5) {
      const rb = ribbon(pts, (t) => wAt(t) + 0.8);
      it.washes.push({ poly: rb.poly, color: col, alpha: 0.5, edge: 0.2, blots: 0, hard: true, sweep: { pts, w: maxW + 6 } });
    }
    E.items.push(it);
    armature(E, st, pts, wAt, it);
    return it;
  }
  const rb = ribbon(pts, wAt);
  const { left, right, cl, L } = rb;
  pushS(it.lines, mkStroke(left, { w: 1.0, side: -1, shade: 0.75, taper: 0.02, taperEnd: 0.12, rng: r, jit: 0.3 }));
  pushS(it.lines, mkStroke(right, { w: 1.0, side: 1, shade: 0.75, taper: 0.02, taperEnd: 0.12, rng: r, jit: 0.3 }));
  it.occ = [rb.poly];
  const sweep = { pts, w: maxW + 7 };
  it.washes.push({ poly: rb.poly, color: col, alpha: 0.6, edge: 0.6, sweep });
  // shaded half
  const shadeSide = [];
  const strip = [];
  for (let i = 0; i < pts.length; i++) {
    const tan = nrm(sub(pts[Math.min(i + 1, pts.length - 1)], pts[Math.max(i - 1, 0)]));
    const n = perp(tan);
    shadeSide.push(dot(n, SHADOW) >= 0 ? 1 : -1);
  }
  const dom = shadeSide.reduce((a, b) => a + b, 0) >= 0 ? 1 : -1;
  for (let i = 0; i < pts.length; i++) {
    const tan = nrm(sub(pts[Math.min(i + 1, pts.length - 1)], pts[Math.max(i - 1, 0)]));
    strip.push(add(pts[i], mul(perp(tan), dom * wAt(cl[i] / L) * 0.05)));
  }
  const edge = dom > 0 ? right : left;
  it.washes.push({ poly: strip.concat(edge.slice().reverse()), color: darken(col, 0.25), alpha: 0.32, edge: 0.2, blots: 0, sweep });
  // hatching across the shaded side, curved like the contour of a cylinder
  const wob = wobble(r, 40);
  const sp = st.woody ? 2.1 : 2.5;
  const hw0 = maxW / 2;
  if (maxW > 3.4) {
    for (let s = 1; s < L - 1; s += sp) {
      const { p, tan } = along(pts, s / L, cl);
      const n = perp(tan);
      const sd = dot(n, SHADOW) >= 0 ? 1 : -1;
      const hw = wAt(s / L) / 2;
      const frac = clamp(0.42 + 0.22 * wob(s) + (st.woody ? 0.15 : 0), 0.2, 0.9);
      const a = add(p, mul(n, sd * hw * 0.96));
      const b = add(p, mul(n, sd * hw * (0.96 - 2 * frac)));
      const m = add(lerpP(a, b, 0.5), mul(tan, -hw * 0.18));
      pushS(it.hatch, mkHatch(a, b, hw > 5 ? 0.55 : 0.48, null, m));
    }
    // a second, longitudinal layer on thick stems
    if (hw0 > 4.5) {
      for (const k of [0.62, 0.8]) {
        let run = [];
        for (let i = 0; i < pts.length; i++) {
          const tan = nrm(sub(pts[Math.min(i + 1, pts.length - 1)], pts[Math.max(i - 1, 0)]));
          const n = perp(tan);
          const sd = dot(n, SHADOW) >= 0 ? 1 : -1;
          run.push(add(pts[i], mul(n, sd * wAt(cl[i] / L) / 2 * k)));
          if (run.length > 8 + r.int(0, 10) || i === pts.length - 1) {
            if (r.chance(0.75)) pushS(it.hatch, mkStroke(run, { w: 0.4, taper: 0.3, rng: r, jit: 0.15 }));
            run = [];
          }
        }
      }
    }
  }
  if (st.woody && hw0 > 2.5) {
    // bark: short fissures and lenticels
    const nf = Math.floor(L / 7);
    for (let i = 0; i < nf; i++) {
      const s = r.float(0, L - 10);
      const { p, tan } = along(pts, s / L, cl);
      const n = perp(tan), hw = wAt(s / L) / 2;
      const off = r.float(-0.8, 0.8) * hw;
      const a = add(p, mul(n, off));
      const len = r.float(5, 14);
      const b = add(a, add(mul(tan, len), mul(n, r.float(-1, 1))));
      if (r.chance(0.7)) pushS(it.hatch, mkHatch(a, b, 0.36, null, add(lerpP(a, b, 0.5), mul(n, r.float(-0.8, 0.8)))));
      else pushS(it.hatch, mkHatch(add(a, mul(n, -1)), add(a, mul(n, 1)), 0.5));
    }
  }
  if (st.cut) engraveCut(E, pts, wAt(0), col, st.z);
  E.items.push(it);
  armature(E, st, pts, wAt, it);
  return it;
}

// The clean diagonal cut at the foot of a sprig.
function engraveCut(E, pts, w, col, z) {
  const p = pts[0], tan = nrm(sub(pts[Math.min(3, pts.length - 1)], p));
  const it = mkItem(z + 0.1, 2, -1, { origin: p });
  const c = add(p, mul(tan, w * 0.15));
  const el = ellipsePts(c, w / 2 + 0.3, Math.max(1.6, w * 0.28), angOf(perp(tan)), 28);
  pushS(it.lines, mkStroke(el, { w: 0.75, taper: 0, rng: E.r, jit: 0.15 }));
  it.washes.push({ poly: el, color: lighten(col, 0.55), alpha: 0.6, edge: 0.4, hard: true });
  it.occ = [el];
  const pith = ellipsePts(c, w * 0.18, Math.max(0.8, w * 0.1), angOf(perp(tan)), 16);
  if (w > 6) pushS(it.lines, mkStroke(pith, { w: 0.4, taper: 0 }));
  const dots = [];
  for (let i = 0; i < w * 3; i++) {
    const a = E.r.float(0, TAU), rr = Math.sqrt(E.r.next()) * 0.85;
    const q = add(c, rot2(P(Math.cos(a) * rr * w / 2, Math.sin(a) * rr * Math.max(1.6, w * 0.28)), angOf(perp(tan))));
    dots.push({ x: q.x, y: q.y, r: 0.35 });
  }
  it.dots.push({ pts: dots });
  E.items.push(it);
}

function rot2(p, a) { const c = Math.cos(a), s = Math.sin(a); return P(p.x * c - p.y * s, p.x * s + p.y * c); }

function armature(E, st, pts, wAt, it) {
  const kind = st.armature;
  if (!kind || kind === 'none' || st.kind === 'pedicel' || st.kind === 'rachis') return;
  const r = E.r;
  const cl = cumLen(pts), L = cl[cl.length - 1];
  if (kind === 'hairs') {
    for (let s = 3; s < L - 2; s += r.float(2.2, 4)) {
      const { p, tan } = along(pts, s / L, cl);
      const n = perp(tan), hw = wAt(s / L) / 2;
      for (const sd of [-1, 1]) {
        if (r.chance(0.35)) continue;
        const a = add(p, mul(n, sd * hw));
        const d = nrm(add(mul(n, sd), mul(tan, r.float(0.6, 1.4))));
        pushS(it.hatch, mkHatch(a, add(a, mul(d, r.float(2.5, 5.5))), 0.3));
      }
    }
  } else if (kind === 'thorns') {
    const th = mkItem(st.z + 0.05, 2, st.key + 0.5, { origin: pts[0] });
    let side = 1;
    for (let s = r.float(10, 30); s < L * 0.92; s += r.float(22, 42)) {
      const { p, tan } = along(pts, s / L, cl);
      const n = perp(tan), hw = wAt(s / L) / 2;
      side = -side;
      const len = clamp(hw * 1.6 + 4, 5, 16) * r.float(0.8, 1.2);
      const bw = clamp(hw * 0.7, 1.6, 5);
      const b0 = add(add(p, mul(n, side * hw * 0.85)), mul(tan, -bw));
      const b1 = add(add(p, mul(n, side * hw * 0.85)), mul(tan, bw));
      const tip = add(add(p, mul(n, side * (hw + len))), mul(tan, len * 0.45));
      const mid0 = add(lerpP(b0, tip, 0.5), mul(tan, -len * 0.08));
      const mid1 = add(lerpP(b1, tip, 0.5), mul(tan, -len * 0.12));
      const poly = spline([b0, mid0, tip], 4).concat(spline([tip, mid1, b1], 4).slice(1));
      pushS(th.lines, mkStroke(poly, { w: 0.7, center: centroid(poly), shade: 0.8, taper: 0.05, rng: r, jit: 0.1 }));
      th.washes.push({ poly, color: C(28, 30, 38), alpha: 0.6, edge: 0.4, hard: true });
      pushS(th.hatch, mkHatch(lerpP(b1, tip, 0.15), lerpP(b1, tip, 0.7), 0.35));
    }
    if (th.lines.length) E.items.push(th);
  }
}

function engraveTendril(E, t, phase = 3.5) {
  const r = E.r;
  const pts = [t.at];
  let p = t.at, a = t.ang;
  const L = t.L;
  const n1 = 14;
  for (let i = 0; i < n1; i++) { a += t.side * 0.035 + r.float(-0.06, 0.06); p = add(p, dirOf(a, (L * (t.tip ? 0.3 : 0.45)) / n1)); pts.push(p); }
  const turns = r.float(1.6, 3.4), steps = Math.round(turns * 30);
  const r0 = L * r.float(0.08, 0.13);
  for (let k = 0; k < steps; k++) {
    const u = k / steps;
    const da = (t.side * TAU * turns) / steps;
    a += da;
    const rr = r0 * (1 - 0.82 * u);
    p = add(p, dirOf(a, rr * Math.abs(da)));
    pts.push(p);
  }
  const it = mkItem(t.z || 21, phase, -t.at.y * 0.001, { origin: t.at });
  pushS(it.lines, mkStroke(pts, { w: 0.85, taper: 0.02, taperEnd: 0.7, minW: 0.25, rng: r, jit: 0.1, step: 1.6 }));
  E.items.push(it);
}

// ================================================================== engraving: leaves

const PROF = {
  linear: (t) => Math.pow(clamp(t / 0.04, 0, 1), 0.4) * (t < 0.68 ? 1 : Math.pow(Math.max(0, 1 - (t - 0.68) / 0.32), 0.85)),
  ensiform: (t) => (t < 0.05 ? 1.1 : 1) * (t < 0.8 ? 1 : Math.max(0, 1 - (t - 0.8) / 0.2)),
  lanceolate: (t) => Math.pow(Math.sin(Math.PI * Math.pow(t, 0.62)), 0.95),
  ovate: (t) => Math.pow(Math.sin(Math.PI * Math.pow(t, 0.8)), 0.62),
  needle: (t) => Math.pow(Math.sin(Math.PI * Math.pow(t, 0.4)), 0.7),
  terete: (t) => (t < 0.84 ? 0.82 + 0.18 * Math.sin(Math.PI * t / 1.68) : Math.sqrt(Math.max(0, 1 - Math.pow((t - 0.84) / 0.16, 2))) * 0.97) * Math.min(1, 0.55 + t * 6),
};

// Right half of a leaf outline in local coordinates (x along the midrib, y >= 0).
function halfOutline(shape, L, W, r, lobes) {
  const pts = [];
  const prof = (fn, n = 40) => {
    pts.push(P(0, 0));
    for (let i = 1; i <= n; i++) {
      const t = (1 - Math.cos((Math.PI * i) / n)) / 2;
      pts.push(P(t * L, W * fn(t)));
    }
  };
  switch (shape) {
    case 'linear': case 'ensiform': case 'lanceolate': case 'ovate': case 'needle': case 'terete':
      prof(PROF[shape]); break;
    case 'lobed': {
      const n = lobes.n, depth = lobes.depth, pointed = lobes.pointed;
      prof((t) => {
        const env = Math.pow(Math.sin(Math.PI * Math.pow(t, 0.72)), 0.7);
        const ph = Math.pow(t, 0.92) * n;
        const s = Math.abs(Math.sin(Math.PI * ph));
        const lobe = pointed ? Math.pow(s, 0.35) * (1 - 0.25 * (ph % 1)) : Math.pow(s, 0.55);
        return env * (1 - depth * (1 - lobe) * smoothstep(0.02, 0.15, t) * (1 - smoothstep(0.85, 1, t)));
      }, 90);
      break;
    }
    case 'orbicular': {
      pts.push(P(0, 0));
      const R = L / 2;
      for (let i = 0; i <= 40; i++) { const a = Math.PI - 0.22 - ((Math.PI - 0.22) * i) / 40; pts.push(P(R + Math.cos(a) * R, Math.sin(a) * R * (W / R))); }
      break;
    }
    case 'peltate': {
      for (let i = 0; i <= 44; i++) { const a = Math.PI - (Math.PI * i) / 44; pts.push(P(Math.cos(a) * W, Math.sin(a) * W)); }
      break;
    }
    case 'cordate': {
      const c = [[0, 0], [-0.07, 0.13], [-0.15, 0.45], [-0.12, 0.78], [0.01, 0.98], [0.2, 1.0], [0.43, 0.84], [0.66, 0.52], [0.86, 0.2], [1, 0]];
      pts.push(...spline(c.map(([x, y]) => P(x * L, y * W)), 6));
      break;
    }
    case 'sagittate': {
      const c = [[0, 0], [-0.08, 0.1], [-0.22, 0.26], [-0.36, 0.42], [-0.36, 0.42], [-0.24, 0.66], [-0.05, 0.9], [0.2, 0.96], [0.46, 0.74], [0.72, 0.4], [0.9, 0.13], [1, 0]];
      pts.push(...spline(c.map(([x, y]) => P(x * L, y * W)), 6));
      break;
    }
    case 'palmate': {
      const k = lobes.n;                        // lobes in total (odd)
      const half = (k - 1) / 2;
      const spread = lobes.spread;
      const sinus = lobes.depth;
      const lob = [];
      for (let j = 0; j <= half; j++) lob.push({ a: (spread * j) / Math.max(1, half), l: 1 - 0.16 * j - 0.06 * j * j });
      const sig = (spread / Math.max(1, half)) * 0.55;
      for (let i = 0; i <= 120; i++) {
        const a = Math.PI - (Math.PI * i) / 120;
        let m = 0;
        for (const lb of lob) {
          const d = Math.abs(a - lb.a) / sig;
          if (d < 1) m = Math.max(m, lb.l * Math.pow(Math.cos((d * Math.PI) / 2), lobes.pointed ? 0.7 : 1.6));
        }
        const back = smoothstep(spread + sig * 0.6, Math.PI, a);
        const rr = L * lerp(sinus + (1 - sinus) * m, 0.1, back);
        pts.push(P(Math.cos(a) * rr, Math.sin(a) * rr));
      }
      break;
    }
    default: prof(PROF.lanceolate);
  }
  return pts;
}

// Clip segment ab to polygon; returns inside pieces.
function clipSeg(a, b, poly) {
  const ts = [0, 1];
  const d = sub(b, a);
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const p = poly[j], q = poly[i], e = sub(q, p);
    const den = d.x * e.y - d.y * e.x;
    if (Math.abs(den) < 1e-9) continue;
    const w = sub(p, a);
    const t = (w.x * e.y - w.y * e.x) / den, u = (w.x * d.y - w.y * d.x) / den;
    if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
  }
  ts.sort((m, n) => m - n);
  const out = [];
  for (let k = 0; k + 1 < ts.length; k++) {
    const m = lerpP(a, b, (ts[k] + ts[k + 1]) / 2);
    if (ts[k + 1] - ts[k] > 1e-3 && inPoly(m, poly)) out.push([lerpP(a, b, ts[k]), lerpP(a, b, ts[k + 1])]);
  }
  return out;
}

// Build the local->world mapping of a leaf blade.
function leafMapper(lf, base) {
  const n = 32;
  const spine = leafSpine(lf, base, n);
  const angs = [];
  for (let i = 0; i <= n; i++) angs.push(angOf(sub(spine[Math.min(n, i + 1)], spine[Math.max(0, i - 1)])));
  const L = lf.L;
  const fAt = (x) => lf.f0 * Math.cos(Math.PI * lf.twist * smoothstep(0.15, 1, x / L));
  const map = (x, y) => {
    let c, a;
    if (x <= 0) { a = angs[0]; c = add(spine[0], dirOf(a, x)); }
    else if (x >= L) { a = angs[n]; c = add(spine[n], dirOf(a, x - L)); }
    else {
      const k = (x / L) * n, i = Math.floor(k), t = k - i;
      c = lerpP(spine[i], spine[i + 1], t);
      a = angs[i] + wrapA(angs[i + 1] - angs[i]) * t;
    }
    const nn = P(-Math.sin(a), Math.cos(a));
    return add(c, mul(nn, y * fAt(x)));
  };
  return { map, fAt, spine };
}

// Width (local) of the half outline at x, by scanning the outline.
function widthTable(half, x0, x1) {
  const N = 48, tab = new Float32Array(N + 1);
  for (const p of half) {
    const k = Math.round(((p.x - x0) / (x1 - x0 || 1)) * N);
    if (k >= 0 && k <= N) tab[k] = Math.max(tab[k], p.y);
  }
  for (let k = 1; k < N; k++) if (tab[k] === 0) tab[k] = (tab[k - 1] + tab[Math.min(N, k + 1)]) / 2;
  return (x) => { const k = clamp(((x - x0) / (x1 - x0 || 1)) * N, 0, N), i = Math.floor(k), t = k - i; return lerp(tab[i], tab[Math.min(N, i + 1)], t); };
}

function marginOffset(kind, L, r) {
  if (kind === 'serrate') { const lam = clamp(L * 0.045, 3.2, 8.5), A = lam * 0.42; return (s) => A * ((s / lam) % 1 - 0.5); }
  if (kind === 'crenate') { const lam = clamp(L * 0.06, 4.5, 12), A = lam * 0.3; return (s) => A * (Math.pow(Math.abs(Math.sin((Math.PI * s) / lam)), 0.6) - 0.6); }
  if (kind === 'undulate') { const lam = clamp(L * 0.17, 12, 40), A = clamp(L * 0.022, 1, 3.4), ph = r.float(0, TAU); return (s) => A * Math.sin((TAU * s) / lam + ph); }
  if (kind === 'feather') { const f = wobble(r, 5), g2 = wobble(r, 17); return (s) => -Math.max(0, f(s) * 2.2 + g2(s) * 1.2 - 0.6); }
  return null;
}

// Engrave one simple leaf blade (everything except compound leaves).
function engraveBlade(E, lf, o = {}) {
  const r = E.r, pal = E.pal;
  const base = o.base || petioleEnd(lf);
  const shape = lf.shape;
  const L = lf.L, W = lf.W;
  if (!(L > 2) || !fin(base)) return;
  const lobes = { n: r.int(3, 5), depth: r.float(0.35, 0.6), pointed: E.g.leaf.margin === 'serrate' || r.chance(0.35), spread: rad(r.float(95, 125)) };
  if (shape === 'palmate') lobes.n = r.pick([5, 5, 7, 7, 9]);
  const half = halfOutline(shape, L, W, r, lobes);
  const minX = Math.min(...half.map((p) => p.x)), maxX = Math.max(L, ...half.map((p) => p.x));
  const wAt = widthTable(half, minX, maxX);
  const asym = r.float(0.9, 1);
  const halfL = half.map((p) => P(p.x, -p.y * asym));
  const { map, fAt } = leafMapper(lf, base);
  const feather = E.marvel === 'feathered' && !['needle', 'terete'].includes(shape);
  const marginKind = feather ? 'feather' : (E.g.leaf.margin || 'entire');
  const mfn = ['needle', 'terete', 'linear', 'ensiform'].includes(shape) && !feather ? null : marginOffset(marginKind, L, r);
  const fleshy = lf.fleshy || (E.g.leaf.fleshy && shape !== 'needle');
  const under = lf.f0 < 0;
  const z = lf.z;
  const it = mkItem(z, o.phase || 3, o.key != null ? o.key : -base.y * 0.001, { origin: base });

  // outline halves in world, with the margin applied
  const worldHalf = (h) => {
    const loc = resample(h, Math.max(0.8, Math.min(2, L / 60)));
    const w = loc.map((p) => map(p.x, p.y));
    if (!mfn) return w;
    const cl = cumLen(w), tot = cl[cl.length - 1] || 1;
    return w.map((p, i) => {
      const a = w[Math.max(0, i - 1)], b = w[Math.min(w.length - 1, i + 1)];
      let n = perp(nrm(sub(b, a)));
      const c = map(loc[i].x, 0);
      if (dot(n, sub(p, c)) < 0) n = mul(n, -1);
      const u = cl[i] / tot;
      const env = smoothstep(0.02, 0.1, u) * (1 - smoothstep(0.9, 0.985, u));
      return add(p, mul(n, mfn(cl[i]) * env * Math.min(1, Math.abs(fAt(loc[i].x)) * 1.4 + 0.2)));
    });
  };
  const R = worldHalf(half), Lh = worldHalf(halfL);
  const poly = R.concat(Lh.slice().reverse());
  if (poly.length < 4 || !poly.every(fin)) return;
  it.occ = [poly];

  // colouring
  const bb = bboxOf(poly);
  const cc = P((bb.x0 + bb.x1) / 2, (bb.y0 + bb.y1) / 2);
  const size = Math.max(bb.x1 - bb.x0, bb.y1 - bb.y0);
  const top = feather ? lighten(pal.leaf, 0.25) : pal.leaf;
  const flipX = lf.twist > 0.5 ? L * (0.15 + 0.85 * acosSmoothInv(0.5 / lf.twist)) : null;
  const washOf = (polyW, upper) => {
    const c0 = upper ? lighten(top, 0.12) : lighten(pal.under, 0.1);
    const c1 = upper ? pal.leafShade : darken(pal.under, 0.12);
    return { poly: polyW, color: c0, alpha: feather ? 0.5 : 0.7, shade: { from: sub(cc, mul(SHADOW, size * 0.45)), to: add(cc, mul(SHADOW, size * 0.45)), color: c1 } };
  };
  const variegation = E.g.leaf.variegation;
  if (flipX != null && flipX < L * 0.97) {
    const split = (h) => [h.filter((p) => p.x <= flipX), h.filter((p) => p.x >= flipX)];
    const [r1, r2] = split(resample(half, 2)), [l1, l2] = split(resample(halfL, 2));
    const p1 = r1.map((p) => map(p.x, p.y)).concat(l1.slice().reverse().map((p) => map(p.x, p.y)));
    const p2 = r2.map((p) => map(p.x, p.y)).concat(l2.slice().reverse().map((p) => map(p.x, p.y)));
    if (p1.length > 3) it.washes.push(washOf(p1, !under));
    if (p2.length > 3) it.washes.push(washOf(p2, under));
  } else {
    const w = washOf(poly, !under);
    if (variegation === 'spotted' && !under) {
      const holes = [];
      const ns = r.int(5, 12);
      for (let i = 0; i < ns; i++) {
        const x = r.float(0.12, 0.85) * L, y = r.float(-0.75, 0.75) * wAt(x);
        const c = map(x, y), rr = clamp(L * r.float(0.015, 0.035), 1.2, 4.5);
        holes.push(ellipsePts(c, rr, rr * 0.8, r.float(0, 3), 10));
      }
      w.holes = holes;
    }
    if (variegation === 'margined' && !under) {
      w.color = lighten(pal.leaf, 0.5); w.shade = null;
      const inner = half.map((p) => P(p.x, p.y * 0.68)).concat(halfL.slice().reverse().map((p) => P(p.x, p.y * 0.68)));
      it.washes.push(w);
      it.washes.push({ poly: inner.map((p) => map(clamp(p.x, minX * 0.9, L * 0.93), p.y)), color: pal.leaf, alpha: 0.62, shade: washOf(poly, true).shade });
    } else it.washes.push(w);
  }

  // glazes: deeper colour over the half in shadow, a warmer, yellower wash towards the tip
  if (!feather && shape !== 'needle' && L > 18 && flipX == null && variegation !== 'margined') {
    const mid0 = map(L * 0.5, 0), side0 = map(L * 0.5, wAt(L * 0.5) + 0.01);
    const sdG = dot(nrm(sub(side0, mid0)), SHADOW) > 0 ? 1 : -1;
    const hp = (sdG > 0 ? half : halfL).map((q) => map(q.x, q.y * 0.97)).concat([map(L * 0.96, 0), map(L * 0.5, 0), map(0, 0)]);
    it.washes.push({ poly: hp, color: under ? darken(pal.under, 0.12) : pal.leafShade, alpha: 0.2, edge: 0.4, blots: 1 });
    const tipPoly = [];
    for (const q of half) if (q.x > L * 0.55) tipPoly.push(map(q.x, q.y * 0.9));
    for (const q of halfL.slice().reverse()) if (q.x > L * 0.55) tipPoly.push(map(q.x, q.y * 0.9));
    if (tipPoly.length > 4) it.washes.push({ poly: tipPoly, color: C(top.h - 18, top.s + 6, Math.min(70, top.l + 12)), alpha: 0.16, edge: 0.2, blots: 0 });
  }
  // ink: the outline, drawn from the base up each side
  const ow = clamp(0.72 + L / 210, 0.8, 1.45) * (fleshy ? 1.2 : 1);
  if (feather) {
    // ragged vanes: the outline breaks up
    for (const h of [R, Lh]) {
      let run = [];
      for (let i = 0; i < h.length; i++) {
        run.push(h[i]);
        if ((run.length > 6 && r.chance(0.18)) || i === h.length - 1) { pushS(it.lines, mkStroke(run, { w: ow * 0.8, center: cc, shade: 0.7, taper: 0.2, rng: r, jit: 0.2 })); run = []; i += r.int(0, 2); }
      }
    }
  } else {
    pushS(it.lines, mkStroke(R, { w: ow, center: cc, shade: 0.75, taper: 0.04, taperEnd: 0.12, rng: r, jit: 0.25 }));
    pushS(it.lines, mkStroke(Lh, { w: ow, center: cc, shade: 0.75, taper: 0.04, taperEnd: 0.12, rng: r, jit: 0.25 }));
  }
  if (shape === 'needle' && W < 2.5) { E.items.push(it); return it; }

  // midrib and veins
  const ven = feather ? 'feather' : (['palmate', 'peltate'].includes(shape) ? 'palmate' : E.g.leaf.venation || 'pinnate');
  const vw = under ? 0.55 : 0.44;
  const midEnd = shape === 'peltate' ? W * 0.95 : L * 0.93;
  const midStart = shape === 'peltate' ? 0 : 0;
  if (!['terete'].includes(shape) && ven !== 'parallel') {
    const mid = [];
    for (let i = 0; i <= 24; i++) mid.push(map(lerp(midStart, midEnd, i / 24), 0));
    pushS(it.lines, mkStroke(mid, { w: feather ? 1.3 : clamp(L / 110, 0.55, 1.0) * (under ? 1.3 : 1), taper: 0, taperEnd: 0.9, minW: 0.25, rng: r, jit: 0.12 }));
    if (L > 70 && !feather) {
      const mid2 = [];
      for (let i = 0; i <= 16; i++) mid2.push(map(lerp(0, midEnd * 0.6, i / 16), clamp(L * 0.008, 0.6, 1.4) * (under ? 1.5 : 1)));
      pushS(it.hatch, mkStroke(mid2, { w: 0.35, taper: 0, taperEnd: 0.8 }));
    }
  }
  const veinPolys = [];
  if (fleshy && shape === 'terete') {
    // cylinder: longitudinal contour lines on the shaded side, a highlight on the lit side
  } else if (ven === 'pinnate' || ven === 'feather') {
    const nv = feather ? 0 : clamp(Math.round(L / (shape === 'lobed' ? 22 : 15)), 3, 13);
    for (let i = 0; i < nv; i++) {
      const x0 = lerp(0.06, 0.84, (i + 0.5) / nv) * L;
      for (const sd of [1, -1]) {
        const xe = Math.min(L * 0.97, x0 + Math.max(L * 0.08, wAt(x0) * (shape === 'lanceolate' ? 1.7 : 1.05)));
        const ye = 0.86 * wAt(xe) * sd;
        const ctrl = P(x0 + (xe - x0) * 0.35, ye * 0.55);
        const pts = [];
        for (let k = 0; k <= 8; k++) {
          const t = k / 8, a = (1 - t) * (1 - t), b = 2 * t * (1 - t), c2 = t * t;
          pts.push(map(a * x0 + b * ctrl.x + c2 * xe, a * 0 + b * ctrl.y + c2 * ye));
        }
        veinPolys.push(pts);
      }
    }
  } else if (ven === 'palmate') {
    // main veins radiating from the base to the lobes / around the blade
    const cands = [];
    for (let i = 2; i < half.length - 1; i++) {
      const p = half[i], d = Math.hypot(p.x, p.y);
      const dp = Math.hypot(half[i - 1].x, half[i - 1].y), dn = Math.hypot(half[i + 1].x, half[i + 1].y);
      if (shape === 'palmate' ? (d >= dp && d >= dn && d > L * 0.4) : i % Math.max(2, Math.floor(half.length / 4)) === 0) cands.push(p);
    }
    for (const sd of [1, -1]) {
      for (const p of cands) {
        if (p.y < W * 0.05) continue;
        const e = P(p.x * 0.88, p.y * 0.88 * sd * (sd < 0 ? asym : 1));
        const ctrl = P(e.x * 0.5 - e.y * 0.08 * sd, e.y * 0.5);
        const pts = [];
        for (let k = 0; k <= 10; k++) {
          const t = k / 10, a = (1 - t) * (1 - t), b = 2 * t * (1 - t), c2 = t * t;
          pts.push(map(b * ctrl.x + c2 * e.x, b * ctrl.y + c2 * e.y));
        }
        veinPolys.push(pts);
      }
    }
    if (shape === 'peltate') {
      for (let k = 0; k < 9; k++) {
        const a = (k / 9) * TAU + 0.3;
        const pts = [];
        for (let i = 0; i <= 8; i++) pts.push(map(Math.cos(a) * W * 0.9 * (i / 8), Math.sin(a) * W * 0.9 * (i / 8)));
        veinPolys.push(pts);
      }
    }
  } else if (ven === 'parallel' && shape !== 'needle') {
    const vs = W * Math.abs(lf.f0) > 7 ? [-0.7, -0.4, -0.12, 0.12, 0.4, 0.7] : [-0.45, 0, 0.45];
    for (const v of vs) {
      const pts = [];
      for (let i = 0; i <= 26; i++) { const x = lerp(0.02, 0.96, i / 26) * L; pts.push(map(x, v * wAt(x))); }
      veinPolys.push(pts);
    }
  }
  if (variegation === 'veined' && !under) {
    for (const v of veinPolys) pushS(it.hatch, mkStroke(v, { w: 2.2, taper: 0.1, color: 'rgba(246,240,212,0.7)' }));
  }
  for (const v of veinPolys) pushS(it.hatch, mkStroke(v, { w: vw, taper: 0.05, taperEnd: 0.6, minW: 0.2, rng: r, jit: 0.1 }));

  // shading: hatching on the half turned from the light (and on any part turned over)
  const mid = map(L * 0.5, 0), side = map(L * 0.5, wAt(L * 0.5) + 0.01);
  const rightShaded = dot(nrm(sub(side, mid)), SHADOW) > 0;
  const fAbs = Math.max(0.25, Math.abs(lf.f0));
  if (feather) {
    for (const sd of [1, -1]) {
      for (let x = 2; x < L * 0.97; x += 1.9 / Math.sqrt(fAbs)) {
        const w0 = wAt(x + 0.18 * wAt(x));
        if (w0 < 0.8) continue;
        const a = map(x, 0), b = map(x + 0.42 * w0, sd * w0 * 0.97), m2 = map(x + 0.2 * w0, sd * w0 * 0.5);
        pushS(it.hatch, mkHatch(a, b, 0.3, null, m2));
      }
    }
  } else if (shape === 'terete' || (fleshy && ['ovate', 'lanceolate', 'orbicular'].includes(shape))) {
    const sd = rightShaded ? 1 : -1;
    const ks = shape === 'terete' ? [0.42, 0.6, 0.74, 0.86] : [0.55, 0.72, 0.86];
    for (const k of ks) {
      const pts = [];
      for (let i = 0; i <= 24; i++) { const x = lerp(0.04, shape === 'terete' ? 0.93 : 0.88, i / 24) * L; pts.push(map(x, sd * k * wAt(x))); }
      pushS(it.hatch, mkStroke(pts, { w: 0.4, taper: 0.15, rng: r, jit: 0.1 }));
    }
    for (let x = L * 0.05; x < L * 0.9; x += 2.6) {
      const w0 = wAt(x);
      const a = map(x, sd * w0 * 0.97), b = map(x - w0 * 0.2, sd * w0 * 0.55), m2 = map(x - w0 * 0.08, sd * w0 * 0.8);
      pushS(it.hatch, mkHatch(a, b, 0.36, null, m2));
    }
    const hl = [];
    for (let i = 0; i <= 18; i++) { const x = lerp(0.1, 0.75, i / 18) * L; hl.push(map(x, -sd * 0.45 * wAt(x))); }
    pushS(it.hatch, mkStroke(hl, { w: clamp(W * 0.18, 0.8, 2.4), taper: 0.3, color: 'rgba(255,251,238,0.75)' }));
  } else if (shape !== 'needle') {
    const sd = rightShaded ? 1 : -1;
    const hpoly = (sd > 0 ? half : halfL).concat([P(L, 0), P(0, 0)]);
    const sp = 2.75 / Math.sqrt(fAbs);
    const ang = sd * rad(52);
    const wob = wobble(r, L * 0.5);
    for (const [a, b] of hatchPoly(hpoly, ang, sp, r.next())) {
      const marginEnd = Math.abs(a.y) > Math.abs(b.y) ? a : b, inner = marginEnd === a ? b : a;
      const frac = clamp(0.42 + 0.32 * wob(marginEnd.x) + (under ? 0.2 : 0), 0.15, 1);
      const e0 = lerpP(marginEnd, inner, 0.04), e1 = lerpP(marginEnd, inner, frac);
      const m = lerpP(e0, e1, 0.5);
      pushS(it.hatch, mkHatch(map(e0.x, e0.y), map(e1.x, e1.y), 0.47, null, map(m.x, m.y)));
    }
    // the turned-over part of a twisted leaf is all in shadow
    if (flipX != null) {
      const fp = half.filter((p) => p.x >= flipX).concat(halfL.filter((p) => p.x >= flipX).reverse());
      if (fp.length > 3) {
        for (const [a, b] of hatchPoly(fp, -ang * 0.6, 2.4, 0.3)) {
          const m = lerpP(a, b, 0.5);
          pushS(it.hatch, mkHatch(map(a.x, a.y), map(b.x, b.y), 0.33, null, map(m.x, m.y)));
        }
      }
    }
    // a few strokes beside the midrib on the lit half (the fold of the blade)
    if (L > 60 && ven !== 'parallel') {
      for (let x = L * 0.1; x < L * 0.8; x += 3.2) {
        if (r.chance(0.5)) continue;
        const w0 = wAt(x);
        pushS(it.hatch, mkHatch(map(x, -sd * 1.2), map(x - w0 * 0.08, -sd * w0 * r.float(0.12, 0.22)), 0.3));
      }
    }
  }
  if (fleshy && shape !== 'terete') {
    const rim = [];
    const sd = rightShaded ? 1 : -1;
    for (let i = 0; i <= 24; i++) { const x = lerp(0.06, 0.95, i / 24) * L; rim.push(map(x, sd * Math.max(0, wAt(x) - clamp(W * 0.12, 1.2, 4)))); }
    pushS(it.hatch, mkStroke(rim, { w: 0.5, taper: 0.2 }));
  }
  if (E.g.leaf.margin === 'ciliate' && !feather) {
    for (const h of [R, Lh]) {
      const cl = cumLen(h), tot = cl[cl.length - 1];
      for (let s = 2; s < tot - 2; s += r.float(2.6, 4.2)) {
        const { p, tan } = along(h, s / tot, cl);
        let n = perp(tan);
        if (dot(n, sub(p, cc)) < 0) n = mul(n, -1);
        const d = nrm(add(n, mul(tan, 0.8)));
        pushS(it.hatch, mkHatch(p, add(p, mul(d, r.float(2.5, 4.5))), 0.28));
      }
    }
  }
  E.items.push(it);
  return it;
}

// Inverse helper: where along the leaf the twist turns it edge-on.
function acosSmoothInv(v) {
  // solve smoothstep(0.3,1,x) = v for x in [0,1] -> fraction of (1-0.3) range
  let lo = 0, hi = 1;
  for (let i = 0; i < 20; i++) { const m = (lo + hi) / 2; const s = m * m * (3 - 2 * m); if (s < v) lo = m; else hi = m; }
  return (lo + hi) / 2;
}

function engraveLeaf(E, lf) {
  const r = E.r;
  const key = -lf.at.y * 0.001;
  // petiole
  const pe = petioleEnd(lf);
  if (lf.pet > 1 && !lf.floating) {
    const pts = spline([lf.at, add(lerpP(lf.at, pe, 0.5), mul(perp(dirOf(lf.ang)), lf.pet * lf.petBend * 0.2)), pe], 6);
    const w = clamp(lf.L * 0.022, 1.2, 3.6);
    engraveStem(E, { pts, w0: w, w1: w * 0.75, z: lf.z - 0.05, kind: 'petiole', key: 30 + key, armature: 'none' }, 3);
  }
  if (lf.shape === 'pinnate') return engravePinnate(E, lf, pe, key);
  if (lf.shape === 'needle') {
    // needles come in little bundles
    const n = r.int(2, 4);
    for (let i = 0; i < n; i++) engraveBlade(E, { ...lf, ang: lf.ang + (i - (n - 1) / 2) * 0.22, L: lf.L * r.float(0.8, 1.1), z: lf.z + i * 0.01 }, { base: pe, key });
    return;
  }
  return engraveBlade(E, { ...lf, fleshy: E.g.leaf.fleshy }, { base: pe, key });
}

function engravePinnate(E, lf, base, key) {
  const r = E.r;
  const spine = leafSpine(lf, base, 30);
  engraveStem(E, { pts: spine, w0: clamp(lf.L * 0.012, 1, 2.6), w1: 0.8, z: lf.z - 0.04, kind: 'rachis', key: 30 + key, armature: 'none' }, 3);
  const cl = cumLen(spine);
  const pairs = clamp(Math.round(lf.L / 38), 3, 8);
  const lshape = r.chance(0.6) ? 'lanceolate' : 'ovate';
  const ll = lf.L * r.float(0.26, 0.36);
  for (let i = 0; i < pairs; i++) {
    const u = lerp(0.12, 0.86, i / Math.max(1, pairs - 1));
    const { p, tan } = along(spine, u, cl);
    const a0 = angOf(tan);
    for (const sd of [-1, 1]) {
      const leaflet = { at: p, ang: a0 + sd * rad(r.float(55, 75)), L: ll * lerp(1, 0.7, u) * r.float(0.9, 1.05), W: 0, pet: 0, shape: lshape,
        droop: lf.droop * 0.5, f0: lf.f0 * r.float(0.8, 1), twist: r.chance(0.15) ? 0.6 : 0, z: lf.z + (sd > 0 ? 0.02 : 0.01) + i * 0.001, curl: r.float(-0.2, 0.2), petBend: 0 };
      leaflet.W = leaflet.L * (lshape === 'ovate' ? 0.34 : 0.22);
      engraveBlade(E, leaflet, { base: p, key: key + 0.0001 * i });
    }
  }
  const end = spine[spine.length - 1];
  const term = { at: end, ang: angOf(sub(end, spine[spine.length - 2])), L: ll * 1.05, W: 0, pet: 0, shape: lshape, droop: lf.droop * 0.4, f0: lf.f0, twist: 0, z: lf.z + 0.03, curl: 0, petBend: 0 };
  term.W = term.L * (lshape === 'ovate' ? 0.34 : 0.22);
  engraveBlade(E, term, { base: end, key: key + 0.001 });
}

// ================================================================== engraving: flowers
//
// Flowers are built in 3-D (x, y on the plate, z towards the viewer) and seen in
// orthographic projection: each petal is a small curved surface swept out from
// the receptacle, so the same machinery gives face-on stars, bells seen from the
// side, nodding lanterns and three-quarter cups. Parts are depth sorted.

function flowerFrame(A) {
  A = nrm3(A);
  const up = V3(0, -1, 0);
  let U = sub3(up, mul3(A, dot3(up, A)));
  if (len3(U) < 0.12) { const alt = V3(1, 0, 0); U = sub3(alt, mul3(A, dot3(alt, A))); }
  U = nrm3(U);
  return { A, U, V: cross3(A, U) };
}

const PPROF = {
  obovate: (t) => Math.pow(Math.sin(Math.PI * Math.pow(t, 1.3)), 0.68),
  elliptic: (t) => Math.pow(Math.sin(Math.PI * t), 0.6),
  lanceolate: (t) => Math.pow(Math.sin(Math.PI * Math.pow(t, 0.75)), 0.85),
  spatulate: (t) => Math.pow(Math.sin(Math.PI * Math.pow(t, 1.9)), 0.45) * 0.95 + 0.05 * (1 - t),
  bell: (t) => (0.5 + 0.5 * smoothstep(0, 0.75, t)) * Math.pow(Math.max(0, Math.sin(Math.PI * clamp(0.5 + (t - 0.62) / 0.76, 0, 1))), 0.5),
  tube: (t) => (t < 0.68 ? 0.56 + 0.1 * t : 0.62 + 0.38 * Math.pow(Math.sin(Math.PI * clamp((t - 0.68) / 0.32 * 0.5 + 0.5 * smoothstep(0.68, 1, t), 0, 1)), 0.5)) * (t > 0.68 ? Math.pow(Math.sin(Math.PI * (0.5 + (t - 0.68) / 0.64)), 0.4) : 1),
  lantern: (t) => Math.pow(Math.sin(Math.PI * Math.pow(t, 0.9)), 0.55),
  round: (t) => Math.pow(Math.sin(Math.PI * Math.pow(t, 0.95)), 0.55),
};

function withTip(prof, tip) {
  if (tip === 'acute') return (t) => prof(t) * Math.min(1, Math.pow(Math.max(0, (1 - t) / 0.4), 0.8) + 0.02);
  if (tip === 'filiform') return (t) => (t < 0.7 ? prof(t / 0.7 * 0.82) * Math.min(1, Math.pow(Math.max(0, (0.7 - t) / 0.3), 0.8) + 0.08) : 0.05 * (1 - (t - 0.7) / 0.75));
  return prof;
}

// Petal and sepal specs for a corolla of `form`.
function corollaSpecs(form, m, whorls, tip, r) {
  const specs = [];
  const pet = (phi, o) => specs.push({ phi, kind: 'petal', tip, cup: 0.15, twist: () => 0, r0: 0.07, h0: 0.0, L: 1, W: 0.4, prof: PPROF.obovate, gamma: () => 0, layer: 0, ...o });
  const wid = (a, b) => Math.min(a, b / m);
  const ph0 = form === 'labiate' ? Math.PI + r.float(-0.05, 0.05) : r.float(-0.25, 0.25);
  const each = (fn) => { for (let i = 0; i < m; i++) fn(ph0 + (i * TAU) / m, i); };
  switch (form) {
    case 'rotate':
      each((phi) => pet(phi, { L: 0.97, W: wid(0.56, 2.35), gamma: (t) => rad(5 + 16 * t * t), cup: 0.22, prof: PPROF.obovate }));
      break;
    case 'stellate':
      each((phi) => pet(phi, { L: 1.0, W: wid(0.3, 1.25), gamma: (t) => rad(4 + 6 * t - 10 * t * t), cup: 0.12, prof: PPROF.lanceolate, r0: 0.05 }));
      break;
    case 'campanulate':
      each((phi) => pet(phi, { L: 1.0, W: wid(0.66, 2.85), gamma: (t) => rad(lerp(72, 22, Math.pow(t, 1.7))), cup: -0.06, prof: PPROF.bell, r0: 0.1 }));
      break;
    case 'tubular':
      each((phi) => pet(phi, { L: 1.15, W: wid(0.4, 1.6), gamma: (t) => rad(t < 0.68 ? 84 : lerp(84, -12, smoothstep(0.68, 1, t))), cup: 0.02, prof: PPROF.tube, r0: 0.08 }));
      break;
    case 'cup':
      each((phi) => pet(phi, { L: 0.92, W: wid(0.62, 2.75), gamma: (t) => rad(lerp(46, 66, t)), cup: 0.28, prof: PPROF.obovate, r0: 0.1 }));
      break;
    case 'lantern':
      each((phi) => pet(phi, { L: 1.2, W: wid(0.7, 2.95), gamma: (t) => rad(lerp(22, 150, smoothstep(0, 1, t))), cup: 0.22, prof: PPROF.lantern, r0: 0.08 }));
      break;
    case 'labiate':
      each((phi) => {
        const d = Math.abs(wrapA(phi));
        if (d < Math.PI / 2.1) pet(phi, { L: 1.1, W: wid(0.36, 1.7), gamma: (t) => rad(t < 0.35 ? 76 : lerp(76, 165, smoothstep(0.35, 1, t))), cup: 0.5, prof: PPROF.elliptic, r0: 0.07 });
        else {
          const middle = Math.abs(d - Math.PI) < 0.3;
          pet(phi, { L: middle ? 1.08 : 0.85, W: wid(middle ? 0.82 : 0.4, middle ? 3.8 : 1.9), gamma: (t) => rad(t < 0.35 ? 76 : lerp(76, middle ? -60 : -15, smoothstep(0.3, 0.62, t))), cup: middle ? -0.18 : 0.2, prof: PPROF.spatulate, r0: 0.07, lip: middle });
        }
      });
      break;
    case 'globose': {
      // a ball of many rounded, cupped petals: wide outer guard petals, ever tighter inner ones
      const nl = clamp(whorls + 3, 4, 6);
      for (let j = 0; j < nl; j++) {
        const u = j / (nl - 1);
        const n = Math.max(4, Math.round(m * lerp(1, 1.6, u)));
        for (let i = 0; i < n; i++) {
          const phi = ph0 + ((i + (j % 2) * 0.5) * TAU) / n + r.float(-0.15, 0.15);
          const lk = r.float(0.88, 1.08);
          pet(phi, { L: lerp(1, 0.42, Math.pow(u, 0.8)) * lk, W: Math.min(lerp(0.5, 0.34, u), lerp(2.6, 3.2, u) / n) * r.float(0.85, 1.12), gamma: (t) => rad(lerp(14, 78, u) + lerp(28, 60, u) * t * t), cup: lerp(0.35, 0.6, u), prof: PPROF.round, r0: lerp(0.08, 0.02, u), h0: 0.06 * u, layer: j });
        }
      }
      break;
    }
    case 'spiral':
      each((phi) => pet(phi, { L: 1.08, W: wid(0.32, 1.45), gamma: (t) => rad(8 + 300 * Math.pow(smoothstep(0.42, 1, t), 1.2)), twist: (t) => 0.95 * t * t, cup: 0.1, prof: PPROF.lanceolate, r0: 0.08 }));
      break;
    default:
      each((phi) => pet(phi, { L: 1, W: wid(0.55, 2.5), gamma: (t) => rad(10 + 10 * t), prof: PPROF.obovate }));
  }
  // double flowers: inner whorls
  if (form !== 'globose' && whorls > 1) {
    const base = specs.slice();
    for (let w = 1; w < whorls; w++) {
      for (const sp of base) {
        const g0 = sp.gamma;
        specs.push({ ...sp, phi: sp.phi + Math.PI / m, L: sp.L * (1 - 0.22 * w), W: sp.W * (1 - 0.1 * w), gamma: (t) => g0(t) + rad(14 * w), layer: w, r0: sp.r0 * 0.8, h0: 0.03 * w });
      }
    }
  }
  // the calyx
  const bellish = ['campanulate', 'tubular', 'lantern', 'labiate', 'cup'].includes(form);
  for (let i = 0; i < m; i++) {
    specs.push({ phi: ph0 + ((i + 0.5) * TAU) / m, kind: 'sepal', tip: 'acute', cup: 0.1, twist: () => 0, r0: 0.05, h0: -0.03,
      L: bellish ? 0.36 : 0.5, W: Math.min(0.2, 0.95 / m), prof: PPROF.lanceolate,
      gamma: bellish ? (t) => rad(lerp(70, 35, t)) : (t) => rad(-12 - 8 * t), layer: -1 });
  }
  return specs;
}

// The swept surface of one petal: (t, y) -> 3-D.  y is in half-widths.
function petalSurface(F, c3, R, sp) {
  const N = 30, tMax = sp.tip === 'filiform' ? 1.5 : 1.05;
  const cl = [], ns = [], ts = [];
  const rOf = (phi) => add3(mul3(F.U, Math.cos(phi)), mul3(F.V, Math.sin(phi)));
  let p = add3(c3, add3(mul3(rOf(sp.phi), sp.r0 * R), mul3(F.A, sp.h0 * R)));
  for (let k = 0; k <= N; k++) {
    const t = (k / N) * tMax;
    const tc = Math.min(1, t);
    const rr = rOf(sp.phi + sp.twist(tc));
    const g = sp.gamma(tc);
    const d = add3(mul3(rr, Math.cos(g)), mul3(F.A, Math.sin(g)));
    const n = add3(mul3(rr, -Math.sin(g)), mul3(F.A, Math.cos(g)));
    cl.push(p); ns.push(n); ts.push(cross3(F.A, rr));
    p = add3(p, mul3(d, (sp.L * R * tMax) / N));
  }
  const W = sp.W * R;
  const at = (t, y) => {
    const k = clamp((t / tMax) * N, 0, N - 1e-6), i = Math.floor(k), f = k - i;
    const c = add3(mul3(cl[i], 1 - f), mul3(cl[i + 1], f));
    const tg = add3(mul3(ts[i], 1 - f), mul3(ts[i + 1], f));
    const n = add3(mul3(ns[i], 1 - f), mul3(ns[i + 1], f));
    return add3(add3(c, mul3(tg, y * W)), mul3(n, sp.cup * y * y * W));
  };
  const normal = (t, y) => {
    const e = 0.02;
    const a = sub3(at(t + e, y), at(t - e, y)), b = sub3(at(t, y + e), at(t, y - e));
    return nrm3(cross3(a, b));
  };
  return { at, normal, tMax };
}

function petalOutline(sp, r) {
  const prof = withTip(sp.prof, sp.tip);
  const tEnd = sp.tip === 'filiform' ? 1.45 : 1;
  const right = [], n = 34;
  for (let i = 0; i <= n; i++) { const t = (tEnd * (1 - Math.cos((Math.PI * i) / n))) / 2; right.push(P(t, Math.max(0, prof(Math.min(t, tEnd))))); }
  if (right[0].y > 0.01) right.unshift(P(0, 0));
  let out = right.concat(right.slice(0, -1).reverse().map((p) => P(p.x, -p.y)));
  if (sp.tip === 'notched') {
    const nd = r.float(0.08, 0.16);
    out = out.map((p) => (p.x > 0.7 ? P(p.x - nd * Math.exp(-Math.pow(p.y / 0.32, 2)) * smoothstep(0.7, 1, p.x), p.y) : p));
  } else if (sp.tip === 'fringed') {
    const dense = [];
    for (let i = 0; i < out.length - 1; i++) {
      const a = out[i], b = out[i + 1];
      const k = a.x > 0.72 || b.x > 0.72 ? 3 : 1;
      for (let j = 0; j < k; j++) dense.push(lerpP(a, b, j / k));
    }
    dense.push(out[out.length - 1]);
    const fd = r.float(0.07, 0.13);
    out = dense.map((p, i) => (p.x > 0.75 ? P(p.x - fd * (i % 2) * smoothstep(0.75, 0.92, p.x), p.y * (i % 2 ? 0.97 : 1.02)) : p));
  }
  return { out, prof, tEnd };
}

function proj(p) { return P(p.x, p.y); }

// Engrave a flower. fl: { c (2-D receptacle), axis, R, z, rank }.
function engraveFlower(E, fl, o = {}) {
  const r = E.r, pal = E.pal, g = E.g;
  const form = o.form || g.flower.form;
  const m = clamp(Math.round(o.m || g.flower.merosity || 5), 3, 14);
  const R = fl.R;
  if (!(R > 1.5) || !fin(fl.c)) return [];
  const F = flowerFrame(fl.axis);
  const c3 = V3(fl.c.x, fl.c.y, fl.dz || 0);
  const specs = corollaSpecs(form, m, clamp(Math.round(g.flower.whorls || 1), 1, 3), o.tip || g.flower.petalTip, r);
  const glass = E.marvel === 'glass';
  const zBase = fl.z + Math.min(fl.rank, 100) * 0.45;
  const phase = o.phase || 4;
  const key = o.key != null ? o.key : -fl.c.y * 0.001 + 0.5;
  const items = [];
  const petalsInfo = [];
  const zOf = (d) => zBase + clamp(d / (R * 3), -0.45, 0.45);
  const lineK = clamp(R / 48, 0.7, 1.2);
  const fused = FUSED.includes(form);
  if (fused) engraveFusedCorolla(E, fl, F, c3, form, m, o.tip || g.flower.petalTip, zOf, phase, key, lineK, items, petalsInfo, glass);
  for (const sp of specs) {
    if (fused && sp.kind === 'petal') continue;
    const surf = petalSurface(F, c3, R, sp);
    const { out, prof, tEnd } = petalOutline(sp, r);
    const W2 = out.map((q) => surf.at(q.x, q.y));
    const poly = W2.map(proj);
    if (!poly.every(fin)) continue;
    const area = Math.abs(polyArea(poly));
    let depth = 0;
    for (const q of [[0.3, 0], [0.6, 0.5], [0.6, -0.5], [0.9, 0]]) depth += surf.at(q[0], q[1]).z;
    depth /= 4;
    const nC = surf.normal(0.5, 0);
    const inner = nC.z > 0;                                 // we see the upper (inner) face
    const nVis = inner ? nC : mul3(nC, -1);
    const lum = dot3(nVis, LIGHT3);
    const sepal = sp.kind === 'sepal';
    const it = mkItem(zOf(depth) - (sepal ? 0.001 : 0), phase, key + (sepal ? -0.0002 : 0), { origin: proj(surf.at(0.05, 0)) });
    it.occ = glass && !sepal ? null : [poly];
    // colour
    let c0, c1, alpha = 0.72;
    if (sepal) { c0 = lighten(pal.leaf, 0.08); c1 = pal.leafShade; }
    else if (inner) { c0 = pal.inner; c1 = pal.flower; }
    else { c0 = darken(mixColor(pal.flower, pal.leaf, 0.12), 0.06); c1 = darken(pal.flower, 0.1); }
    if (glass && !sepal) { alpha = 0.32; c0 = lighten(c0, 0.35); c1 = lighten(c1, 0.3); }
    const b0 = proj(surf.at(0, 0)), b1 = proj(surf.at(0.95, 0));
    it.washes.push({ poly, color: c0, alpha, edge: area > 200 ? 0.8 : 0.3, shade: { from: b0, to: b1, color: c1, stops: [[0, c0], [inner && !sepal ? 0.42 : 0.6, mixColor(c0, c1, 0.7)], [1, c1]] }, blots: area > 600 ? 2 : 0 });
    if (lum < 0.15 && area > 80) it.washes.push({ poly, color: darken(c1, 0.25), alpha: clamp(0.25 - lum, 0.06, 0.32), edge: 0, blots: 0, hard: true });
    // outline
    const pc = centroid(poly);
    pushS(it.lines, mkStroke(poly, { w: (sepal ? 0.7 : 0.82) * lineK, center: pc, shade: 0.8, taper: 0.02, taperEnd: 0.04, rng: r, jit: 0.15, step: 1.6 }));
    // veins radiating from the base, following the petal's own shape
    const plen = dist(b0, proj(surf.at(1, 0))) + 0.5 * dist(proj(surf.at(0.5, -1)), proj(surf.at(0.5, 1)));
    if (plen > 14 && area > 60) {
      const nv = sepal ? 1 : clamp(Math.round(plen / 9), 2, 9) + (inner ? 0 : 2) + (E.pal.flower.l > 76 ? 2 : 0);
      for (let k = 0; k < nv; k++) {
        const v = nv === 1 ? 0 : lerp(-0.72, 0.72, k / (nv - 1)) + r.float(-0.05, 0.05);
        const te = Math.min(tEnd, (sp.tip === 'filiform' ? 0.65 : 1) * r.float(0.35, inner ? 0.75 : 0.9) * (1 - Math.abs(v) * 0.3));
        const pts = [];
        for (let i = 0; i <= 10; i++) { const t = lerp(0.04, te, i / 10); pts.push(proj(surf.at(t, v * prof(t) * 0.92))); }
        pushS(it.hatch, mkStroke(pts, { w: 0.4 + (inner ? 0 : 0.05), taper: 0.05, taperEnd: 0.7, minW: 0.2 }));
      }
    }
    // shading: contour hatching across the darker side of the petal
    const lumP = dot3(surf.normal(0.55, 0.6), LIGHT3) * (inner ? 1 : -1);
    const lumM = dot3(surf.normal(0.55, -0.6), LIGHT3) * (inner ? 1 : -1);
    const pale = !sepal && E.pal.flower.l > 76;
    const dark = clamp(0.5 - lum * 1.1 + (pale ? 0.2 : 0), 0, 1);
    if (plen > 15 && (dark > 0.18 || !inner)) {
      const sd = lumP < lumM ? 1 : -1;
      const spacing = 2.6;
      const cnt = Math.round(plen / spacing);
      const depthK = clamp(0.3 + dark * 0.9 + (inner ? 0 : 0.25), 0.25, 1);
      for (let k = 0; k < cnt; k++) {
        const t = lerp(0.08, 0.92, (k + 0.5) / cnt);
        const w0 = prof(t);
        if (w0 < 0.08) continue;
        const ya = sd * w0 * 0.95, yb = sd * w0 * (0.95 - 1.9 * depthK * r.float(0.55, 1));
        const pts = [0, 0.33, 0.66, 1].map((u) => proj(surf.at(t + u * 0.03, lerp(ya, yb, u))));
        pushS(it.hatch, mkStroke(pts, { w: plen < 30 ? 0.34 : 0.42, taper: 0.1, taperEnd: 0.3, minW: 0.2, step: 3 }));
      }
    }
    // fringe and filiform details
    if (sp.tip === 'filiform' && !sepal) {
      const th = [];
      for (let i = 0; i <= 16; i++) th.push(proj(surf.at(lerp(0.68, 1.45, i / 16), 0)));
      pushS(it.lines, mkStroke(th, { w: 0.55 * lineK, taper: 0, taperEnd: 0.8, minW: 0.2 }));
    }
    if (sp.lip && inner && plen > 12) {
      const gd = [];
      for (let k = 0; k < 26; k++) {
        const t = r.float(0.3, 0.62), y = r.float(-0.5, 0.5) * prof(t);
        const q = proj(surf.at(t, y));
        gd.push({ x: q.x, y: q.y, r: clamp(R * r.float(0.012, 0.022), 0.5, 1.6) });
      }
      it.dots.push({ pts: gd, color: css(darken(pal.inner, 0.45)) });
    }
    if (glass && !sepal) {
      const hl = [];
      for (let i = 0; i <= 10; i++) { const t = lerp(0.15, 0.78, i / 10); hl.push(proj(surf.at(t, -0.45 * prof(t)))); }
      pushS(it.hatch, mkStroke(hl, { w: clamp(R * 0.035, 0.8, 2.2), taper: 0.3, color: 'rgba(255,255,250,0.85)' }));
      const hl2 = [];
      for (let i = 0; i <= 6; i++) { const t = lerp(0.3, 0.6, i / 6); hl2.push(proj(surf.at(t, 0.3 * prof(t)))); }
      pushS(it.hatch, mkStroke(hl2, { w: clamp(R * 0.02, 0.5, 1.4), taper: 0.3, color: 'rgba(255,255,250,0.7)' }));
    }
    items.push(it);
    if (!sepal) petalsInfo.push({ surf, sp, poly, prof, tEnd, inner, depth, it });
  }
  // the heart of the flower
  const centre = engraveCentre(E, fl, F, c3, form, m, zOf, phase, key, petalsInfo);
  items.push(...centre);
  for (const it of items) E.items.push(it);
  // marvels that live in flowers
  flowerMarvels(E, fl, F, c3, form, m, zOf, phase, key, petalsInfo, o);
  return items;
}

function engraveCentre(E, fl, F, c3, form, m, zOf, phase, key, petals) {
  const r = E.r, pal = E.pal, g = E.g, R = fl.R;
  const out = [];
  const bell = ['campanulate', 'tubular', 'lantern'].includes(form);
  const stam = g.flower.stamens;
  const at3 = (h, rr, phi) => add3(add3(c3, mul3(F.A, h * R)), add3(mul3(F.U, Math.cos(phi) * rr * R), mul3(F.V, Math.sin(phi) * rr * R)));
  // disc / eye
  if (!bell && form !== 'globose') {
    const rd = form === 'stellate' ? 0.11 : form === 'labiate' ? 0.07 : 0.15;
    const h = form === 'cup' ? 0.18 : form === 'labiate' ? 0.25 : 0.07;
    const ring = [];
    for (let i = 0; i <= 28; i++) ring.push(at3(h, rd, (i / 28) * TAU));
    const poly = ring.map(proj);
    const depth = at3(h + 0.05, 0, 0).z;
    const it = mkItem(zOf(depth) + 0.02, phase, key + 0.0005, { origin: proj(at3(h, 0, 0)) });
    if (E.marvel === 'echoing') {
      // the throat is an ear: a spiral, the cochlea of the flower
      const sp = [];
      for (let i = 0; i <= 80; i++) { const u = i / 80; sp.push(proj(at3(h, rd * (1.25 - 1.1 * u), u * TAU * 2.6))); }
      it.washes.push({ poly, color: darken(pal.inner, 0.25), alpha: 0.7, edge: 0.5 });
      pushS(it.lines, mkStroke(sp, { w: 0.7, taper: 0.05, taperEnd: 0.4, step: 1.2 }));
      pushS(it.lines, mkStroke(poly, { w: 0.6, taper: 0, step: 1.5 }));
    } else {
      it.washes.push({ poly, color: form === 'cup' ? darken(pal.inner, 0.15) : pal.accent, alpha: 0.75, edge: 0.6, hard: false });
      pushS(it.lines, mkStroke(poly, { w: 0.55, taper: 0, step: 1.5, rng: r, jit: 0.1 }));
      const dots = [];
      const pc = centroid(poly), bb = bboxOf(poly);
      const nd = clamp(Math.round(Math.abs(polyArea(poly)) / 4), 6, 160);
      for (let i = 0; i < nd * 2 && dots.length < nd; i++) {
        const q = P(r.float(bb.x0, bb.x1), r.float(bb.y0, bb.y1));
        if (!inPoly(q, poly)) continue;
        const sh = dot(nrm(sub(q, pc)), SHADOW);
        if (r.next() < 0.35 + sh * 0.45) dots.push({ x: q.x, y: q.y, r: r.float(0.3, 0.55) });
      }
      it.dots.push({ pts: dots });
      // a ring of anthers round the disc
      if (stam !== 'plume') {
        const na = clamp(m * 2, 6, 16);
        const ad = [];
        for (let i = 0; i < na; i++) { const q = proj(at3(h + 0.04, rd * 1.12, (i / na) * TAU)); ad.push({ x: q.x, y: q.y, r: clamp(R * 0.018, 0.6, 1.6) }); }
        it.dots.push({ pts: ad });
      }
    }
    out.push(it);
  }
  // stamens and style
  if (stam === 'exserted' || stam === 'plume' || (stam === 'hidden' && !bell && form !== 'globose')) {
    const plume = stam === 'plume';
    const hidden = stam === 'hidden';
    const n = plume ? r.int(22, 36) : hidden ? clamp(m, 4, 8) : clamp(m * 2, 4, 10);
    const len = plume ? r.float(1.25, 1.7) : hidden ? 0.28 : bell ? r.float(1.15, 1.4) : r.float(0.55, 0.8);
    const spread = plume ? [rad(5), rad(70)] : bell ? [rad(4), rad(16)] : hidden ? [rad(40), rad(60)] : [rad(20), rad(45)];
    let depth = at3(len * 0.6, 0, 0).z;
    const it = mkItem(zOf(depth) + 0.03, phase, key + 0.0008, { origin: fl.c });
    const ad = [];
    for (let i = 0; i < n; i++) {
      const phi = (i / n) * TAU + r.float(-0.2, 0.2);
      const sp = r.float(spread[0], spread[1]);
      const L = len * r.float(0.85, 1.1);
      const d = add3(mul3(F.A, Math.cos(sp)), add3(mul3(F.U, Math.cos(phi) * Math.sin(sp)), mul3(F.V, Math.sin(phi) * Math.sin(sp))));
      const s0 = add3(c3, mul3(F.A, 0.06 * R));
      const tip = add3(s0, mul3(d, L * R));
      const midp = add3(lerp3(s0, tip, 0.5), mul3(sub3(mul3(d, dot3(d, F.A)), F.A), -0.08 * L * R));
      const pts = [];
      for (let k = 0; k <= 6; k++) { const t = k / 6; pts.push(proj(add3(add3(mul3(s0, (1 - t) * (1 - t)), mul3(midp, 2 * t * (1 - t))), mul3(tip, t * t)))); }
      pushS(it.lines, mkStroke(pts, { w: plume ? 0.3 : 0.42, taper: 0.02, taperEnd: 0.2, minW: 0.2, step: 3 }));
      const tp = proj(tip);
      if (plume) ad.push({ x: tp.x, y: tp.y, r: clamp(R * 0.012, 0.5, 1.1) });
      else {
        const ar = clamp(R * 0.045, 1, 3.6);
        const dd = nrm(sub(tp, pts[pts.length - 2]));
        const el = ellipsePts(add(tp, mul(dd, ar * 0.4)), ar, ar * 0.5, angOf(perp(dd)), 12);
        it.washes.push({ poly: el, color: pal.accent, alpha: 0.85, edge: 0.3, hard: true, blots: 0 });
        pushS(it.lines, mkStroke(el, { w: 0.45, taper: 0, step: 1 }));
      }
    }
    if (ad.length) it.dots.push({ pts: ad, color: INK });
    // the style and its stigma
    const sl = plume ? len * 1.1 : bell ? len * 1.08 : len * 0.9;
    const s0 = add3(c3, mul3(F.A, 0.05 * R)), s1 = add3(c3, mul3(F.A, sl * R));
    pushS(it.lines, mkStroke([proj(s0), proj(lerp3(s0, s1, 0.5)), proj(s1)], { w: 0.55, taper: 0, taperEnd: 0.1 }));
    for (let k = 0; k < 3; k++) {
      const phi = (k / 3) * TAU + 0.4;
      const e = add3(s1, add3(mul3(F.A, 0.04 * R), add3(mul3(F.U, Math.cos(phi) * 0.06 * R), mul3(F.V, Math.sin(phi) * 0.06 * R))));
      pushS(it.lines, mkStroke([proj(s1), proj(e)], { w: 0.5, taper: 0, taperEnd: 0.5 }));
    }
    out.push(it);
  }
  return out;
}

const lerp3 = (a, b, t) => V3(lerp(a.x, b.x, t), lerp(a.y, b.y, t), lerp(a.z, b.z, t));

const FUSED = ['campanulate', 'tubular', 'lantern'];

// A fused corolla (bell, tube, lantern) as a surface of revolution with a lobed rim:
// Q(t, phi) = c + A h(t) + e(phi) rho(t). Drawn as narrow depth-sorted patches, with
// the true silhouette (where the surface turns away from the eye) found analytically.
function engraveFusedCorolla(E, fl, F, c3, form, m, tip, zOf, phase, key, lineK, items, petalsInfo, glass) {
  const r = E.r, pal = E.pal, R = fl.R;
  const sp = corollaSpecs(form, m, 1, tip, r)[0];
  const N = 48;
  const rho = new Float64Array(N + 1), hh = new Float64Array(N + 1), dr = new Float64Array(N + 1), dh = new Float64Array(N + 1);
  let rr = Math.max(sp.r0, 0.06) * R, h = 0;
  for (let k = 0; k <= N; k++) {
    const g = sp.gamma(k / N);
    rho[k] = rr; hh[k] = h; dr[k] = Math.cos(g); dh[k] = Math.sin(g);
    rr = Math.max(0.02 * R, rr + (Math.cos(g) * sp.L * R) / N); h += (Math.sin(g) * sp.L * R) / N;
  }
  const lk = (arr, t) => { const k = clamp(t * N, 0, N - 1e-6), i = Math.floor(k), f = k - i; return arr[i] * (1 - f) + arr[i + 1] * f; };
  const eOf = (phi) => add3(mul3(F.U, Math.cos(phi)), mul3(F.V, Math.sin(phi)));
  const at = (t, phi) => add3(c3, add3(mul3(F.A, lk(hh, t)), mul3(eOf(phi), lk(rho, t))));
  const outN = (t, phi) => nrm3(sub3(mul3(eOf(phi), lk(dh, t)), mul3(F.A, lk(dr, t))));
  const D = { campanulate: 0.24, tubular: 0.3, lantern: 0.09 }[form] || 0.2;
  const phi0 = sp.phi;
  const step = TAU / m;
  const vOf = (phi) => { let u = wrapA(phi - phi0) / step; u -= Math.round(u); return u * 2; };   // -1..1 across a lobe
  const fringe = tip === 'fringed';
  const tTop = (phi) => {
    const v = vOf(phi), av = Math.abs(v);
    let t;
    if (tip === 'acute' || tip === 'filiform') t = 1 - D * Math.pow(av, 0.9);
    else t = 1 - D * (1 - Math.sqrt(Math.max(0, 1 - av * av)));
    if (tip === 'notched') t -= D * 0.3 * Math.exp(-Math.pow(v / 0.18, 2));
    if (fringe && av < 0.9) t -= D * 0.12 * (Math.floor((v + 1) * 9) % 2);
    return t;
  };
  const ks = 4;
  const view = V3(0, 0, 1);
  // the deep throat, seen through the bottom of the bell
  {
    const th = [];
    const rr0 = lk(rho, 0.06) * 1.15;
    for (let i = 0; i <= 24; i++) th.push(proj(add3(add3(c3, mul3(F.A, lk(hh, 0.03))), mul3(eOf((i / 24) * TAU), rr0))));
    const ti = mkItem(zOf(-R * 3), phase, key, { origin: proj(c3) });
    ti.occ = glass ? null : [th];
    ti.washes.push({ poly: th, color: darken(pal.inner, 0.35), alpha: 0.8, hard: true, edge: 0.3, blots: 0 });
    const dots = [];
    const bb = bboxOf(th);
    for (let k = 0; k < 40; k++) { const q = P(r.float(bb.x0, bb.x1), r.float(bb.y0, bb.y1)); if (inPoly(q, th)) dots.push({ x: q.x, y: q.y, r: 0.4 }); }
    ti.dots.push({ pts: dots });
    items.push(ti);
  }
  const shadeK = (t, phi) => { const n = outN(t, phi); const vis = dot3(n, view) >= 0 ? n : mul3(n, -1); return dot3(vis, LIGHT3); };
  // silhouette: n.z = 0  <=>  e(phi).z * dh = A.z * dr
  const K = Math.hypot(F.U.z, F.V.z), ph0 = Math.atan2(F.V.z, F.U.z);
  const silh = [[], []];
  if (K > 1e-4) {
    for (let k = 1; k <= 60; k++) {
      const t = k / 60;
      const den = lk(dh, t) * K;
      if (Math.abs(den) < 1e-6) { silh[0].push(null); silh[1].push(null); continue; }
      const q = (F.A.z * lk(dr, t)) / den;
      if (Math.abs(q) > 1) { silh[0].push(null); silh[1].push(null); continue; }
      const a = Math.acos(q);
      for (const [j, phi] of [[0, ph0 + a], [1, ph0 - a]]) silh[j].push(t <= tTop(phi) ? { t, phi } : null);
    }
  }
  const patches = [];
  // where the surface turns back towards the axis (a lantern's equator) the projection of a
  // sector folds over itself; sectors are split there into two bands.
  let tEq = null;
  for (let k = 1; k < N; k++) if (dr[k] < 0 && dr[k - 1] >= 0) { tEq = k / N; break; }
  if (tEq != null && tEq > 0.9) tEq = null;
  const makePatch = (i, j, pa, pb, t0, t1fn, rimmed) => {
    const pts3 = [];
    const nb = 3;
    for (let k = 0; k <= nb; k++) pts3.push(at(t0, lerp(pa, pb, k / nb)));
    const tb = t1fn(pb - 1e-4), ta = t1fn(pa + 1e-4);
    for (let k = 1; k <= 10; k++) pts3.push(at(lerp(t0, tb, k / 10), pb));
    const rimN = fringe && rimmed ? 18 : 8;
    const rim3 = [];
    for (let k = 0; k <= rimN; k++) { const phi = lerp(pb, pa, k / rimN); rim3.push(at(t1fn(phi + (k === 0 ? -1e-4 : k === rimN ? 1e-4 : 0)), phi)); }
    pts3.push(...rim3.slice(1));
    for (let k = 9; k >= 1; k--) pts3.push(at(lerp(t0, ta, k / 10), pa));
    const poly = pts3.map(proj);
    if (!poly.every(fin)) return;
    const pm = (pa + pb) / 2;
    const tm = (t0 + t1fn(pm)) / 2;
    let depth = 0;
    for (const u of [0.2, 0.5, 0.8]) depth += at(lerp(t0, t1fn(pm), u), pm).z;
    depth /= 3;
    const nC = outN(tm, pm);
    const outer = nC.z >= 0;
    const lum = shadeK(tm, pm);
    const it = mkItem(zOf(depth), phase, key + 0.0001 * (i + 1) + (rimmed ? 0 : -0.00005), { origin: proj(at(t0 + 0.03, pm)) });
    it.occ = glass ? null : [poly];
    let c0, c1;
    if (outer) { c0 = mixColor(pal.flower, pal.leaf, 0.18); c1 = pal.flower; }
    else { c0 = darken(pal.inner, 0.05); c1 = mixColor(pal.inner, pal.flower, 0.75); }
    let alpha = 0.74;
    if (glass) { alpha = 0.3; c0 = lighten(c0, 0.35); c1 = lighten(c1, 0.3); }
    it.washes.push({ poly, color: c0, alpha, edge: 0.35, blots: 0, shade: { from: proj(at(0, pm)), to: proj(at(0.95, pm)), color: c1, stops: [[0, c0], [0.55, mixColor(c0, c1, 0.75)], [1, c1]] } });
    if (lum < 0.1) it.washes.push({ poly, color: darken(c1, 0.3), alpha: clamp(0.18 - lum * 0.5, 0.05, 0.35), edge: 0, blots: 0, hard: true });
    // the rim
    if (rimmed) pushS(it.lines, mkStroke(rim3.map(proj), { w: 0.95 * lineK * (fringe ? 0.7 : 1), center: proj(at(0.5, pm)), shade: 0.7, taper: 0, jit: 0.1, rng: r, step: 1.2 }));
    // seams between the fused petals, and the midveins
    if (j === 0) { const sm = []; for (let k = 0; k <= 10; k++) sm.push(proj(at(lerp(Math.max(t0, 0.05), ta * 0.95, k / 10), pa))); pushS(it.hatch, mkStroke(sm, { w: 0.42, taper: rimmed ? 0 : 0.1, taperEnd: rimmed ? 0.3 : 0 })); }
    if (j === ks / 2) { const mv = []; for (let k = 0; k <= 10; k++) mv.push(proj(at(lerp(Math.max(t0, 0.05), t1fn(pa) * (rimmed ? 0.9 : 1), k / 10), pa))); pushS(it.hatch, mkStroke(mv, { w: 0.4, taper: 0.1, taperEnd: rimmed ? 0.5 : 0 })); }
    // meridian hatching on the side in shadow, with cross contours where it is darkest
    const dark = clamp(0.42 - lum + (pal.flower.l > 76 ? 0.18 : 0), 0, 1);
    const plen = dist(proj(at(t0, pm)), proj(at(t1fn(pm), pm)));
    const pwid = dist(proj(at(tm, pa)), proj(at(tm, pb)));
    if (dark > 0.08 && plen > 6) {
      const nm = clamp(Math.round(pwid / 2.7), 1, 8);
      for (let q = 0; q < nm; q++) {
        const phi = lerp(pa, pb, (q + 0.5) / nm);
        const t1 = t1fn(phi) * (rimmed ? 0.96 : 1), tA = Math.max(t0 + 0.01, t1 - (t1 - t0) * clamp(dark * 1.6 + r.float(-0.1, 0.15), 0.25, 0.95));
        const pts = [];
        for (let k = 0; k <= 8; k++) pts.push(proj(at(lerp(tA, t1, k / 8), phi)));
        pushS(it.hatch, mkStroke(pts, { w: 0.42, taper: 0.25, taperEnd: 0.05, minW: 0.2, step: 3 }));
      }
      if (dark > 0.32) {
        const np = clamp(Math.round(plen / 3.2), 2, 30);
        for (let q = 0; q < np; q++) {
          const tq = lerp(t0 + 0.04, 0.9, (q + 0.5) / np);
          const pts = [];
          for (let k = 0; k <= 5; k++) { const phi = lerp(pa, pb, k / 5); pts.push(proj(at(Math.min(tq, t1fn(phi) * 0.95), phi))); }
          pushS(it.hatch, mkStroke(pts, { w: 0.36, taper: 0.2 }));
        }
      }
    }
    if (fringe && rimmed) {
      for (let k = 0; k < 4; k++) {
        const phi = lerp(pa, pb, (k + 0.5) / 4);
        pushS(it.hatch, mkHatch(proj(at(tTop(phi), phi)), proj(at(tTop(phi) * 0.9, phi)), 0.35));
      }
    }
    if (glass && j === 1 && rimmed) {
      const hl = [];
      for (let k = 0; k <= 8; k++) hl.push(proj(at(lerp(Math.max(0.2, t0), 0.8, k / 8), pm)));
      pushS(it.hatch, mkStroke(hl, { w: clamp(R * 0.03, 0.7, 2), taper: 0.3, color: 'rgba(255,255,250,0.85)' }));
    }
    patches.push({ it, pa, pb, t0, t1: rimmed ? 2 : t1fn(pm), outer });
    items.push(it);
    if (j === 1 && rimmed) {
      // a stand-in "petal" for marvels that look for petal tips
      const surf = { at: (t, y) => at(t * tTop(pm), pm + y * step * 0.3) };
      petalsInfo.push({ surf, sp: { ...sp, phi: pm }, poly, prof: () => 1, tEnd: 1, inner: !outer, depth, it });
    }
  };
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < ks; j++) {
      const va = -1 + (2 * j) / ks, vb = -1 + (2 * (j + 1)) / ks;
      const pa = phi0 + (i + va / 2) * step, pb = phi0 + (i + vb / 2) * step;
      if (tEq != null) {
        makePatch(i, j, pa, pb, 0.02, () => tEq, false);
        makePatch(i, j, pa, pb, tEq, tTop, true);
      } else makePatch(i, j, pa, pb, 0.02, tTop, true);
    }
  }
  // the silhouette lines, given to the patch they lie on
  for (const line of silh) {
    let run = [], owner = null;
    const flush = () => { if (owner && run.length > 1) pushS(owner.it.lines, mkStroke(run.map((q) => proj(at(q.t, q.phi))), { w: 1.0 * lineK, taper: 0.05, center: proj(at(0.5, 0)), shade: 0.7, jit: 0.1, rng: r })); run = []; };
    for (const q of line) {
      if (!q) { flush(); owner = null; continue; }
      const pt = patches.find((pp) => { const d = wrapA(q.phi - pp.pa), w = wrapA(pp.pb - pp.pa); return d >= -1e-6 && d <= w + 1e-6 && q.t >= pp.t0 - 1e-6 && q.t <= pp.t1 + 1e-6; });
      if (pt !== owner) { if (run.length) { const last = run[run.length - 1]; flush(); run = [last]; } owner = pt; }
      run.push(q);
    }
    flush();
  }
}

// ---------------------------------------------------------------- buds

function engraveBud(E, b, o = {}) {
  const r = E.r, pal = E.pal;
  const Rb = b.R;
  if (!(Rb > 1) || !fin(b.c)) return;
  const d = dirOf(b.dir), n = perp(d);
  const Lb = Rb * (['tubular', 'lantern', 'campanulate'].includes(E.g.flower.form) ? 1.9 : 1.45);
  const wb = Rb * 0.55;
  const prof = (t) => Math.pow(Math.sin(Math.PI * Math.pow(t, 0.62)), 0.75);
  const at = (t, y) => add(add(b.c, mul(d, t * Lb)), mul(n, y * wb));
  const right = [], left = [];
  for (let i = 0; i <= 24; i++) { const t = i / 24; right.push(at(t, prof(t))); left.push(at(t, -prof(t) * 0.95)); }
  const poly = right.concat(left.slice().reverse());
  const it = mkItem((b.z || 40) + Math.min(b.rank || 0, 100) * 0.45, o.phase || 4, o.key != null ? o.key : -b.c.y * 0.001 + 0.5, { origin: b.c });
  it.occ = [poly];
  const cc = centroid(poly);
  it.washes.push({ poly, color: lighten(E.pal.flower, 0.15), alpha: 0.72, shade: { from: at(0, 0), to: at(1, 0), color: E.pal.flower, stops: [[0, pal.leaf], [0.35, mixColor(pal.leaf, pal.flower, 0.6)], [1, pal.flower]] } });
  pushS(it.lines, mkStroke(right, { w: 0.8, center: cc, shade: 0.8, taper: 0.05, rng: r, jit: 0.12 }));
  pushS(it.lines, mkStroke(left, { w: 0.8, center: cc, shade: 0.8, taper: 0.05, rng: r, jit: 0.12 }));
  // the furled petal edges, twisting round the bud
  const tw = E.g.flower.form === 'spiral' ? 0.9 : 0.35;
  for (let k = 0; k < 3; k++) {
    const pts = [];
    const y0 = lerp(-0.7, 0.7, (k + 0.5) / 3);
    for (let i = 0; i <= 12; i++) { const t = lerp(0.12, 0.98, i / 12); pts.push(at(t, clamp(y0 + tw * (t - 0.5), -1, 1) * prof(t) * 0.92)); }
    pushS(it.hatch, mkStroke(pts, { w: 0.4, taper: 0.1, taperEnd: 0.4 }));
  }
  const sd = dot(n, SHADOW) > 0 ? 1 : -1;
  for (let t = 0.1; t < 0.92; t += 2.4 / Lb) {
    const w0 = prof(t);
    pushS(it.hatch, mkHatch(at(t, sd * w0 * 0.95), at(t + 0.05, sd * w0 * 0.35), 0.33, null, at(t + 0.02, sd * w0 * 0.68)));
  }
  E.items.push(it);
  // sepals clasping the base
  const sit = mkItem(it.z + 0.01, it.phase, it.key + 0.0001, { origin: b.c });
  for (const sy of [-1, 0.15, 1]) {
    const sl = Lb * r.float(0.32, 0.45);
    const pts = [];
    const base = at(0.02, sy * 0.35);
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      const w = Math.sin(Math.PI * Math.pow(t, 0.7)) * Rb * 0.16;
      pts.push(add(add(base, mul(d, t * sl)), mul(n, (sy * prof(t * sl / Lb) * wb * 0.85) + w)));
    }
    for (let i = 10; i >= 0; i--) {
      const t = i / 10;
      const w = Math.sin(Math.PI * Math.pow(t, 0.7)) * Rb * 0.16;
      pts.push(add(add(base, mul(d, t * sl)), mul(n, (sy * prof(t * sl / Lb) * wb * 0.85) - w)));
    }
    sit.washes.push({ poly: pts, color: pal.leaf, alpha: 0.7, hard: true, edge: 0.4 });
    pushS(sit.lines, mkStroke(pts, { w: 0.6, center: centroid(pts), shade: 0.6, taper: 0.02 }));
    if (sy !== 0.15) sit.occ = (sit.occ || []).concat([pts]);
  }
  E.items.push(sit);
}

// ---------------------------------------------------------------- fruit

function gearPoly(c, rr, teeth, rot = 0) {
  const pts = [];
  for (let i = 0; i < teeth; i++) {
    const a = rot + (i / teeth) * TAU, s = TAU / teeth;
    pts.push(add(c, dirOf(a, rr * 0.86)), add(c, dirOf(a + s * 0.12, rr * 1.06)), add(c, dirOf(a + s * 0.45, rr * 1.06)), add(c, dirOf(a + s * 0.57, rr * 0.86)));
  }
  return pts;
}

function crystalPoly(c, rx, ry, rot, r) {
  const n = r.int(6, 8), pts = [];
  for (let i = 0; i < n; i++) { const a = (i / n) * TAU + r.float(-0.2, 0.2); pts.push(add(c, rot2(P(Math.cos(a) * rx * r.float(0.85, 1.05), Math.sin(a) * ry * r.float(0.85, 1.05)), rot))); }
  return pts;
}

// Shade a closed rounded body: stipple on the side away from the light, a body-colour highlight.
function roundBody(E, it, poly, c, rr, col, o = {}) {
  const r = E.r;
  if (col.l < 32) col = C(col.h, col.s, 32 + (col.l - 18) * 0.5);
  it.washes.push({ poly, color: lighten(col, 0.18), alpha: o.alpha || 0.78, shade: { from: add(c, mul(LIGHT, rr)), to: add(c, mul(SHADOW, rr)), color: darken(col, 0.2) }, edge: 0.8 });
  const dots = [];
  const bb = bboxOf(poly);
  const N = clamp(Math.round(rr * rr * (o.dense || 0.9)), 10, 900);
  for (let i = 0; i < N * 2.4 && dots.length < N; i++) {
    const q = P(r.float(bb.x0, bb.x1), r.float(bb.y0, bb.y1));
    if (!inPoly(q, poly)) continue;
    const s = dot(sub(q, c), SHADOW) / rr;
    if (r.next() < smoothstep(-0.25, 0.9, s) * 0.9) dots.push({ x: q.x, y: q.y, r: r.float(0.28, 0.5) });
  }
  it.dots.push({ pts: dots });
  if (!o.matte) {
    const hc = add(c, mul(LIGHT, rr * 0.45));
    it.fills.push({ poly: ellipsePts(hc, rr * 0.2, rr * 0.13, angOf(LIGHT) + 1.2, 12), color: 'rgba(255,252,242,0.82)' });
    if (rr > 14) it.fills.push({ poly: ellipsePts(add(c, mul(SHADOW, rr * 0.62)), rr * 0.16, rr * 0.07, angOf(SHADOW) + 1.57, 10), color: 'rgba(255,250,236,0.35)' });
  }
}

function engraveFruit(E, fr, o = {}) {
  const r = E.r, pal = E.pal;
  const form = o.form || E.g.fruit.form;
  const marvel = E.marvel;
  const z = (fr.z || 38) + (o.zAdd || 0);
  const phase = o.phase || 4.5, key = o.key != null ? o.key : -fr.at.y * 0.001;
  const R = fr.R;
  const rr = clamp(R * (o.scale || 0.34), 3, 120);
  let d = dirOf(fr.ang);
  if (fr.hang && !o.noHang) d = nrm(lerpP(d, P(0, 1), 0.65));
  const n = perp(d);
  const it = mkItem(z, phase, key, { origin: fr.at });
  const col = pal.fruit;
  const stalkTo = (p) => pushS(it.lines, mkStroke([fr.at, lerpP(fr.at, p, 0.5), p], { w: 0.75, taper: 0, taperEnd: 0.1 }));
  const crystal = marvel === 'crystal', clock = marvel === 'clockwork';
  const items = [it];
  const body = (c, rx, ry, rot) => {
    if (crystal) return crystalPoly(c, rx, ry, rot, r);
    if (clock) return gearPoly(c, (rx + ry) / 2, r.int(10, 16), r.float(0, 1));
    return ellipsePts(c, rx, ry, rot, 32).slice(0, -1);
  };
  const facet = (poly, c) => {
    const ctr = add(c, mul(LIGHT, rr * 0.25));
    for (let i = 0; i < poly.length; i++) {
      pushS(it.hatch, mkHatch(ctr, poly[i], 0.4));
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const tri = [ctr, a, b];
      const lit = dot(nrm(sub(lerpP(a, b, 0.5), c)), LIGHT);
      if (lit < 0.2) for (const [p, q] of hatchPoly(tri, angOf(sub(b, a)) + 0.5, lit < -0.4 ? 1.8 : 2.6, r.next())) pushS(it.hatch, mkHatch(p, q, 0.3));
    }
    it.fills.push({ poly: [ctr, poly[0], lerpP(poly[0], poly[1], 0.5)].map((p) => lerpP(p, ctr, 0.3)), color: 'rgba(255,253,245,0.65)' });
  };
  const gearDetail = (c, rad0) => {
    pushS(it.lines, mkStroke(ellipsePts(c, rad0 * 0.2, rad0 * 0.2, 0, 14), { w: 0.5, taper: 0 }));
    pushS(it.lines, mkStroke(ellipsePts(c, rad0 * 0.62, rad0 * 0.62, 0, 30), { w: 0.4, taper: 0 }));
    for (let k = 0; k < 5; k++) { const a = (k / 5) * TAU; pushS(it.hatch, mkHatch(add(c, dirOf(a, rad0 * 0.22)), add(c, dirOf(a, rad0 * 0.6)), 0.5)); }
  };
  switch (form) {
    case 'berry': case 'drupe': {
      const k = form === 'drupe' ? 1.15 : 1;
      const c = add(fr.at, mul(d, rr * k + 1.5));
      const poly = body(c, rr * (form === 'drupe' ? 0.9 : 1), rr * k, angOf(d) + Math.PI / 2);
      stalkTo(add(fr.at, mul(d, 2)));
      it.occ = [poly];
      pushS(it.lines, mkStroke(poly.concat([poly[0]]), { w: 0.85, center: c, shade: 0.9, taper: 0, rng: r, jit: 0.15, step: 1.5 }));
      if (crystal) { it.washes.push({ poly, color: lighten(col, 0.3), alpha: 0.6, edge: 0.6 }); facet(poly, c); }
      else {
        roundBody(E, it, poly, c, rr, col, { matte: form === 'drupe', dense: form === 'drupe' ? 0.7 : 0.9 });
        if (clock) gearDetail(c, rr);
        if (form === 'drupe' && !clock) {
          const sut = [];
          for (let i = 0; i <= 10; i++) { const t = i / 10; sut.push(add(add(c, mul(d, lerp(-rr * k, rr * k, t))), mul(n, Math.sin(Math.PI * t) * rr * 0.3))); }
          pushS(it.hatch, mkStroke(sut, { w: 0.45, taper: 0.2 }));
        }
        if (form === 'berry' && !clock) {
          const tip = add(c, mul(d, rr * 0.95));
          for (let i = 0; i < 5; i++) pushS(it.hatch, mkHatch(tip, add(tip, dirOf((i / 5) * TAU, rr * 0.18)), 0.4));
        }
      }
      break;
    }
    case 'capsule': {
      const Lc = rr * 2.3, wc = rr * 0.75;
      const c = add(fr.at, mul(d, Lc * 0.5 + 1));
      const poly = crystal ? crystalPoly(c, Lc / 2, wc, angOf(d), r) : (() => {
        const pts = [];
        for (let i = 0; i <= 30; i++) { const a = (i / 30) * TAU; const t = (Math.cos(a) + 1) / 2; pts.push(add(add(fr.at, mul(d, (1 - t) * Lc + 1)), mul(n, Math.sin(a) * wc * Math.pow(Math.sin(Math.PI * clamp(1 - t, 0.02, 0.98)), 0.6)))); }
        return pts;
      })();
      stalkTo(add(fr.at, mul(d, 1.5)));
      it.occ = [poly];
      pushS(it.lines, mkStroke(poly, { w: 0.85, center: c, shade: 0.9, taper: 0, rng: r, jit: 0.12 }));
      if (crystal) { it.washes.push({ poly, color: lighten(col, 0.3), alpha: 0.6 }); facet(poly, c); break; }
      it.washes.push({ poly, color: lighten(col, 0.1), alpha: 0.72, shade: { from: add(c, mul(LIGHT, wc)), to: add(c, mul(SHADOW, wc)), color: darken(col, 0.2) } });
      for (const v of [-0.55, 0, 0.55]) {
        const pts = [];
        for (let i = 0; i <= 12; i++) { const t = i / 12; pts.push(add(add(fr.at, mul(d, t * Lc + 1)), mul(n, v * wc * Math.pow(Math.sin(Math.PI * clamp(t, 0.02, 0.98)), 0.6)))); }
        pushS(it.hatch, mkStroke(pts, { w: 0.42, taper: 0.1 }));
      }
      const sd = dot(n, SHADOW) > 0 ? 1 : -1;
      for (let t = 0.1; t < 0.92; t += 2.5 / Lc) {
        const w0 = wc * Math.pow(Math.sin(Math.PI * t), 0.6);
        const a = add(add(fr.at, mul(d, t * Lc + 1)), mul(n, sd * w0 * 0.95));
        pushS(it.hatch, mkHatch(a, add(add(fr.at, mul(d, (t + 0.03) * Lc + 1)), mul(n, sd * w0 * 0.3)), 0.33));
      }
      const tip = add(fr.at, mul(d, Lc + 1));
      pushS(it.lines, mkStroke([tip, add(tip, mul(d, rr * 0.4))], { w: 0.5, taper: 0 }));
      break;
    }
    case 'pod': {
      const Lp = rr * r.float(4, 5.5), wp = rr * 0.55;
      const seeds = r.int(3, 6);
      const bend = r.float(0.15, 0.35) * (r.chance(0.5) ? 1 : -1);
      const spine = [];
      for (let i = 0; i <= 30; i++) { const t = i / 30; spine.push(add(add(fr.at, mul(d, t * Lp)), mul(n, Math.sin(Math.PI * t) * Lp * bend * 0.3))); }
      const rb = ribbon(spine, (t) => wp * 2 * Math.pow(Math.sin(Math.PI * clamp(t, 0.02, 0.98)), 0.35) * (0.86 + 0.24 * Math.pow(Math.abs(Math.cos(Math.PI * seeds * (t * 0.92 + 0.04))), 0.7)));
      it.occ = [rb.poly];
      pushS(it.lines, mkStroke(rb.left, { w: 0.85, side: -1, shade: 0.8, taper: 0.03 }));
      pushS(it.lines, mkStroke(rb.right, { w: 0.85, side: 1, shade: 0.8, taper: 0.03 }));
      const cc = centroid(rb.poly);
      it.washes.push({ poly: rb.poly, color: lighten(col, 0.15), alpha: 0.72, shade: { from: add(cc, mul(LIGHT, Lp * 0.3)), to: add(cc, mul(SHADOW, Lp * 0.3)), color: darken(col, 0.2) } });
      const sut = rb.left.map((p, i) => lerpP(p, spine[i], 0.25));
      pushS(it.hatch, mkStroke(sut, { w: 0.4, taper: 0.1 }));
      for (let k = 0; k < seeds; k++) {
        const t = (k + 0.5) / seeds;
        const { p, tan } = along(spine, t);
        const sp = ellipsePts(p, Lp / seeds * 0.32, wp * 0.55, angOf(tan), 14);
        pushS(it.hatch, mkStroke(sp.slice(3, 12), { w: 0.4, taper: 0.2 }));
      }
      const sdr = dot(perp(d), SHADOW) > 0 ? rb.right : rb.left;
      for (let i = 2; i < sdr.length - 2; i += 1) pushS(it.hatch, mkHatch(sdr[i], lerpP(sdr[i], spine[i], 0.55), 0.36));
      const tipP = spine[spine.length - 1], tdir = nrm(sub(tipP, spine[spine.length - 3]));
      pushS(it.lines, mkStroke(spline([tipP, add(tipP, mul(tdir, wp * 0.8)), add(add(tipP, mul(tdir, wp * 1.4)), mul(perp(tdir), wp * 0.3))], 4), { w: 0.6, taper: 0, taperEnd: 0.6 }));
      for (const sd of [-1, 1]) pushS(it.lines, mkStroke([spine[1], add(spine[1], add(mul(d, wp * 0.9), mul(perp(d), sd * wp * 0.7)))], { w: 0.55, taper: 0, taperEnd: 0.5 }));
      stalkTo(spine[1]);
      break;
    }
    case 'samara': {
      for (const sd of (r.chance(0.6) ? [-1, 1] : [1])) {
        const a = angOf(d) + sd * rad(r.float(25, 45));
        const dd = dirOf(a), nn = perp(dd);
        const nut = add(fr.at, mul(dd, rr * 0.7));
        const np = ellipsePts(nut, rr * 0.55, rr * 0.4, a, 16);
        const wing = [];
        const WL = rr * 3.2, WW = rr * 0.95;
        for (let i = 0; i <= 20; i++) { const t = i / 20; wing.push(add(add(nut, mul(dd, t * WL)), mul(nn, -sd * WW * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.7)), 0.7)))); }
        for (let i = 20; i >= 0; i--) { const t = i / 20; wing.push(add(add(nut, mul(dd, t * WL)), mul(nn, sd * rr * 0.25 * Math.sin(Math.PI * t)))); }
        const wi = mkItem(z, phase, key, { origin: nut });
        wi.occ = [wing];
        wi.washes.push({ poly: wing, color: lighten(col, 0.35), alpha: 0.5, edge: 0.9 });
        pushS(wi.lines, mkStroke(wing, { w: 0.7, center: centroid(wing), shade: 0.7, taper: 0.02 }));
        for (let k = 1; k < 9; k++) {
          const pts = [];
          for (let i = 0; i <= 8; i++) { const t = i / 8 * 0.95; pts.push(add(add(nut, mul(dd, t * WL)), mul(nn, -sd * WW * (k / 9 - 0.12) * Math.pow(Math.sin(Math.PI * Math.pow(Math.max(0.02, t), 0.7)), 0.7)))); }
          pushS(wi.hatch, mkStroke(pts, { w: 0.3, taper: 0.1, taperEnd: 0.5 }));
        }
        const ni = mkItem(z + 0.01, phase, key + 0.0001, { origin: nut });
        ni.occ = [np];
        if (clock) { const gp = gearPoly(nut, rr * 0.55, 10); ni.occ = [gp]; pushS(ni.lines, mkStroke(gp.concat([gp[0]]), { w: 0.7, taper: 0 })); ni.washes.push({ poly: gp, color: col, alpha: 0.75 }); }
        else { pushS(ni.lines, mkStroke(np, { w: 0.8, center: nut, shade: 0.8, taper: 0 })); roundBody(E, ni, np, nut, rr * 0.5, darken(col, 0.1), { matte: true }); }
        items.push(wi, ni);
      }
      stalkTo(add(fr.at, mul(d, 2)));
      break;
    }
    case 'bladder': {
      const Lb = rr * 2.5, wb = rr * 1.0;
      const c = add(fr.at, mul(d, Lb * 0.5));
      const poly = [];
      for (let i = 0; i <= 36; i++) { const a = (i / 36) * TAU; const t = (1 - Math.cos(a)) / 2; poly.push(add(add(fr.at, mul(d, t * Lb)), mul(n, Math.sin(a) * wb * Math.pow(Math.sin(Math.PI * clamp(t, 0.03, 0.97)), 0.5)))); }
      it.occ = [poly];
      it.washes.push({ poly, color: lighten(col, 0.45), alpha: 0.42, edge: 1.2 });
      pushS(it.lines, mkStroke(poly, { w: 0.75, center: c, shade: 0.8, taper: 0 }));
      for (const v of [-0.8, -0.45, 0, 0.45, 0.8]) {
        const pts = [];
        for (let i = 0; i <= 14; i++) { const t = i / 14; pts.push(add(add(fr.at, mul(d, t * Lb)), mul(n, v * wb * Math.pow(Math.sin(Math.PI * clamp(t, 0.03, 0.97)), 0.5)))); }
        pushS(it.hatch, mkStroke(pts, { w: 0.4, taper: 0.1 }));
      }
      // the net of veins between the ribs
      for (let k = 0; k < 26; k++) {
        const t = r.float(0.12, 0.88), v = r.float(-0.8, 0.6);
        const w0 = wb * Math.pow(Math.sin(Math.PI * t), 0.5);
        const a = add(add(fr.at, mul(d, t * Lb)), mul(n, v * w0)), b = add(add(fr.at, mul(d, (t + r.float(-0.06, 0.06)) * Lb)), mul(n, (v + 0.35) * w0));
        pushS(it.hatch, mkHatch(a, b, 0.28, null, add(lerpP(a, b, 0.5), mul(d, r.float(-2, 2)))));
      }
      stalkTo(add(fr.at, mul(d, 1)));
      break;
    }
    case 'beads': {
      const k = r.int(3, 6);
      let p = fr.at, a = angOf(d);
      stalkTo(add(fr.at, mul(d, 1)));
      for (let i = 0; i < k; i++) {
        const br = rr * lerp(0.75, 0.5, i / k);
        a += r.float(-0.25, 0.25);
        const c = add(p, dirOf(a, br + (i ? 0.5 : 1.5)));
        const bi = mkItem(z + i * 0.01, phase, key + i * 0.0001, { origin: c });
        const poly = body(c, br, br * 0.95, a);
        bi.occ = [poly];
        pushS(bi.lines, mkStroke(poly.concat([poly[0]]), { w: 0.75, center: c, shade: 0.9, taper: 0, step: 1.5 }));
        if (crystal) { bi.washes.push({ poly, color: lighten(col, 0.3), alpha: 0.6 }); }
        else roundBody(E, bi, poly, c, br, col, { dense: 0.8 });
        items.push(bi);
        p = add(c, dirOf(a, br));
      }
      break;
    }
    default: break;
  }
  for (const x of items) if (x.lines.length || x.washes.length) E.items.push(x);
}

// ================================================================== engraving: roots

function rootLine(E, it, p0, ang, len, w, o = {}) {
  const r = E.r;
  const pts = growPath(r, p0, ang, len, { lean: o.lean != null ? o.lean : r.float(-0.5, 0.5), sin: o.sin != null ? o.sin : 0.18, freq: r.float(1, 2.5), step: 3, toward: o.toward, towardK: o.towardK });
  pushS(it.lines, mkStroke(pts, { w, taper: 0.02, taperEnd: 0.85, minW: 0.18, rng: r, jit: 0.25, color: o.color }));
  if (o.branches && len > 25) {
    const cl = cumLen(pts);
    for (let k = 0; k < o.branches; k++) {
      const q = along(pts, r.float(0.25, 0.75), cl);
      const side = r.chance(0.5) ? 1 : -1;
      rootLine(E, it, q.p, angOf(q.tan) + side * r.float(0.4, 1.1), len * r.float(0.2, 0.45), w * 0.55, { branches: o.depth > 1 ? 1 : 0, depth: (o.depth || 1) - 1, color: o.color });
    }
  }
  return pts;
}

// A thick, shaded root body (taproot, rhizome, legs) drawn like a stem in root colours.
function rootBody(E, pts, w0, w1, z, phase, key, col, o = {}) {
  const r = E.r;
  const st = { pts, w0, w1, z, kind: 'root', key, armature: 'none', color: col, wfn: o.wfn };
  const it = engraveStem(E, st, phase);
  if (!it) return null;
  it.key = key;
  // transverse wrinkles
  const P2 = resample(pts, 2.4), cl = cumLen(P2), L = cl[cl.length - 1];
  const wAt = o.wfn || ((t) => lerp(w0, w1, Math.pow(t, 0.85)));
  if (!o.smooth) for (let s = r.float(4, 9); s < L - 6; s += r.float(5, 11)) {
    const { p, tan } = along(P2, s / L, cl);
    const n = perp(tan), hw = wAt(s / L) / 2;
    if (hw < 1.8) continue;
    const a = add(p, mul(n, -hw * r.float(0.2, 0.9))), b = add(p, mul(n, hw * r.float(0.5, 0.95)));
    pushS(it.hatch, mkHatch(a, b, 0.38, null, add(lerpP(a, b, 0.5), mul(tan, hw * 0.25))));
  }
  return it;
}

function engraveRoots(E, S, L) {
  const RT = S.roots;
  if (!RT) return;
  const r = E.r, pal = E.pal, s = L.s;
  const B = L.T(RT.at);
  const col = pal.root;
  const it = mkItem(9, 1, 0, { origin: B });
  const marvel = E.marvel;
  if (marvel === 'crystal') { engraveCrystals(E, B, s, 1); return; }
  if (L.inverted) {
    // a few roots creeping into the rock above
    for (let i = 0; i < 9; i++) rootLine(E, it, B, UP + r.float(-1.3, 1.3), r.float(20, 60) * s, 0.9, { branches: 1, toward: UP, towardK: 0.4 });
    E.items.push(it);
    return;
  }
  if (marvel === 'migratory') { engraveLegs(E, B, s, RT, L); return; }
  const fib = (p, n, len, spread = 1.25, w = 1.0) => {
    for (let i = 0; i < n; i++) {
      const u = n === 1 ? 0.5 : i / (n - 1);
      const a = DOWN + (u - 0.5) * 2 * spread + r.float(-0.12, 0.12);
      rootLine(E, it, p, a, len * r.float(0.5, 1) * (1 - Math.abs(u - 0.5) * 0.6), w * r.float(0.7, 1.1), { branches: r.int(0, 3), depth: 2, toward: DOWN, towardK: 0.35 });
    }
  };
  switch (RT.form) {
    case 'taproot': {
      const len = r.float(170, 260) * s;
      const pts = growPath(r, B, DOWN + r.float(-0.2, 0.2), len, { lean: r.float(-0.5, 0.5), sin: 0.12, step: 4 });
      const w0 = clamp(RT.w * s * 2.2, 6, 30);
      rootBody(E, pts, w0, 1.2, 9.5, 1, 0.1, col);
      const cl = cumLen(pts);
      const nl = r.int(9, 16);
      for (let i = 0; i < nl; i++) {
        const q = along(pts, r.float(0.15, 0.9), cl);
        const side = r.chance(0.5) ? 1 : -1;
        const hw = lerp(w0, 1.2, Math.pow(q.i / pts.length, 0.85)) / 2;
        const p0 = add(q.p, mul(perp(q.tan), side * hw * 0.8));
        rootLine(E, it, p0, angOf(q.tan) + side * r.float(0.5, 1.3), r.float(25, 80) * s, 0.75, { branches: r.int(0, 2), depth: 1, toward: DOWN, towardK: 0.3 });
      }
      break;
    }
    case 'fibrous': fib(B, r.int(16, 26), r.float(110, 200) * s, 1.3, 1.1); break;
    case 'tuber': {
      const side = r.chance(0.5) ? 1 : -1;
      const tc = add(B, P(side * r.float(15, 45) * s, r.float(60, 85) * s));
      const rx = r.float(42, 62) * s, ry = r.float(30, 44) * s;
      const wob = wobble(r, 3);
      const poly = [];
      for (let i = 0; i < 40; i++) { const a = (i / 40) * TAU; const k = 1 + wob(i * 0.4) * 0.07; poly.push(add(tc, rot2(P(Math.cos(a) * rx * k, Math.sin(a) * ry * k), r.float(-0.02, 0.02) + side * 0.3))); }
      const stolon = spline([B, add(B, P(side * 4 * s, 20 * s)), add(tc, P(-side * rx * 0.5, -ry * 0.6))], 6);
      rootBody(E, stolon, clamp(9 * s, 3, 10), clamp(6 * s, 2, 7), 9.4, 1, 0.05, col, { smooth: true });
      const ti = mkItem(9.6, 1, 0.2, { origin: tc });
      ti.occ = [poly];
      pushS(ti.lines, mkStroke(poly.concat([poly[0]]), { w: 1.0, center: tc, shade: 0.9, taper: 0, rng: r, jit: 0.2 }));
      roundBody(E, ti, poly, tc, (rx + ry) / 2, darken(col, 0.1), { matte: true, dense: 0.6 });
      for (let k = 0; k < r.int(4, 7); k++) {
        const a = r.float(0, TAU), q = add(tc, P(Math.cos(a) * rx * r.float(0.2, 0.75), Math.sin(a) * ry * r.float(0.2, 0.75)));
        pushS(ti.hatch, mkStroke(ellipsePts(q, 3.5 * s + 1.5, 1.6 * s + 0.6, a, 10).slice(0, 7), { w: 0.5, taper: 0.2 }));
        ti.dots.push({ pts: [{ x: q.x, y: q.y + 0.5, r: 0.6 }] });
      }
      E.items.push(ti);
      fib(add(tc, P(0, ry * 0.8)), r.int(5, 9), 70 * s, 1.0, 0.7);
      fib(B, r.int(4, 7), 60 * s, 1.2, 0.7);
      break;
    }
    case 'rhizome': {
      const dir = r.chance(0.5) ? 1 : -1;
      const x0 = -r.float(120, 160) * s, x1 = r.float(130, 180) * s;
      const ctrl = [];
      const nC = 7;
      for (let k = 0; k <= nC; k++) { const u = k / nC; ctrl.push(add(B, P(lerp(x0, x1, u) * dir, (10 + Math.sin(u * 5.3 + r.float(0, 1)) * 9 + u * 6) * s + r.float(-3, 3) * s))); }
      const pts = spline(ctrl, 10);
      const w = clamp(RT.w * s * 2.6, 12, 30);
      const cl0 = cumLen(pts), Ltot = cl0[cl0.length - 1];
      const seg = r.float(26, 36) * Math.max(0.7, s);
      const nodesAt = [];
      for (let q = seg * r.float(0.5, 0.9); q < Ltot - 10; q += seg * r.float(0.85, 1.15)) nodesAt.push(q / Ltot);
      const wfn = (t) => {
        let dmin = 1;
        for (const nt of nodesAt) dmin = Math.min(dmin, Math.abs(t - nt) * Ltot / seg);
        const swell = 0.8 + 0.28 * Math.sin(Math.PI * clamp(dmin * 2, 0, 1));
        const ends = Math.min(1, t * Ltot / (w * 0.6) + 0.55) * Math.min(1, (1 - t) * Ltot / (w * 1.4) + 0.3);
        return w * swell * ends;
      };
      const rcol = mixColor(col, C(25, 35, 38), 0.4);
      rootBody(E, pts, w, w, 9.5, 1, 0.1, rcol, { smooth: true, wfn });
      const ni = mkItem(9.55, 1, 0.15, { origin: pts[0] });
      for (const nt of nodesAt) {
        const { p, tan } = along(pts, nt, cl0);
        const n = perp(tan), hw = wfn(nt) / 2;
        const ring = [];
        for (let k = 0; k <= 8; k++) { const u = k / 8; ring.push(add(add(p, mul(n, lerp(-hw, hw, u) * 0.98)), mul(tan, Math.sin(Math.PI * u) * hw * 0.3))); }
        pushS(ni.lines, mkStroke(ring, { w: 0.75, taper: 0.1 }));
        // a papery scale leaf at the node, and an old leaf scar on the upper side
        const up = dot(n, P(0, -1)) > 0 ? 1 : -1;
        const sc = add(p, mul(n, up * hw * 0.85));
        const scale = spline([add(sc, mul(tan, -w * 0.15)), add(add(sc, mul(tan, w * 0.35)), mul(n, up * w * 0.28)), add(sc, mul(tan, w * 0.55))], 4);
        pushS(ni.lines, mkStroke(scale, { w: 0.55, taper: 0.1 }));
        if (r.chance(0.5)) pushS(ni.hatch, mkStroke(ellipsePts(add(p, add(mul(n, up * hw * 0.35), mul(tan, seg * 0.35))), hw * 0.28, hw * 0.16, angOf(tan), 12), { w: 0.45, taper: 0 }));
        for (let k = 0; k < r.int(2, 4); k++) {
          const q = add(p, add(mul(n, -up * hw * 0.85), mul(tan, r.float(-4, 4))));
          rootLine(E, it, q, DOWN + r.float(-0.7, 0.7), r.float(40, 110) * Math.max(0.6, s), 0.85, { branches: r.int(0, 2), depth: 1, toward: DOWN, towardK: 0.3 });
        }
      }
      // the growing tip: a pointed bud wrapped in scales
      const tipP = pts[pts.length - 1], tdir = nrm(sub(tipP, pts[pts.length - 4]));
      const bud = [add(tipP, mul(perp(tdir), w * 0.32)), add(tipP, mul(tdir, w * 0.75)), add(tipP, mul(perp(tdir), -w * 0.32))];
      pushS(ni.lines, mkStroke(spline(bud, 5), { w: 0.8, taper: 0.05 }));
      ni.washes.push({ poly: spline(bud, 5).concat([tipP]), color: lighten(rcol, 0.2), alpha: 0.6, hard: true });
      E.items.push(ni);
      engraveCut(E, pts, wfn(0.02), rcol, 9.6);
      break;
    }
    case 'bulb': case 'corm': {
      const bulb = RT.form === 'bulb';
      const Hb = (bulb ? r.float(85, 115) : r.float(48, 62)) * s, Wb = (bulb ? r.float(62, 86) : r.float(78, 98)) * s;
      const top = add(B, P(0, -Hb * (bulb ? 0.12 : 0.18)));
      const hwAt = bulb ? (t) => Wb / 2 * (0.13 + 0.87 * Math.pow(Math.sin(Math.PI * Math.pow(t, 1.25) * 0.86 + 0.08), 1.3)) * (1 - 0.25 * smoothstep(0.85, 1, t))
        : (t) => Wb / 2 * Math.pow(Math.sin(Math.PI * clamp(t * 0.92 + 0.04, 0, 1)), 0.55);
      const right = [], left = [];
      for (let i = 0; i <= 30; i++) { const t = i / 30; const y = top.y + t * Hb; right.push(P(top.x + hwAt(t), y)); left.push(P(top.x - hwAt(t) * 0.97, y)); }
      const poly = right.concat(left.slice().reverse());
      const bi = mkItem(9.8, 1, 0.1, { origin: top });
      bi.occ = [poly];
      const cc = centroid(poly);
      const bcol = mixColor(col, bulb ? C(15, 30, 70) : C(30, 35, 55), 0.35);
      bi.washes.push({ poly, color: lighten(bcol, 0.15), alpha: 0.72, shade: { from: add(cc, mul(LIGHT, Wb * 0.5)), to: add(cc, mul(SHADOW, Wb * 0.5)), color: darken(bcol, 0.22) } });
      pushS(bi.lines, mkStroke(right, { w: 1.0, center: cc, shade: 0.9, taper: 0.03 }));
      pushS(bi.lines, mkStroke(left, { w: 1.0, center: cc, shade: 0.9, taper: 0.03 }));
      pushS(bi.lines, mkStroke([right[right.length - 1], left[left.length - 1]], { w: 0.8, taper: 0 }));
      if (bulb) {
        // tunic lines from the basal plate to the neck
        for (const v of [-0.82, -0.6, -0.36, -0.12, 0.12, 0.36, 0.6, 0.82]) {
          const pts = [];
          for (let i = 1; i <= 28; i++) { const t = i / 30; pts.push(P(top.x + v * hwAt(t), top.y + t * Hb)); }
          pushS(bi.hatch, mkStroke(pts, { w: 0.42, taper: 0.15, rng: r, jit: 0.2 }));
        }
        // papery, torn outer tunic at the neck
        for (let k = 0; k < 4; k++) {
          const sd = k % 2 ? 1 : -1;
          const a = P(top.x + sd * hwAt(0.18) * 0.9, top.y + 0.18 * Hb);
          pushS(bi.lines, mkStroke([a, add(a, P(sd * r.float(2, 6) * s, -r.float(8, 18) * s)), add(a, P(sd * r.float(-2, 3) * s, -r.float(18, 30) * s))], { w: 0.5, taper: 0.1 }));
        }
      } else {
        // ring scars and the netted fibrous coat of a corm
        for (const t of [0.32, 0.55, 0.76]) {
          const pts = [];
          for (let i = 0; i <= 16; i++) { const u = i / 16; pts.push(P(top.x + lerp(-1, 1, u) * hwAt(t) * 0.98, top.y + t * Hb + Math.sin(Math.PI * u) * Hb * 0.06)); }
          pushS(bi.lines, mkStroke(pts, { w: 0.6, taper: 0.1 }));
        }
        for (const [a, b] of hatchPoly(poly, 1.05, 4.2, 0.2).concat(hatchPoly(poly, -1.05, 4.2, 0.6))) pushS(bi.hatch, mkHatch(a, b, 0.3));
      }
      const sd = 1;
      for (let t = 0.12; t < 0.95; t += 2.6 / Hb) {
        const hw = hwAt(t);
        pushS(bi.hatch, mkHatch(P(top.x + sd * hw * 0.97, top.y + t * Hb), P(top.x + sd * hw * 0.45, top.y + (t + 0.02) * Hb), 0.35));
      }
      E.items.push(bi);
      const plate = P(top.x, top.y + Hb);
      fib(plate, r.int(12, 20), r.float(60, 120) * s, 1.15, 0.85);
      break;
    }
    case 'aerial': engraveAerial(E, B, s, L); break;
    default: fib(B, 14, 120 * s);
  }
  if (it.lines.length) E.items.push(it);
}

function engraveAerial(E, B, s, L) {
  const r = E.r;
  const bark = L.bark;
  const n = r.int(5, 8);
  for (let i = 0; i < n; i++) {
    const side = i % 2 ? 1 : -1;
    const front = r.chance(0.65);
    const it = mkItem(front ? 13 : 2, 1, 0.1 + i * 0.01, { origin: B });
    const ctrl = [B];
    let p = add(B, P(side * r.float(10, 50) * s, r.float(2, 6)));
    ctrl.push(p);
    if (bark) {
      // over the front of the branch and down
      const yb = bark.y(p.x) + bark.r * r.float(0.4, 1.1);
      p = P(p.x + side * r.float(5, 25), yb); ctrl.push(p);
    }
    const dl = r.float(60, 200) * s;
    for (let k = 1; k <= 3; k++) { p = add(p, P(side * r.float(-8, 22) * s, (dl / 3) * r.float(0.8, 1.2))); ctrl.push(p); }
    const pts = spline(ctrl, 8);
    const w = clamp(r.float(3, 5) * s, 2, 6);
    const st = { pts, w0: w, w1: w * 0.75, z: it.z, kind: 'root', key: 0.1 + i * 0.01, armature: 'none', color: C(40, 10, 82) };
    const ri = engraveStem(E, st, 1);
    if (ri) {
      // the living green tip of the root
      const tp = resample(pts, 2);
      const ttail = tp.slice(Math.max(0, tp.length - 10));
      if (ttail.length > 2) ri.washes.push({ poly: ribbon(ttail, () => w).poly, color: E.pal.leaf, alpha: 0.5, hard: true, edge: 0.2 });
    }
  }
}

function engraveLegs(E, B, s, RT, L) {
  const r = E.r, pal = E.pal;
  const legH = 95 * s;
  const groundY = B.y + legH;
  const n = r.int(3, 5);
  const walk = r.chance(0.5) ? 1 : -1;
  for (let i = 0; i < n; i++) {
    const u = n === 1 ? 0.5 : i / (n - 1);
    const spread = lerp(-1, 1, u) * r.float(55, 80) * s + walk * 10 * s;
    const knee = add(B, P(spread * 0.75 + walk * r.float(-6, 6) * s, legH * r.float(0.35, 0.5)));
    const foot = P(B.x + spread * 1.1 + walk * (i % 2 ? 8 : -6) * s, groundY);
    const pts = spline([B, lerpP(B, knee, 0.5), knee, lerpP(knee, foot, 0.6), foot], 8);
    rootBody(E, pts, clamp(RT.w * s * 1.3, 4, 14), clamp(2.4 * s, 1.5, 4), 9.5 - Math.abs(u - 0.5), 1, 0.1 + i * 0.01, pal.root);
    // toes splayed on the ground
    const it = mkItem(9.7, 1, 0.2 + i * 0.01, { origin: foot });
    for (let k = 0; k < 3; k++) {
      const a = (k - 1) * 0.6 + (spread > 0 ? 0.25 : -0.25);
      const d = P(Math.sin(a) * 1, 0.25);
      pushS(it.lines, mkStroke(spline([foot, add(foot, mul(d, 6 * s)), add(foot, P(d.x * 13 * s, 2))], 4), { w: 0.8, taper: 0.05, taperEnd: 0.8 }));
    }
    E.items.push(it);
  }
  // footprints trailing behind, and the ground it walks on
  const gi = mkItem(3.5, 0.5, 0, { origin: P(B.x, groundY) });
  const back = -walk;
  const fs = Math.max(0.8, s);
  for (let k = 1; k <= 7; k++) {
    const fx = B.x + back * (70 + k * 30 * fs) * r.float(0.95, 1.05);
    if (fx < AREA.x0 + 10 || fx > AREA.x1 - 10) break;
    const fy = groundY + 3 + (k % 2 ? 0 : 5) * fs;
    const fade = clamp(0.95 - k * 0.1, 0.3, 0.9);
    const colr = `rgba(42,33,24,${fade.toFixed(2)})`;
    const p0 = P(fx, fy);
    // a little splayed print of three root-toes and a heel
    for (let t = 0; t < 3; t++) {
      const a = (t - 1) * 0.5 + (walk > 0 ? 0 : Math.PI);
      const q0 = add(p0, P(Math.cos(a) * 2 * fs, Math.sin(a) * 0.7 * fs));
      const q1 = add(p0, P(Math.cos(a) * 8 * fs, Math.sin(a) * 2.6 * fs));
      pushS(gi.hatch, mkHatch(q0, q1, 0.75, colr, add(lerpP(q0, q1, 0.5), P(0, -0.6))));
    }
    gi.dots.push({ pts: [{ x: fx - walk * 3 * fs, y: fy + 0.4, r: 1.3 * fs }], color: colr });
    // the faint scuffed path between prints
    if (k > 1) gi.dots.push({ pts: [0.3, 0.55, 0.8].map((u) => ({ x: fx + walk * 30 * fs * u, y: fy - 2 + r.float(-1, 1), r: 0.45 })), color: colr });
  }
  E.items.push(gi);
  engraveGround(E, P(B.x, groundY), 150 * Math.max(0.7, s) + 60, 'plain');
}

function engraveCrystals(E, B, s, dir) {
  const r = E.r, pal = E.pal;
  const n = r.int(5, 9);
  const col = mixColor(lighten(pal.root, 0.3), C(208, 38, 70), 0.78);
  for (let i = 0; i < n; i++) {
    const a = DOWN * dir + r.float(-0.9, 0.9);
    const len = r.float(50, 140) * s * (1 - Math.abs(a - DOWN * dir) * 0.3);
    const w = r.float(9, 18) * s;
    const d = dirOf(a), nn = perp(d);
    const b0 = add(B, mul(d, r.float(0, 10) * s));
    const tip = add(b0, mul(d, len));
    const shoulder = add(b0, mul(d, len - w * 0.9));
    const pL = add(b0, mul(nn, -w / 2)), pR = add(b0, mul(nn, w / 2));
    const sL = add(shoulder, mul(nn, -w / 2)), sR = add(shoulder, mul(nn, w / 2));
    const poly = [pL, sL, tip, sR, pR];
    const it = mkItem(9 + r.float(0, 1), 1, 0.1 + i * 0.01, { origin: b0 });
    it.occ = [poly];
    it.washes.push({ poly, color: col, alpha: 0.62, hard: true, edge: 1, shade: { from: add(b0, mul(nn, -w)), to: add(b0, mul(nn, w)), color: darken(col, 0.35) } });
    pushS(it.lines, mkStroke(poly.concat([pL]), { w: 1.05, center: centroid(poly), shade: 0.9, taper: 0, jit: 0 }));
    // facet edges
    const m0 = add(b0, mul(nn, w * 0.12)), m1 = add(shoulder, mul(nn, w * 0.12));
    pushS(it.lines, mkStroke([m0, m1, tip], { w: 0.55, taper: 0, jit: 0 }));
    const sd = dot(nn, SHADOW) > 0 ? 1 : -1;
    const facetPoly = sd > 0 ? [m0, m1, tip, sR, pR] : [pL, sL, tip, m1, m0];
    for (const [p, q] of hatchPoly(facetPoly, a + 0.35, 1.8, r.next())) pushS(it.hatch, mkHatch(p, q, 0.42));
    if (w > 10) for (const [p, q] of hatchPoly(facetPoly, a - 0.9, 2.6, r.next())) pushS(it.hatch, mkHatch(p, q, 0.3));
    pushS(it.hatch, mkStroke([lerpP(m0, pL, 0.5), lerpP(m1, sL, 0.5)], { w: 1.4, taper: 0.3, color: 'rgba(255,255,250,0.8)' }));
    E.items.push(it);
  }
}

// ================================================================== engraving: ground, water, bark, rock

function engraveGround(E, c0, half, style = 'plain') {
  let c = c0;
  const r = E.r;
  const it = mkItem(3, 0, 0, { origin: c });
  const x0 = Math.max(AREA.x0 - 20, c.x - half), x1 = Math.min(AREA.x1 + 20, c.x + half);
  if (style === 'waves') {
    const lam = 26;
    let x = x0;
    while (x < x1 - lam) {
      const pts = [];
      for (let i = 0; i <= 12; i++) { const t = i / 12; pts.push(P(x + t * lam * 0.85, c.y - Math.sin(Math.PI * t) * 7)); }
      const cc = P(x + lam * 0.72, c.y - 7.5);
      let a = -Math.PI / 2;
      for (let i = 0; i < 16; i++) { a += 0.42; const rr = 4.2 * (1 - i / 22); pts.push(add(cc, P(Math.cos(a) * rr, Math.sin(a) * rr))); }
      pushS(it.lines, mkStroke(pts, { w: 0.7, taper: 0.1, taperEnd: 0.4, step: 1.2 }));
      x += lam * 0.95;
    }
    for (let k = 1; k <= 3; k++) {
      const pts = [];
      for (let xx = x0 + k * 6; xx < x1 - k * 6; xx += 3) pts.push(P(xx, c.y + k * 5 + Math.sin(xx * 0.18 + k) * 1.4));
      pushS(it.hatch, mkStroke(pts, { w: 0.4, taper: 0.2 }));
    }
  } else {
    const pts = [];
    const cx = (x0 + x1) / 2;
    c = P(cx, c.y);
    for (let x = x0; x <= x1; x += 4) pts.push(P(x, c.y + Math.sin(x * 0.03) * 1.2 + r.float(-0.4, 0.4)));
    pushS(it.lines, mkStroke(pts, { w: 0.9, taper: 0.15, rng: r, jit: 0.3 }));
    // the soil beneath: short strokes and crumbs
    for (let k = 0; k < 80; k++) {
      const yy = c.y + Math.pow(r.next(), 1.6) * 16 + 1.5;
      const span = (x1 - x0) * (1 - (yy - c.y) / 22);
      const xx = c.x + r.float(-0.5, 0.5) * span;
      pushS(it.hatch, mkHatch(P(xx, yy), P(xx + r.float(3, 9), yy + r.float(-0.4, 0.4)), 0.38));
    }
    const dots = [];
    for (let k = 0; k < 60; k++) dots.push({ x: c.x + r.float(-0.5, 0.5) * (x1 - x0), y: c.y + r.float(1, 12), r: r.float(0.3, 0.7) });
    it.dots.push({ pts: dots });
    for (let k = 0; k < 6; k++) {
      const p = P(c.x + r.float(-0.45, 0.45) * (x1 - x0), c.y + r.float(2, 9));
      pushS(it.hatch, mkStroke(ellipsePts(p, r.float(1.5, 3.5), r.float(1, 2), 0, 10), { w: 0.45, taper: 0 }));
    }
  }
  E.items.push(it);
  return it;
}

function engraveWater(E, y, xa, xb, crossings) {
  const r = E.r;
  const it = mkItem(1.5, 0, 0, { origin: P((xa + xb) / 2, y) });
  const x0 = Math.max(AREA.x0 - 10, xa), x1 = Math.min(AREA.x1 + 10, xb);
  const rows = [0, 3.5, 7.5, 12.5, 18.5, 26, 35];
  rows.forEach((dy, k) => {
    const shrink = k * 26;
    let x = x0 + shrink * r.float(0.6, 1.2);
    const end = x1 - shrink * r.float(0.6, 1.2);
    while (x < end) {
      const len = r.float(18, 70) * (1 - k * 0.08);
      const xe = Math.min(end, x + len);
      const pts = [];
      for (let xx = x; xx <= xe; xx += 3) pts.push(P(xx, y + dy + Math.sin(xx * 0.09 + k) * 0.7));
      if (pts.length > 1) pushS(it.lines, mkStroke(pts, { w: k === 0 ? 0.75 : 0.5, taper: 0.25 }));
      x = xe + r.float(3, 12) + k * 2;
    }
  });
  for (const cx of crossings) {
    for (const k of [1, 2]) {
      const el = ellipsePts(P(cx, y + 1), 6 + k * 6, 1.4 + k * 1.2, 0, 24, Math.PI * 0.05, Math.PI * 0.95);
      pushS(it.hatch, mkStroke(el, { w: 0.45, taper: 0.2 }));
    }
  }
  E.items.push(it);
  // a pale tint just under the surface, lens-shaped so it fades out at the ends
  const wi = mkItem(0.5, 0, 0, { origin: P((xa + xb) / 2, y) });
  const lens = [];
  const depth = 90;
  for (let i = 0; i <= 40; i++) { const u = i / 40; lens.push(P(lerp(x0 + 20, x1 - 20, u), y - 1)); }
  for (let i = 40; i >= 0; i--) { const u = i / 40; lens.push(P(lerp(x0 + 20, x1 - 20, u), y + depth * Math.pow(Math.sin(Math.PI * u), 0.6))); }
  wi.washes.push({ poly: lens, color: C(188, 28, 72), alpha: 0.42, edge: 0, blots: 0, shade: { from: P(0, y), to: P(0, y + depth), color: C(190, 30, 80), stops: [[0, C(186, 30, 68), 0.55], [0.5, C(188, 30, 74), 0.25], [1, C(190, 30, 80), 0]] } });
  E.items.push(wi);
}

function engraveBark(E, L, S) {
  const r = E.r;
  const s = L.s;
  const B = L.T(P(0, 0));
  const rad0 = clamp(S.extras.bark.r * s * 1.1, 16, 42);
  const tilt = S.extras.bark.tilt;
  const half = clamp(215 * s, 120, (AREA.x1 - AREA.x0) / 2 - 10);
  const cy = (x) => B.y + rad0 * 0.88 + (x - B.x) * tilt;
  L.bark = { y: (x) => cy(x) - rad0, r: rad0 };
  const xa = clamp(B.x - half, AREA.x0 - 10, AREA.x1), xb = clamp(B.x + half, AREA.x0, AREA.x1 + 10);
  const wob = wobble(r, 30), wob2 = wobble(r, 11);
  const topE = [], botE = [];
  for (let x = xa; x <= xb; x += 3) {
    topE.push(P(x, cy(x) - rad0 + wob(x) * 2.5 + wob2(x) * 0.8));
    botE.push(P(x, cy(x) + rad0 + wob(x + 50) * 2.5));
  }
  // broken end on the left, a clean saw cut with growth rings on the right
  const leftEnd = [];
  for (let k = 0; k <= 8; k++) { const t = k / 8; leftEnd.push(P(xa + (k % 2 ? r.float(4, 12) : r.float(-3, 3)), lerp(cy(xa) + rad0, cy(xa) - rad0, t))); }
  const poly = topE.concat(spline([botE[botE.length - 1], P(xb + rad0 * 0.35, cy(xb)), topE[topE.length - 1]], 4).reverse().slice(1, -1)).concat(botE.slice().reverse()).concat(leftEnd.slice(1, -1));
  const it = mkItem(4, 0, 0, { origin: P(xa, cy(xa)) });
  it.occ = [poly];
  const bcol = C(30, 22, 46);
  it.washes.push({ poly, color: lighten(bcol, 0.2), alpha: 0.7, shade: { from: P(0, cy(B.x) - rad0), to: P(0, cy(B.x) + rad0), color: darken(bcol, 0.15) } });
  pushS(it.lines, mkStroke(topE, { w: 0.9, side: -1, shade: 0.5, taper: 0.03, rng: r, jit: 0.4 }));
  pushS(it.lines, mkStroke(botE, { w: 1.3, side: 1, shade: 0.5, taper: 0.03, rng: r, jit: 0.4 }));
  pushS(it.lines, mkStroke(leftEnd, { w: 0.8, taper: 0.05 }));
  // fissures along the bark
  for (let k = 0; k < Math.round((xb - xa) / 9); k++) {
    const x = r.float(xa + 8, xb - 12), v = r.float(-0.85, 0.9);
    const len = r.float(14, 50);
    const pts = [];
    for (let xx = x; xx < Math.min(xb - 5, x + len); xx += 3) pts.push(P(xx, cy(xx) + v * rad0 * Math.cos(v * 0.6) + wob(xx * 1.7 + k) * 1.4));
    if (pts.length > 1) pushS(it.hatch, mkStroke(pts, { w: v > 0.2 ? 0.5 : 0.38, taper: 0.3 }));
  }
  for (let x = xa + 4; x < xb - 4; x += 2.4) {
    const v0 = r.float(0.25, 0.55);
    pushS(it.hatch, mkHatch(P(x, cy(x) + rad0 * 0.97), P(x + 1.2, cy(x) + rad0 * v0), 0.36));
  }
  // lichen
  for (let k = 0; k < 3; k++) {
    const lx = r.float(xa + 30, xb - 30);
    const p = P(lx, cy(lx) + r.float(-0.6, 0.2) * rad0);
    const lp = ellipsePts(p, r.float(6, 14), r.float(3, 7), r.float(-0.3, 0.3), 14);
    it.washes.push({ poly: lp, color: C(80, 20, 65), alpha: 0.45, edge: 1 });
    const d = [];
    for (let i = 0; i < 25; i++) { const a = r.float(0, TAU), rr = Math.sqrt(r.next()); d.push({ x: p.x + Math.cos(a) * rr * 10, y: p.y + Math.sin(a) * rr * 5, r: 0.45 }); }
    it.dots.push({ pts: d });
  }
  E.items.push(it);
  // the cut face with its rings
  const ci = mkItem(4.1, 0, 0.01, { origin: P(xb, cy(xb)) });
  const face = ellipsePts(P(xb, cy(xb)), rad0 * 0.32, rad0 * 0.98, 0, 30);
  ci.occ = [face];
  ci.washes.push({ poly: face, color: C(35, 35, 75), alpha: 0.6 });
  pushS(ci.lines, mkStroke(face, { w: 0.8, taper: 0 }));
  for (const k of [0.75, 0.52, 0.3, 0.12]) pushS(ci.hatch, mkStroke(ellipsePts(P(xb + 0.5, cy(xb) + 1), rad0 * 0.32 * k, rad0 * 0.98 * k, 0, 24), { w: 0.35, taper: 0 }));
  E.items.push(ci);
}

function engraveLedge(E, L) {
  const r = E.r;
  const B = L.T(P(0, 0));
  const xa = Math.max(AREA.x0 - 20, B.x - r.float(220, 300)), xb = Math.min(AREA.x1 + 20, B.x + r.float(220, 300));
  const top = AREA.y0 + 2;
  const wob = wobble(r, 60), wob2 = wobble(r, 14);
  const bot = [];
  for (let x = xa; x <= xb; x += 3) {
    const near = Math.exp(-Math.pow((x - B.x) / 40, 2));
    const ends = smoothstep(0, 60, Math.min(x - xa, xb - x));
    let y = lerp(top + 18, B.y + wob(x) * 14 + wob2(x) * 4, ends);
    y = lerp(y, B.y + 2, near);
    bot.push(P(x, y));
  }
  const topE = [];
  for (let x = xb; x >= xa; x -= 6) topE.push(P(x, top + wob(x + 300) * 4 + smoothstep(60, 0, Math.min(x - xa, xb - x)) * 12));
  const poly = bot.concat(topE);
  const it = mkItem(4, 0, 0, { origin: P(B.x, top) });
  it.occ = [poly];
  const scol = C(35, 12, 52);
  it.washes.push({ poly, color: lighten(scol, 0.25), alpha: 0.72, shade: { from: P(0, top), to: P(0, B.y + 10), color: darken(scol, 0.2) } });
  pushS(it.lines, mkStroke(bot, { w: 1.3, taper: 0.03, rng: r, jit: 0.5 }));
  pushS(it.lines, mkStroke(topE, { w: 0.7, taper: 0.05, rng: r, jit: 0.5 }));
  // strata and cracks
  for (let k = 0; k < 9; k++) {
    const yy = top + 6 + k * 7 + r.float(-2, 2);
    const xs = r.float(xa + 10, xb - 80), xe = Math.min(xb - 10, xs + r.float(40, 200));
    const pts = [];
    for (let x = xs; x < xe; x += 4) pts.push(P(x, yy + wob2(x + k * 40) * 2));
    const pin = pts.filter((p) => inPoly(p, poly));
    if (pin.length > 2) pushS(it.hatch, mkStroke(pin, { w: 0.42, taper: 0.3 }));
  }
  // the dark underside, cross-hatched
  for (const [a, b] of hatchPoly(poly, 0.35, 2.4, 0.1)) {
    const ya = Math.max(a.y, b.y);
    const edgeY = bot[Math.round(clamp((((a.x + b.x) / 2) - xa) / 3, 0, bot.length - 1))].y;
    if (edgeY - ya < 26) {
      const lo = a.y > b.y ? a : b, hi = a.y > b.y ? b : a;
      pushS(it.hatch, mkHatch(lo, lerpP(lo, hi, clamp(0.5 + r.float(-0.2, 0.2), 0.1, 1)), 0.4));
    }
  }
  for (const [a, b] of hatchPoly(poly, -0.5, 3.0, 0.6)) {
    const edgeY = bot[Math.round(clamp((((a.x + b.x) / 2) - xa) / 3, 0, bot.length - 1))].y;
    const lo = a.y > b.y ? a : b;
    if (edgeY - lo.y < 12) pushS(it.hatch, mkHatch(lo, lerpP(lo, a.y > b.y ? b : a, 0.4), 0.35));
  }
  // drips
  for (let k = 0; k < 4; k++) {
    const p = bot[r.int(5, bot.length - 6)];
    if (Math.abs(p.x - B.x) < 30) continue;
    const dl = r.float(6, 16);
    const drip = [add(p, P(-2.2, -1)), add(p, P(-0.6, dl * 0.7)), add(p, P(0, dl)), add(p, P(0.6, dl * 0.7)), add(p, P(2.2, -1))];
    pushS(it.lines, mkStroke(drip, { w: 0.6, taper: 0.1 }));
  }
  E.items.push(it);
}

// ================================================================== marvels

const NEST_H = { rotate: 0.1, stellate: 0.08, campanulate: 0.55, tubular: 0.95, cup: 0.36, lantern: 1.0, labiate: 0.42, globose: 0.55, spiral: 0.16 };

function flowerMarvels(E, fl, F, c3, form, m, zOf, phase, key, petals, o) {
  const r = E.r, R = fl.R, mv = E.marvel;
  const nest = o.nest || 0;
  const zTop = fl.z + Math.min(fl.rank, 100) * 0.45 + 0.47;
  const centre = proj(add3(c3, mul3(F.A, R * (['campanulate', 'tubular', 'lantern'].includes(form) ? 0.55 : 0.2))));
  if (mv === 'nested') {
    const maxNest = R > 40 ? 2 : 1;
    if (nest < maxNest && R * 0.42 > 7) {
      const h = (NEST_H[form] || 0.3) * R;
      const p3 = add3(c3, mul3(F.A, h));
      engraveFlower(E, { c: proj(p3), dz: p3.z, axis: fl.axis, R: R * 0.42, z: fl.z, rank: fl.rank }, { ...o, nest: nest + 1, phase, key: key + 0.001 * (nest + 1) });
    }
    return;
  }
  if (nest) return;
  if (mv === 'luminous' && !o.figure) {
    const gold = C(47, 80, 76);
    const gr = R * 2.2;
    const it = mkItem(0.6, 4.6, key, { origin: centre });
    const gpoly = ellipsePts(centre, gr, gr, 0, 40).map((q) => P(clamp(q.x, PLATE.x0 + 6, PLATE.x1 - 6), clamp(q.y, PLATE.y0 + 6, PLATE.y1 - 6)));
    it.washes.push({ poly: gpoly, color: gold, alpha: 1, hard: true, edge: 0, blots: 0, glow: true,
      radial: { c: centre, r0: R * 0.15, r1: gr, stops: [[0, gold, 0.42], [0.35, gold, 0.24], [0.7, gold, 0.07], [1, gold, 0]] } });
    const dots = [];
    const nr = clamp(Math.round(R / 3), 10, 24);
    for (let k = 0; k < nr; k++) {
      const a = (k / nr) * TAU + r.float(-0.05, 0.05);
      for (let d = R * 1.3; d < R * (1.75 + r.float(0, 0.35)); d += 3.4) { const q = P(centre.x + Math.cos(a) * d, centre.y + Math.sin(a) * d); if (q.y > AREA.y0 - 20 && q.x > AREA.x0 - 20 && q.x < AREA.x1 + 20) dots.push({ x: q.x, y: q.y, r: 0.42 }); }
    }
    it.dots.push({ pts: dots });
    E.items.push(it);
  }
  if (mv === 'smoke' && !o.figure && (E._smoke = (E._smoke || 0) + 1) <= 6) {
    for (let k = 0; k < r.int(2, 3); k++) {
      const it = mkItem(60, 5, key, { origin: centre });
      let p = add(centre, P(r.float(-0.2, 0.2) * R, -R * 0.2)), a = UP + r.float(-0.4, 0.4);
      const pts = [p];
      const len = clamp(R * r.float(2.4, 3.6), 50, 230), steps = 60;
      const ph = r.float(0, TAU), drift = r.float(-0.012, 0.012);
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        a += Math.sin(t * TAU * 1.6 + ph) * 0.07 * (0.4 + t) + drift;
        p = add(p, dirOf(a, len / steps)); pts.push(p);
      }
      const sd = r.chance(0.5) ? 1 : -1;
      let rr = r.float(5, 10);
      for (let i = 0; i < 26; i++) { a += sd * 0.3; rr *= 0.95; p = add(p, dirOf(a, rr * 0.3)); pts.push(p); }
      if (!pts.every(fin)) continue;
      const cutAt = pts.findIndex((q) => q.y < AREA.y0 + 4 || q.x < AREA.x0 || q.x > AREA.x1);
      if (cutAt >= 0) pts.length = cutAt;
      if (pts.length < 8) continue;
      const smokeInk = 'rgb(96,100,112)';
      pushS(it.lines, mkStroke(pts, { w: 0.5, taper: 0.1, taperEnd: 0.4, color: smokeInk, rng: r, jit: 0.2 }));
      const off = pts.map((q, i) => add(q, P(Math.sin(i * 0.2) * 2.5 + 2.5, 0)));
      pushS(it.hatch, mkStroke(off.slice(5, Math.round(off.length * 0.8)), { w: 0.35, taper: 0.3, color: smokeInk }));
      const rb = ribbon(resample(pts.slice(0, Math.min(steps, pts.length)), 4), (t) => 3 + t * 16);
      it.washes.push({ poly: rb.poly, color: C(212, 22, 74), alpha: 0.3, edge: 0.4, blots: 0 });
      E.items.push(it);
    }
  }
  if (mv === 'weeping') {
    const sel = petals.filter(() => r.chance(0.55)).slice(0, 7);
    for (const pi of sel) {
      const tip = proj(pi.surf.at(pi.tEnd * 0.97, 0));
      if (!fin(tip)) continue;
      const rd = clamp(R * 0.065, 1.6, 4.6);
      const c = add(tip, P(0, rd * 1.7));
      const poly = [tip];
      for (let i = 0; i <= 16; i++) { const a = -Math.PI / 2 + 0.75 + (i / 16) * (TAU - 1.5); poly.push(add(c, dirOf(a, rd))); }
      const it = mkItem(pi.it.z + 0.003, phase + 0.3, key + 0.002, { origin: tip });
      it.occ = [poly];
      it.washes.push({ poly, color: C(200, 35, 80), alpha: 0.45, hard: true, edge: 1, blots: 0 });
      pushS(it.lines, mkStroke(poly.concat([tip]), { w: 0.5, taper: 0, step: 1 }));
      it.fills.push({ poly: ellipsePts(add(c, P(-rd * 0.35, -rd * 0.3)), rd * 0.28, rd * 0.18, -0.6, 8), color: 'rgba(255,255,252,0.95)' });
      pushS(it.hatch, mkStroke(ellipsePts(c, rd * 0.75, rd * 0.75, 0, 12, 0.3, 1.6), { w: 0.4, taper: 0.2 }));
      E.items.push(it);
      if (r.chance(0.25)) {
        const c2 = add(c, P(0, rd * r.float(5, 9)));
        const p2 = ellipsePts(c2, rd * 0.75, rd * 0.9, 0, 14);
        const it2 = mkItem(59, phase + 0.3, key + 0.003, { origin: c2 });
        it2.washes.push({ poly: p2, color: C(200, 35, 80), alpha: 0.4, hard: true });
        pushS(it2.lines, mkStroke(p2, { w: 0.45, taper: 0 }));
        it2.fills.push({ poly: ellipsePts(add(c2, P(-rd * 0.25, -rd * 0.3)), rd * 0.2, rd * 0.14, -0.6, 8), color: 'rgba(255,255,252,0.95)' });
        E.items.push(it2);
      }
    }
  }
  if (mv === 'constellation') {
    const inner = petals.filter((p) => p.inner && Math.abs(polyArea(p.poly)) > 60);
    if (inner.length) {
      const n = clamp(Math.round(R / 7), 4, 8);
      const stars = [];
      for (let k = 0; k < n * 3 && stars.length < n; k++) {
        const pi = inner[Math.floor(r.next() * inner.length)];
        const t = r.float(0.3, 0.85), y = r.float(-0.55, 0.55) * pi.prof(t);
        const q = proj(pi.surf.at(t, y));
        if (fin(q) && stars.every((s2) => dist(s2, q) > R * 0.12)) stars.push(q);
      }
      if (stars.length > 1) {
        const it = mkItem(zTop, phase + 0.2, key + 0.002, { origin: stars[0] });
        const order = [stars.shift()];
        while (stars.length) { const last = order[order.length - 1]; let bi = 0; for (let i = 1; i < stars.length; i++) if (dist(stars[i], last) < dist(stars[bi], last)) bi = i; order.push(stars.splice(bi, 1)[0]); }
        const dots = [];
        for (let i = 1; i < order.length; i++) {
          const a = order[i - 1], b = order[i], dd = dist(a, b);
          for (let s2 = 3; s2 < dd - 3; s2 += 2.6) { const q = lerpP(a, b, s2 / dd); dots.push({ x: q.x, y: q.y, r: 0.38 }); }
        }
        it.dots.push({ pts: dots });
        for (const q of order) {
          const rs = clamp(R * 0.045, 1.3, 2.8) * r.float(0.8, 1.2);
          const star = [];
          for (let k = 0; k < 8; k++) star.push(add(q, dirOf((k / 8) * TAU + 0.2, k % 2 ? rs * 0.45 : rs * 1.25)));
          it.fills.push({ poly: star, color: 'rgba(255,253,236,0.95)' });
          pushS(it.lines, mkStroke(star.concat([star[0]]), { w: 0.35, taper: 0, step: 0.8 }));
        }
        E.items.push(it);
      }
    }
  }
  if (mv === 'clockwork' && Math.abs(F.A.z) > 0.3) {
    const it = mkItem(zTop - 0.01, phase + 0.2, key + 0.002, { origin: centre });
    const at3 = (rr, phi) => proj(add3(add3(c3, mul3(F.A, 0.02 * R)), add3(mul3(F.U, Math.cos(phi) * rr * R), mul3(F.V, Math.sin(phi) * rr * R))));
    const reach = form === 'stellate' || g_tail(E) ? 1.5 : 1.16;
    for (let k = 0; k < 12; k++) {
      const phi = (k / 12) * TAU;
      pushS(it.lines, mkStroke([at3(reach, phi), at3(reach + (k % 3 === 0 ? 0.16 : 0.08), phi)], { w: k % 3 === 0 ? 0.75 : 0.5, taper: 0, jit: 0 }));
    }
    const ring = [];
    for (let i = 0; i <= 60; i++) ring.push(at3(reach - 0.03, (i / 60) * TAU));
    const dots = resample(ring, 2.8).map((q) => ({ x: q.x, y: q.y, r: 0.32 }));
    it.dots.push({ pts: dots });
    E.items.push(it);
  }
  if (mv === 'echoing' && !o.figure && !E._echo) {
    E._echo = true;
    const it = mkItem(zTop, 5, key, { origin: centre });
    const side = centre.x < LW / 2 ? 0 : Math.PI;
    for (let k = 1; k <= 3; k++) {
      const rr = R * (1.25 + k * 0.32);
      const arc = ellipsePts(centre, rr, rr, 0, 30, side - 0.45, side + 0.45);
      it.dots.push({ pts: resample(arc, 3).map((q) => ({ x: q.x, y: q.y, r: 0.4 })) });
    }
    E.items.push(it);
  }
}
function g_tail(E) { return E.g.flower.petalTip === 'filiform'; }

// Apply f to every point of an item (returns a new item).
function mapItem(it, f, o = {}) {
  const fc = (c) => (o.color ? o.color(c) : c);
  const ms = (s) => (s ? { ...s, pts: s.pts.map(f), color: fc(s.color) } : s);
  const mw = (w) => ({ ...w, alpha: (w.alpha == null ? 0.7 : w.alpha) * (o.alpha || 1), poly: w.poly && w.poly.map(f), polys: w.polys && w.polys.map((p) => p.map(f)), holes: w.holes && w.holes.map((h) => h.map(f)),
    shade: w.shade && { ...w.shade, from: f(w.shade.from), to: f(w.shade.to) }, radial: w.radial && { ...w.radial, c: f(w.radial.c) }, origin: w.origin && f(w.origin) });
  return { ...it, occ: it.occ && it.occ.map((p) => p.map(f)), washes: it.washes.map(mw), lines: it.lines.map(ms), hatch: it.hatch.map(ms),
    dots: it.dots.map((d) => ({ ...d, color: fc(d.color), pts: d.pts.map((p) => { const q = f(p); return { x: q.x, y: q.y, r: p.r }; }) })),
    fills: it.fills.map((x) => ({ ...x, poly: x.poly.map(f) })), origin: it.origin && f(it.origin) };
}

function itemsBBox(items) {
  let bb = null;
  for (const it of items) { const b = itemBBox(it); if (b) bb = bbUnion(bb, b); }
  return bb;
}

// ================================================================== figures

function engraveFigure(E, fig, box, idx, ctx) {
  const g = E.g;
  const S = box.S;
  const Sc = S - 30;
  const C0 = P(box.x + S / 2, box.y + (S - 24) / 2);
  const build = (k) => {
    const sub = { ...E, items: [], r: makeRng(hash32(g.seed + ':fig:' + idx)), _smoke: 99, _echo: true };
    drawFigureKind(sub, fig, P(500, 500), Sc * k, ctx);
    return sub.items;
  };
  let items = build(1);
  let bb = itemsBBox(items);
  if (!bb) return [];
  const kMax = { fruit: 1.35, seed: 1.5, 'fruit-section': 1.3, stamen: 1.4, 'flower-front': 1.5, bud: 1.5, leaf: 1.3, 'flower-section': 1.3 }[fig.kind] || 2;
  const k = Math.min(kMax, Sc / Math.max(1, bb.x1 - bb.x0), (Sc + 8) / Math.max(1, bb.y1 - bb.y0));
  if (k < 0.98 || k > 1.08) {
    items = build(k * 0.97); bb = itemsBBox(items);
    const k2 = Math.min(Sc / Math.max(1, bb.x1 - bb.x0), (Sc + 8) / Math.max(1, bb.y1 - bb.y0));
    if (k2 < 0.98) { items = build(k * k2 * 0.95); bb = itemsBBox(items); }
  }
  const dx = C0.x - (bb.x0 + bb.x1) / 2, dy = C0.y - (bb.y0 + bb.y1) / 2;
  const out = items.map((it) => {
    const m2 = mapItem(it, (p) => P(p.x + dx, p.y + dy));
    m2.z = 100 + idx * 10 + clamp(it.z, 0, 99) / 10;
    m2.phase = 6 + idx * 0.1 + clamp(it.phase, 0, 9) * 0.001;
    return m2;
  });
  const fb = itemsBBox(out);
  return { items: out, bb: fb };
}

function drawFigureKind(E, fig, c, Sc, ctx) {
  const g = E.g, r = E.r;
  const kind = fig.kind;
  switch (kind) {
    case 'flower-front': {
      const R = Sc * (g.flower.stamens === 'plume' ? 0.29 : g.flower.petalTip === 'filiform' ? 0.33 : 0.42);
      engraveFlower(E, { c, axis: V3(0.06, -0.1, 1), R, z: 40, rank: 0 }, { figure: true, phase: 6, key: 0 });
      break;
    }
    case 'bud': {
      engraveBud(E, { c: add(c, P(-Sc * 0.12, Sc * 0.32)), dir: UP + 0.15, R: Sc * 0.3, z: 40, rank: 0 }, { phase: 6, key: 0 });
      const st = { pts: [add(c, P(-Sc * 0.12, Sc * 0.32)), add(c, P(-Sc * 0.14, Sc * 0.48))], w0: 2.2, w1: 2, z: 30, kind: 'pedicel', key: 0, armature: 'none' };
      engraveStem(E, st, 6);
      engraveBud(E, { c: add(c, P(Sc * 0.24, Sc * 0.3)), dir: UP - 0.35, R: Sc * 0.17, z: 40, rank: 1 }, { phase: 6, key: 0.1 });
      break;
    }
    case 'fruit': {
      const f = g.fruit.form;
      const lenK = { berry: 3.4, drupe: 3.0, capsule: 3.1, pod: 5.6, samara: 3.6, bladder: 2.9, beads: 5.5 }[f] || 3;
      const rr = Sc * 0.88 / lenK;
      const ang = ['pod', 'beads', 'capsule'].includes(f) ? DOWN - 0.7 : DOWN;
      const at = sub(c, dirOf(ang, Sc * 0.42));
      engraveFruit(E, { at, ang, R: rr / 0.34, z: 38, hang: false }, { phase: 6, key: 0, noHang: true });
      if (f === 'berry' || f === 'drupe') {
        // two more, smaller, on stalks from the same point: a little truss
        for (const sd of [-1, 1]) engraveFruit(E, { at, ang: ang + sd * 0.75, R: (rr * 0.72) / 0.34, z: 37, hang: false }, { phase: 6, key: 0.1, noHang: true, zAdd: -0.5 });
      }
      break;
    }
    case 'leaf': {
      const shape = g.leaf.shape;
      const k = { orbicular: 0.82, peltate: 0.45, palmate: 0.48, cordate: 0.72, sagittate: 0.72, lobed: 0.88, ovate: 0.92, pinnate: 0.88, linear: 1.25, ensiform: 1.2, lanceolate: 1.05, needle: 0.8, terete: 0.75 }[shape] || 0.9;
      const L = Sc * k;
      const ang = shape === 'peltate' ? 0 : -Math.PI / 2 + 0.55;
      const base = sub(c, dirOf(ang, L * 0.48));
      const d = leafDims(g, r, 1);
      const W = shape === 'peltate' || shape === 'palmate' ? L : L * (d.W / d.L);
      const under = r.chance(0.5);
      engraveLeaf(E, { at: base, ang, L, W, pet: shape === 'peltate' ? 0 : Math.min(d.pet / d.L, 0.25) * L * 0.4, shape, droop: 0.1, f0: under ? -0.95 : 0.95, twist: 0, z: 20, kind: 'leaf', curl: 0.1, petBend: 0 });
      break;
    }
    case 'root': {
      const form = g.root.form === 'aerial' ? 'fibrous' : g.root.form;
      const base = add(c, P(0, -Sc * 0.4));
      const sR = Sc / 270;
      const S2 = { roots: { form, at: base, w: 8 }, extras: {} };
      const L2 = { T: (p) => p, s: sR, inverted: false };
      const E2 = { ...E, marvel: E.marvel === 'crystal' ? 'crystal' : 'none' };
      const stub = { pts: [add(base, P(0, -Sc * 0.12)), base], w0: clamp(8 * sR * 1.6, 3, 9), w1: clamp(8 * sR * 1.8, 3, 10), z: 12, kind: 'main', key: 0, armature: 'none', cut: false };
      engraveStem(E2, { ...stub, pts: [base, add(base, P(0, -Sc * 0.12))], cut: true }, 2);
      engraveRoots(E2, S2, L2);
      E.items = E2.items;
      break;
    }
    case 'seed': engraveSeedFig(E, c, Sc); break;
    case 'stamen': engraveStamenFig(E, c, Sc); break;
    case 'flower-section': engraveSectionFig(E, c, Sc); break;
    case 'fruit-section': engraveFruitSectionFig(E, c, Sc); break;
    default: break;
  }
}


function seedShape(c, rx, ry, rot, kidney) {
  const pts = [];
  for (let i = 0; i < 40; i++) {
    const a = (i / 40) * TAU;
    let x = Math.cos(a) * rx, y = Math.sin(a) * ry;
    if (kidney) y -= Math.exp(-Math.pow((a - Math.PI * 1.5) / 0.5, 2)) * ry * 0.45;
    pts.push(add(c, rot2(P(x, y), rot)));
  }
  return pts;
}

function engraveSeedFig(E, c, Sc) {
  const r = E.r, pal = E.pal, g = E.g;
  const f = g.fruit.form;
  const scol = mixColor(pal.fruit, C(30, 40, 35), 0.55);
  if (E.marvel === 'clockwork') {
    const big = { c: add(c, P(-Sc * 0.12, -Sc * 0.05)), r: Sc * 0.3, n: 14 }, small = { c: null, r: Sc * 0.16, n: 8 };
    small.c = add(big.c, dirOf(0.6, big.r + small.r - Sc * 0.01));
    for (const gg of [big, small]) {
      const it = mkItem(40 + (gg === small ? 1 : 0), 6, 0, { origin: gg.c });
      const poly = gearPoly(gg.c, gg.r, gg.n, r.float(0, 1));
      it.occ = [poly];
      pushS(it.lines, mkStroke(poly.concat([poly[0]]), { w: 0.85, center: gg.c, shade: 0.9, taper: 0, jit: 0, step: 1.2 }));
      roundBody(E, it, poly, gg.c, gg.r, scol, { matte: true, dense: 0.5 });
      pushS(it.lines, mkStroke(ellipsePts(gg.c, gg.r * 0.18, gg.r * 0.18, 0, 16), { w: 0.6, taper: 0 }));
      pushS(it.lines, mkStroke(ellipsePts(gg.c, gg.r * 0.66, gg.r * 0.66, 0, 40), { w: 0.45, taper: 0 }));
      for (let k = 0; k < 5; k++) { const a = (k / 5) * TAU + 0.3; pushS(it.lines, mkStroke([add(gg.c, dirOf(a, gg.r * 0.2)), add(gg.c, dirOf(a, gg.r * 0.64))], { w: 0.9, taper: 0 })); }
      E.items.push(it);
    }
    return;
  }
  if (f === 'samara') {
    const fr = { at: add(c, P(-Sc * 0.28, Sc * 0.18)), ang: -0.5, R: (Sc * 0.22) / 0.34 * 0.9, z: 38 };
    engraveFruit(E, fr, { form: 'samara', phase: 6, key: 0, noHang: true });
    return;
  }
  const kidney = f === 'pod' || f === 'capsule';
  const crystal = E.marvel === 'crystal';
  // the seed seen whole, with its pitted coat
  const v = { c: add(c, P(-Sc * 0.14, -Sc * 0.04)), rx: Sc * 0.3, ry: Sc * (kidney ? 0.21 : 0.24), rot: -0.35 };
  const it = mkItem(40, 6, 0, { origin: v.c });
  const poly = crystal ? crystalPoly(v.c, v.rx, v.ry, v.rot, r) : seedShape(v.c, v.rx, v.ry, v.rot, kidney);
  it.occ = [poly];
  pushS(it.lines, mkStroke(poly.concat([poly[0]]), { w: 1.0, center: v.c, shade: 0.9, taper: 0, rng: r, jit: 0.1 }));
  roundBody(E, it, poly, v.c, (v.rx + v.ry) / 2, scol, { dense: 0.35 });
  if (crystal) facetSeed(it, poly, v.c, r);
  else {
    // a honeycomb reticulum, foreshortened towards the rim as on a rounded body
    const cs = v.rx / 5.2;
    const toWorld = (u) => { const d = Math.hypot(u.x, u.y); const k = d > 1e-6 ? Math.sin(Math.min(1, d) * Math.PI / 2) / d : 1; return add(v.c, rot2(P(u.x * k * v.rx, u.y * k * v.ry), v.rot)); };
    const hx = cs / v.rx, hy = (cs * 0.866) / v.ry;
    for (let j = -8; j <= 8; j++) for (let i = -8; i <= 8; i++) {
      const cu = P((i + (j % 2 ? 0.5 : 0)) * hx * 1.5, j * hy * 1.0);
      if (Math.hypot(cu.x, cu.y) > 1.05) continue;
      const corner = (k) => P(cu.x + Math.cos((k * Math.PI) / 3) * hx * 0.5 * 1.15, cu.y + Math.sin((k * Math.PI) / 3) * hy * 0.58);
      for (let k = 0; k < 3; k++) {
        const a = corner(k), b = corner(k + 1);
        if (Math.hypot(a.x, a.y) > 0.97 || Math.hypot(b.x, b.y) > 0.97) continue;
        const pa = toWorld(a), pb = toWorld(b), pm = toWorld(lerpP(a, b, 0.5));
        const lit = dot(nrm(sub(pm, v.c)), LIGHT);
        pushS(it.hatch, mkHatch(pa, pb, lit > 0.3 ? 0.3 : 0.42, null, pm));
      }
    }
    const hil = add(v.c, rot2(P(v.rx * 0.1, v.ry * (kidney ? 0.5 : 0.78)), v.rot));
    const hp = ellipsePts(hil, v.rx * 0.18, v.ry * 0.09, v.rot, 14);
    it.fills.push({ poly: hp, color: 'rgb(60,45,30)' });
    pushS(it.lines, mkStroke([hil, add(v.c, rot2(P(-v.rx * 0.6, v.ry * 0.35), v.rot)), add(v.c, rot2(P(-v.rx * 0.92, -v.ry * 0.05), v.rot))], { w: 0.55, taper: 0.1, taperEnd: 0.6 }));
  }
  E.items.push(it);
  // ...and cut lengthwise: the seed coat, the endosperm, the curled embryo
  const w2 = { c: add(c, P(Sc * 0.3, Sc * 0.24)), rx: Sc * 0.15, ry: Sc * (kidney ? 0.105 : 0.12), rot: 0.25 };
  const it2 = mkItem(41, 6, 1, { origin: w2.c });
  const outer = seedShape(w2.c, w2.rx, w2.ry, w2.rot, kidney);
  const inner = seedShape(w2.c, w2.rx * 0.82, w2.ry * 0.78, w2.rot, kidney);
  it2.occ = [outer];
  it2.washes.push({ poly: outer, color: scol, alpha: 0.75, holes: [inner] });
  it2.washes.push({ poly: inner, color: C(45, 40, 88), alpha: 0.6 });
  pushS(it2.lines, mkStroke(outer.concat([outer[0]]), { w: 0.85, taper: 0 }));
  pushS(it2.lines, mkStroke(inner.concat([inner[0]]), { w: 0.5, taper: 0 }));
  for (const [a, b] of hatchPoly(outer, 0.8, 1.6, 0.3)) for (const [p2, q2] of clipSegOut(a, b, inner)) pushS(it2.hatch, mkHatch(p2, q2, 0.3));
  const emb = [];
  for (let i = 0; i <= 16; i++) {
    const a = lerp(kidney ? 0.4 : -1.2, kidney ? 4.6 : 1.2, i / 16);
    emb.push(add(w2.c, rot2(kidney ? P(Math.cos(a) * w2.rx * 0.5, Math.sin(a) * w2.ry * 0.45) : P(a / 1.2 * w2.rx * 0.6, Math.sin(a * 1.3) * w2.ry * 0.12), w2.rot)));
  }
  const er = ribbon(emb, (t) => lerp(w2.ry * 0.2, w2.ry * 0.3, Math.sin(Math.PI * t)));
  it2.washes.push({ poly: er.poly, color: C(70, 45, 62), alpha: 0.75, hard: true });
  pushS(it2.lines, mkStroke(er.poly.concat([er.poly[0]]), { w: 0.5, taper: 0 }));
  const dots = [];
  const bb = bboxOf(inner);
  for (let k = 0; k < 120; k++) { const q = P(r.float(bb.x0, bb.x1), r.float(bb.y0, bb.y1)); if (inPoly(q, inner) && !inPoly(q, er.poly)) dots.push({ x: q.x, y: q.y, r: 0.32 }); }
  it2.dots.push({ pts: dots });
  E.items.push(it2);
}

function facetSeed(it, poly, c, r) {
  const ctr = add(c, mul(LIGHT, 4));
  for (let i = 0; i < poly.length; i++) {
    pushS(it.hatch, mkHatch(ctr, poly[i], 0.45));
    const a = poly[i], b = poly[(i + 1) % poly.length];
    if (dot(nrm(sub(lerpP(a, b, 0.5), c)), LIGHT) < 0.1) for (const [p, q] of hatchPoly([ctr, a, b], angOf(sub(b, a)) + 0.5, 2.0, r.next())) pushS(it.hatch, mkHatch(p, q, 0.32));
  }
}

function engraveStamenFig(E, c, Sc) {
  const r = E.r, pal = E.pal;
  // a stamen on the left...
  const it = mkItem(40, 6, 0, { origin: add(c, P(-Sc * 0.2, Sc * 0.45)) });
  const fb = add(c, P(-Sc * 0.2, Sc * 0.46)), ft = add(c, P(-Sc * 0.16, -Sc * 0.12));
  const fil = spline([fb, add(lerpP(fb, ft, 0.5), P(-Sc * 0.05, 0)), ft], 8);
  const rb = ribbon(fil, (t) => lerp(Sc * 0.035, Sc * 0.022, t));
  it.occ = [rb.poly];
  it.washes.push({ poly: rb.poly, color: lighten(pal.inner, 0.3), alpha: 0.6 });
  pushS(it.lines, mkStroke(rb.left, { w: 0.7, side: -1, shade: 0.6, taper: 0 }));
  pushS(it.lines, mkStroke(rb.right, { w: 0.7, side: 1, shade: 0.6, taper: 0 }));
  E.items.push(it);
  const ai = mkItem(41, 6, 0.1, { origin: ft });
  const ah = Sc * 0.3, aw = Sc * 0.075;
  const occs = [];
  for (const sd of [-1, 1]) {
    const tc = add(ft, P(sd * aw * 0.95, -ah * 0.45));
    const th = ellipsePts(tc, aw, ah / 2, 0, 30);
    occs.push(th);
    roundBody(E, ai, th, tc, aw, pal.accent, { matte: true, dense: 0.8 });
    pushS(ai.lines, mkStroke(th, { w: 0.8, center: tc, shade: 0.9, taper: 0 }));
    pushS(ai.hatch, mkStroke([add(tc, P(sd * aw * 0.45, -ah * 0.42)), add(tc, P(sd * aw * 0.5, 0)), add(tc, P(sd * aw * 0.45, ah * 0.42))], { w: 0.5, taper: 0.1 }));
  }
  ai.occ = occs;
  // pollen spilling from the slit
  const pd = [];
  for (let k = 0; k < 26; k++) { const q = add(ft, P(Sc * 0.1 + r.float(0, Sc * 0.12), -ah * 0.6 + r.float(-Sc * 0.08, Sc * 0.25))); pd.push({ x: q.x, y: q.y, r: r.float(0.6, 1.4) }); }
  ai.dots.push({ pts: pd, color: INK });
  E.items.push(ai);
  // ...and the pistil on the right
  const pi = mkItem(40, 6, 0.2, { origin: add(c, P(Sc * 0.22, Sc * 0.46)) });
  const ob = add(c, P(Sc * 0.22, Sc * 0.46));
  const ow = Sc * 0.13, oh = Sc * 0.2;
  const ov = [];
  for (let i = 0; i <= 30; i++) { const a = (i / 30) * TAU; const t = (1 - Math.cos(a)) / 2; ov.push(add(ob, P(Math.sin(a) * ow * Math.pow(Math.sin(Math.PI * clamp(t, 0.02, 0.98)), 0.7), -t * oh))); }
  const sty = [add(ob, P(0, -oh)), add(ob, P(Sc * 0.02, -oh - Sc * 0.25)), add(ob, P(-Sc * 0.01, -oh - Sc * 0.48))];
  const srb = ribbon(spline(sty, 6), (t) => lerp(Sc * 0.03, Sc * 0.018, t));
  pi.occ = [ov, srb.poly];
  roundBody(E, pi, ov, add(ob, P(0, -oh / 2)), ow, mixColor(pal.leaf, C(80, 30, 75), 0.5), { matte: true, dense: 0.5 });
  pushS(pi.lines, mkStroke(ov, { w: 0.85, center: add(ob, P(0, -oh / 2)), shade: 0.9, taper: 0 }));
  pi.washes.push({ poly: srb.poly, color: lighten(pal.inner, 0.25), alpha: 0.6 });
  pushS(pi.lines, mkStroke(srb.left, { w: 0.6, side: -1, shade: 0.6, taper: 0 }));
  pushS(pi.lines, mkStroke(srb.right, { w: 0.6, side: 1, shade: 0.6, taper: 0 }));
  const st = sty[2];
  const sd = [];
  for (let k = 0; k < 3; k++) {
    const a = UP + (k - 1) * 0.75;
    const lob = spline([st, add(st, dirOf(a - 0.15, Sc * 0.05)), add(st, dirOf(a + 0.1, Sc * 0.09))], 5);
    pushS(pi.lines, mkStroke(lob, { w: 1.1, taper: 0.1, taperEnd: 0.4 }));
    for (let j = 0; j < 6; j++) { const q = add(lob[lob.length - 1], P(r.float(-2, 2), r.float(-2, 2))); sd.push({ x: q.x, y: q.y, r: 0.5 }); }
  }
  pi.dots.push({ pts: sd });
  E.items.push(pi);
}

function engraveSectionFig(E, c, Sc) {
  const r = E.r, pal = E.pal, g = E.g;
  const form = g.flower.form;
  const rec = add(c, P(0, Sc * 0.18));
  // gamma profile of the corolla, seen in section
  const specs = corollaSpecs(form, 5, 1, g.flower.petalTip, r).filter((s) => s.kind === 'petal');
  const sp = specs.find((s) => Math.abs(Math.cos(s.phi)) < 0.6) || specs[0];
  const Lp = Sc * (form === 'tubular' ? 0.62 : form === 'lantern' ? 0.5 : form === 'rotate' || form === 'stellate' ? 0.48 : 0.55);
  const ow = Sc * 0.11;
  const side = (sd) => {
    const pts = [];
    let p = add(rec, P(sd * ow * 0.9, -Sc * 0.03));
    pts.push(p);
    for (let i = 1; i <= 24; i++) { const t = i / 24; const gm = sp.gamma(t); p = add(p, P(sd * Math.cos(gm) * Lp / 24, -Math.sin(gm) * Lp / 24)); pts.push(p); }
    return pts;
  };
  const backFill = [];
  for (const sd of [-1, 1]) {
    const cl = side(sd);
    const rb = ribbon(cl, (t) => lerp(3.2, 1.6, t));
    const pi = mkItem(41, 6, 0.1, { origin: cl[0] });
    pi.occ = [rb.poly];
    pi.washes.push({ poly: rb.poly, color: lighten(pal.flower, 0.35), alpha: 0.7, hard: true });
    pushS(pi.lines, mkStroke(rb.left, { w: 0.6, taper: 0.02 }));
    pushS(pi.lines, mkStroke(rb.right, { w: 0.6, taper: 0.02 }));
    E.items.push(pi);
    backFill.push(cl);
    // sepal below
    const sl = [];
    let q = add(rec, P(sd * ow * 0.8, -Sc * 0.01));
    sl.push(q);
    const bell = ['campanulate', 'tubular', 'lantern', 'labiate', 'cup'].includes(form);
    for (let i = 1; i <= 10; i++) { const t = i / 10; const gm = rad(bell ? lerp(70, 40, t) : lerp(-5, -25, t)); q = add(q, P(sd * Math.cos(gm) * Sc * 0.022, -Math.sin(gm) * Sc * 0.022)); sl.push(q); }
    const srb = ribbon(sl, (t) => lerp(3.5, 0.6, t));
    const si = mkItem(39.5, 6, 0.05, { origin: sl[0] });
    si.occ = [srb.poly];
    si.washes.push({ poly: srb.poly, color: pal.leaf, alpha: 0.7, hard: true });
    pushS(si.lines, mkStroke(srb.poly.concat([srb.poly[0]]), { w: 0.6, taper: 0 }));
    E.items.push(si);
  }
  // the far half of the corolla, seen from inside
  const L = backFill[0], Rt = backFill[1];
  const rimN = 3;
  const rim = [];
  const a0 = L[L.length - 1], a1 = Rt[Rt.length - 1];
  for (let i = 0; i <= rimN * 8; i++) {
    const t = i / (rimN * 8);
    const lobe = Math.abs(Math.sin(Math.PI * t * rimN));
    rim.push(add(lerpP(a0, a1, t), P(0, -lobe * Sc * 0.07 - Math.sin(Math.PI * t) * Sc * 0.05)));
  }
  const back = L.concat(rim.slice(1, -1)).concat(Rt.slice().reverse());
  const bi = mkItem(38, 6, -0.1, { origin: rec });
  bi.washes.push({ poly: back, color: pal.inner, alpha: 0.6, shade: { from: rec, to: lerpP(a0, a1, 0.5), color: pal.flower } });
  pushS(bi.lines, mkStroke(rim, { w: 0.7, taper: 0.03 }));
  for (let k = 1; k < 7; k++) {
    const tgt = rim[Math.round((k / 7) * (rim.length - 1))];
    pushS(bi.hatch, mkStroke(spline([rec, lerpP(rec, tgt, 0.5), lerpP(rec, tgt, 0.92)], 5), { w: 0.33, taper: 0.1, taperEnd: 0.5 }));
  }
  E.items.push(bi);
  // the ovary, cut open, with its ovules
  const oc = add(rec, P(0, -Sc * 0.1));
  const oh = Sc * 0.1;
  const ovary = ellipsePts(oc, ow, oh, 0, 36).slice(0, -1);
  const cav = ellipsePts(oc, ow * 0.62, oh * 0.66, 0, 30).slice(0, -1);
  const oi = mkItem(42, 6, 0.2, { origin: oc });
  oi.occ = [ovary];
  oi.washes.push({ poly: ovary, color: lighten(pal.leaf, 0.35), alpha: 0.65, holes: [cav] });
  pushS(oi.lines, mkStroke(ovary.concat([ovary[0]]), { w: 0.9, taper: 0 }));
  pushS(oi.lines, mkStroke(cav.concat([cav[0]]), { w: 0.6, taper: 0 }));
  for (const [a, b] of hatchPoly(ovary, -0.8, 1.9, 0.2)) for (const [p, q] of clipSegOut(a, b, cav)) pushS(oi.hatch, mkHatch(p, q, 0.28));
  for (const sd of [-1, 1]) {
    for (let k = 0; k < 4; k++) {
      const q = add(oc, P(sd * ow * 0.28, lerp(-oh * 0.45, oh * 0.45, (k + 0.5) / 4)));
      const ov = ellipsePts(q, ow * 0.17, oh * 0.1, 0, 12);
      oi.washes.push({ poly: ov, color: C(50, 30, 88), alpha: 0.6, hard: true });
      pushS(oi.lines, mkStroke(ov, { w: 0.5, taper: 0 }));
      pushS(oi.hatch, mkHatch(add(q, P(-sd * ow * 0.17, 0)), add(oc, P(0, q.y - oc.y)), 0.4));
    }
  }
  pushS(oi.lines, mkStroke([add(oc, P(0, -oh * 0.66)), add(oc, P(0, oh * 0.66))], { w: 0.5, taper: 0 }));
  E.items.push(oi);
  // style, stigma, stamens
  const si = mkItem(43, 6, 0.3, { origin: oc });
  const top = add(oc, P(0, -oh));
  const sh = Sc * (['campanulate', 'tubular', 'lantern'].includes(form) ? 0.42 : 0.28);
  const styl = [top, add(top, P(Sc * 0.01, -sh * 0.5)), add(top, P(0, -sh))];
  pushS(si.lines, mkStroke(styl, { w: 1.4, taper: 0, taperEnd: 0.2 }));
  for (let k = 0; k < 3; k++) pushS(si.lines, mkStroke([styl[2], add(styl[2], dirOf(UP + (k - 1) * 0.7, Sc * 0.035))], { w: 1, taper: 0, taperEnd: 0.5 }));
  for (const sd of [-1, 1]) {
    for (const k of [0.55, 0.85]) {
      const b0 = add(rec, P(sd * ow * k, -Sc * 0.02));
      const tip = add(b0, P(sd * Sc * 0.04 * k, -sh * (0.62 + 0.25 * k)));
      pushS(si.lines, mkStroke(spline([b0, add(lerpP(b0, tip, 0.5), P(sd * Sc * 0.02, 0)), tip], 5), { w: 0.55, taper: 0 }));
      const an = ellipsePts(add(tip, P(0, -Sc * 0.025)), Sc * 0.018, Sc * 0.034, sd * 0.2, 12);
      si.washes.push({ poly: an, color: pal.accent, alpha: 0.85, hard: true });
      pushS(si.lines, mkStroke(an, { w: 0.5, taper: 0 }));
    }
  }
  E.items.push(si);
  // receptacle and pedicel, cut
  const pd = [add(rec, P(-Sc * 0.03, Sc * 0.01)), add(rec, P(Sc * 0.03, Sc * 0.01)), add(rec, P(Sc * 0.022, Sc * 0.28)), add(rec, P(-Sc * 0.022, Sc * 0.28))];
  const ri = mkItem(37, 6, -0.2, { origin: rec });
  ri.occ = [pd];
  ri.washes.push({ poly: pd, color: lighten(pal.stem, 0.3), alpha: 0.6, hard: true });
  pushS(ri.lines, mkStroke([pd[0], pd[3]], { w: 0.7, taper: 0 }));
  pushS(ri.lines, mkStroke([pd[1], pd[2]], { w: 0.9, taper: 0 }));
  pushS(ri.lines, mkStroke([pd[3], pd[2]], { w: 0.6, taper: 0 }));
  for (const k of [-0.4, 0.4]) pushS(ri.hatch, mkStroke([add(rec, P(Sc * 0.03 * k, 0)), add(rec, P(Sc * 0.022 * k, Sc * 0.27))], { w: 0.35, taper: 0 }));
  E.items.push(ri);
}

// Parts of segment ab outside polygon.
function clipSegOut(a, b, poly) {
  const ins = clipSeg(a, b, poly);
  if (!ins.length) return [[a, b]];
  const out = [];
  let cur = a;
  const L = dist(a, b) || 1;
  ins.sort((m, n) => dist(a, m[0]) - dist(a, n[0]));
  for (const [p, q] of ins) { if (dist(cur, p) > 0.5) out.push([cur, p]); cur = q; }
  if (dist(cur, b) > 0.5 && dist(a, cur) < L) out.push([cur, b]);
  return out;
}

function engraveFruitSectionFig(E, c, Sc) {
  const r = E.r, pal = E.pal, g = E.g;
  const f = g.fruit.form;
  const Rf = Sc * 0.44;
  const it = mkItem(40, 6, 0, { origin: c });
  const outer = E.marvel === 'clockwork' ? gearPoly(c, Rf, 18, 0.1) : E.marvel === 'crystal' ? crystalPoly(c, Rf, Rf, 0, r) : ellipsePts(c, Rf, Rf * 0.97, 0.2, 48).slice(0, -1);
  const innerR = Rf * (f === 'bladder' ? 0.93 : f === 'drupe' ? 0.9 : 0.82);
  const inner = ellipsePts(c, innerR, innerR * 0.97, 0.2, 40).slice(0, -1);
  it.occ = [outer];
  it.washes.push({ poly: outer, color: pal.fruit, alpha: 0.75, holes: [inner] });
  it.washes.push({ poly: inner, color: lighten(pal.fruit, f === 'bladder' ? 0.85 : 0.6), alpha: f === 'bladder' ? 0.2 : 0.55 });
  pushS(it.lines, mkStroke(outer.concat([outer[0]]), { w: 1.0, center: c, shade: 0.8, taper: 0, step: 1.5 }));
  pushS(it.lines, mkStroke(inner.concat([inner[0]]), { w: 0.6, taper: 0, step: 1.5 }));
  for (const [a, b] of hatchPoly(outer, 0.75, 1.9, 0.2)) for (const [p, q] of clipSegOut(a, b, inner)) pushS(it.hatch, mkHatch(p, q, 0.3));
  E.items.push(it);
  const si = mkItem(41, 6, 0.1, { origin: c });
  if (f === 'drupe') {
    const st = ellipsePts(c, Rf * 0.42, Rf * 0.36, 0.4, 32).slice(0, -1);
    si.occ = [st];
    si.washes.push({ poly: st, color: C(30, 30, 50), alpha: 0.7 });
    pushS(si.lines, mkStroke(st.concat([st[0]]), { w: 0.9, center: c, shade: 0.8, taper: 0 }));
    const d = [];
    for (let k = 0; k < 220; k++) { const a = r.float(0, TAU), rr = Math.sqrt(r.next()); const q = add(c, rot2(P(Math.cos(a) * rr * Rf * 0.4, Math.sin(a) * rr * Rf * 0.34), 0.4)); d.push({ x: q.x, y: q.y, r: r.float(0.3, 0.7) }); }
    si.dots.push({ pts: d });
    const kern = ellipsePts(c, Rf * 0.22, Rf * 0.16, 0.4, 20).slice(0, -1);
    si.washes.push({ poly: kern, color: C(40, 40, 80), alpha: 0.7, hard: true });
    pushS(si.lines, mkStroke(kern.concat([kern[0]]), { w: 0.6, taper: 0 }));
  } else {
    const k = clamp(g.flower.merosity > 6 ? 5 : g.flower.merosity, 2, 6);
    const scol = mixColor(pal.fruit, C(30, 40, 25), 0.6);
    for (let i = 0; i < k; i++) {
      const a = (i / k) * TAU + 0.2;
      pushS(si.lines, mkStroke([add(c, dirOf(a, Rf * 0.1)), add(c, dirOf(a, innerR * 0.98))], { w: 0.6, taper: 0 }));
      const ns = f === 'berry' ? 2 : r.int(1, 3);
      for (let j = 0; j < ns; j++) {
        const am = a + Math.PI / k + (j - (ns - 1) / 2) * (0.55 / k) * 2;
        const q = add(c, dirOf(am, innerR * lerp(0.42, 0.62, j % 2)));
        const sp = seedShape(q, Rf * 0.1, Rf * 0.065, am, f === 'pod');
        si.washes.push({ poly: sp, color: scol, alpha: 0.8, hard: true });
        pushS(si.lines, mkStroke(sp.concat([sp[0]]), { w: 0.55, taper: 0 }));
        pushS(si.hatch, mkHatch(add(c, dirOf(am, Rf * 0.12)), add(q, dirOf(am, -Rf * 0.09)), 0.35));
        si.fills.push({ poly: ellipsePts(add(q, dirOf(am + 2.4, Rf * 0.03)), Rf * 0.025, Rf * 0.015, am, 8), color: 'rgba(255,252,240,0.8)' });
      }
    }
    const pc = ellipsePts(c, Rf * 0.1, Rf * 0.1, 0, 16);
    si.washes.push({ poly: pc, color: lighten(pal.fruit, 0.3), alpha: 0.6, hard: true });
    pushS(si.lines, mkStroke(pc, { w: 0.6, taper: 0 }));
  }
  E.items.push(si);
}

// ================================================================== composition

function makePal(g) {
  const c = g.colors || {};
  const def = (k, h, s, l) => (c[k] && ok(c[k].h) ? c[k] : C(h, s, l));
  const leaf = aged(def('leaf', 110, 40, 38));
  return {
    leaf, leafShade: aged(def('leafShade', 115, 45, 26)), flower: aged(def('flower', 330, 55, 60)), inner: aged(def('flowerInner', 330, 60, 40)),
    accent: aged(def('accent', 50, 80, 56)), fruit: aged(def('fruit', 355, 65, 45)), stem: aged(def('stem', 100, 35, 38)), root: aged(def('root', 35, 25, 68)),
    under: lighten(desat(leaf, 0.4), 0.38), wood: mixColor(aged(def('stem', 100, 35, 38)), C(28, 30, 34), 0.65),
  };
}

// Engrave the plant itself (and its ground, water, bark or rock) for layout L.
function engravePlant(g, S, L, pal, r) {
  const E = { g, r: r.fork('engrave'), pal, items: [], marvel: g.marvel, s: L.s };
  const T = L.T, s = L.s, flip = L.flip;
  const fa = (a) => (flip < 0 ? -a : a);
  const flowerPoints = [];
  if (L.inverted) engraveLedge(E, L);
  if (S.extras.bark && g.presentation === 'whole') engraveBark(E, L, S);
  const crownStart = E.items.length;

  for (const st of S.stems) {
    engraveStem(E, { ...st, pts: st.pts.map(T), w0: Math.max(0.9, st.w0 * s), w1: Math.max(0.8, st.w1 * s) }, 2);
  }
  if (S.pseudobulb) {
    const pb = S.pseudobulb, b = T(pb.at);
    const h = pb.h * s, w = pb.w * s;
    const poly = [];
    for (let i = 0; i <= 30; i++) { const a = (i / 30) * TAU; const t = (1 - Math.cos(a)) / 2; poly.push(add(b, P(Math.sin(a) * w * Math.pow(Math.sin(Math.PI * clamp(t, 0.03, 0.97)), 0.7), -t * h * flip))); }
    const it = mkItem(13, 2, -1, { origin: b });
    it.occ = [poly];
    pushS(it.lines, mkStroke(poly, { w: 0.9, center: centroid(poly), shade: 0.8, taper: 0 }));
    roundBody(E, it, poly, centroid(poly), w, pal.stem, { dense: 0.5 });
    for (const v of [-0.5, 0, 0.5]) { const pts = []; for (let i = 1; i < 10; i++) { const t = i / 10; pts.push(add(b, P(v * w * Math.pow(Math.sin(Math.PI * t), 0.7), -t * h * flip))); } pushS(it.hatch, mkStroke(pts, { w: 0.35, taper: 0.2 })); }
    E.items.push(it);
  }
  for (const lf of S.leaves) {
    engraveLeaf(E, { ...lf, at: T(lf.at), ang: fa(lf.ang), L: lf.L * s, W: lf.W * s, pet: lf.pet * s });
  }
  for (const b of S.bracts) {
    const n = b.n;
    for (let i = 0; i < n; i++) {
      const a = fa(b.ang) + Math.PI + (n === 1 ? (E.r.chance(0.5) ? 0.5 : -0.5) : lerp(-1.2, 1.2, i / Math.max(1, n - 1)));
      const ang = b.single ? fa(b.ang) + (E.r.chance(0.5) ? 0.35 : -0.35) : a;
      engraveBlade(E, { at: T(b.at), ang, L: b.L * s, W: b.L * s * 0.22, pet: 0, shape: 'lanceolate', droop: 0.3, f0: 0.8, twist: 0, z: 32, curl: 0.2, petBend: 0 }, { base: T(b.at), key: -T(b.at).y * 0.001 + 0.4 });
    }
  }
  for (const t of S.tendrils) engraveTendril(E, { ...t, at: T(t.at), ang: fa(t.ang), L: t.L * s, side: t.side * flip });
  S.flowers.forEach((f, i) => {
    const c = T(f.at);
    const ax = flip < 0 ? V3(f.axis.x, -f.axis.y, f.axis.z) : f.axis;
    const R = f.R * s;
    if (f.stage === 'bud') engraveBud(E, { c, dir: fa(f.dir), R, z: 40, rank: i });
    else {
      engraveFlower(E, { c, axis: ax, R, z: 40, rank: i });
      const vc = add(c, mul(P(ax.x, ax.y), R * 0.35));
      flowerPoints.push({ x: Math.round(vc.x * 10) / 10, y: Math.round(vc.y * 10) / 10, r: Math.round(R * 10) / 10 });
    }
  });
  for (const fr of S.fruits) engraveFruit(E, { ...fr, at: T(fr.at), ang: fa(fr.ang), R: fr.R * s });
  const crownEnd = E.items.length;

  // below the plant
  const B = T(P(0, 0));
  const whole = g.presentation === 'whole';
  if (S.extras.water) {
    const wy = T(P(0, S.extras.water.y)).y;
    let x0 = Infinity, x1 = -Infinity;
    const crossings = [];
    for (const lf of S.leaves) { const p = T(lf.at); x0 = Math.min(x0, p.x - lf.L * s * 0.6); x1 = Math.max(x1, p.x + lf.L * s * 0.6); }
    for (const st of S.stems) {
      const pts = st.pts.map(T);
      for (const p of pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); }
      for (let i = 1; i < pts.length; i++) if ((pts[i - 1].y - wy) * (pts[i].y - wy) < 0 && st.kind !== 'petiole') crossings.push(lerp(pts[i - 1].x, pts[i].x, (wy - pts[i - 1].y) / (pts[i].y - pts[i - 1].y)));
    }
    engraveWater(E, wy, x0 - 90, x1 + 90, crossings);
  }
  if (L.mirrored) {
    const G = B.y + 3;
    engraveGround(E, B, 300, g.marvel === 'tidal' ? 'waves' : 'plain');
    const FADED = 'rgb(150,136,116)';
    const recol = (c) => (!c || c === INK || /^rgba?\(42,\s*33/.test(c) ? FADED : c);
    const twins = [];
    for (let i = crownStart; i < crownEnd; i++) {
      const it = E.items[i];
      const m2 = mapItem(it, (p) => P(p.x, 2 * G - p.y), { alpha: 0.42, color: recol });
      m2.phase = 5.5; m2.key = -it.key;
      for (const st of m2.lines.concat(m2.hatch)) if (!st.color) st.color = FADED;
      for (const d of m2.dots) if (!d.color) d.color = FADED;
      for (const f of m2.fills) if (!f.color || f.color === INK) f.color = FADED;
      twins.push(m2);
    }
    E.items.push(...twins);
  } else if (whole && g.marvel !== 'migratory') {
    engraveRoots(E, S, L);
    if (!L.inverted && g.habit !== 'epiphyte' && g.habit !== 'aquatic') {
      if (g.marvel === 'tidal') engraveGround(E, B, 140 + 40 * s, 'waves');
      else if (E.r.chance(0.4)) engraveGround(E, B, 70 + 50 * s, 'plain');
    }
  } else if (whole && g.marvel === 'migratory') {
    engraveRoots(E, S, L);
  } else if (g.marvel === 'tidal') {
    engraveGround(E, add(B, P(0, 16)), 90, 'waves');
  }
  if (g.habit === 'aquatic' && whole) {
    // a little mud about the rhizome
    const it = mkItem(2, 0, 0, { origin: B });
    const d = [];
    for (let k = 0; k < 140; k++) d.push({ x: clamp(B.x + E.r.gauss(0, 70 * s + 20), AREA.x0, AREA.x1), y: Math.min(AREA.y1 + 20, B.y + 20 * s + Math.abs(E.r.gauss(0, 18 * s + 5))), r: E.r.float(0.3, 0.7) });
    it.dots.push({ pts: d });
    E.items.push(it);
  }

  return { items: E.items, flowerPoints, crownStart, crownEnd, B };
}

// Scale a layout about a fixed plate point, or shift it.
function rescaleLayout(L, k, A) {
  const N = { ...L, s: L.s * k, ox: A.x - (A.x - L.ox) * k, oy: A.y - (A.y - L.oy) * k };
  N.T = (p) => P(N.ox + p.x * N.s, N.oy + p.y * N.flip * N.s);
  return N;
}
function shiftLayout(L, dx, dy) {
  const N = { ...L, ox: L.ox + dx, oy: L.oy + dy };
  N.T = (p) => P(N.ox + p.x * N.s, N.oy + p.y * N.flip * N.s);
  return N;
}

// Where the engraving actually put ink and colour, on a 10px grid, dilated for clearance.
function occupancy(items, L) {
  const CELL = 10, GW = Math.ceil(LW / CELL), GH = Math.ceil(LH / CELL);
  const raw = new Uint8Array(GW * GH);
  const markP = (x, y) => { const gx = Math.floor(x / CELL), gy = Math.floor(y / CELL); if (gx >= 0 && gy >= 0 && gx < GW && gy < GH) raw[gy * GW + gx] = 1; };
  const fillPoly = (poly) => {
    const bb = bboxOf(poly);
    if (bb.x1 - bb.x0 < 24 && bb.y1 - bb.y0 < 24) { for (const p of poly) markP(p.x, p.y); return; }
    for (const p of poly) markP(p.x, p.y);
    for (let gy = Math.max(0, Math.floor(bb.y0 / CELL)); gy <= Math.min(GH - 1, Math.floor(bb.y1 / CELL)); gy++)
      for (let gx = Math.max(0, Math.floor(bb.x0 / CELL)); gx <= Math.min(GW - 1, Math.floor(bb.x1 / CELL)); gx++)
        if (!raw[gy * GW + gx] && inPoly(P((gx + 0.5) * CELL, (gy + 0.5) * CELL), poly)) raw[gy * GW + gx] = 1;
  };
  for (const it of items) {
    for (const st of it.lines) for (const p of st.pts) markP(p.x, p.y);
    for (const st of it.hatch) for (let i = 0; i < st.pts.length; i += 2) markP(st.pts[i].x, st.pts[i].y);
    for (const d of it.dots) for (const p of d.pts) markP(p.x, p.y);
    if (it.occ) for (const poly of it.occ) fillPoly(poly);
    for (const w of it.washes) if (!w.glow && !it.occ) for (const poly of (w.polys || [w.poly])) if (poly) fillPoly(poly);
  }
  // dilate by two cells
  const occ = new Uint8Array(GW * GH);
  const R = 2;
  for (let gy = 0; gy < GH; gy++) for (let gx = 0; gx < GW; gx++) {
    if (!raw[gy * GW + gx]) continue;
    for (let y = Math.max(0, gy - R); y <= Math.min(GH - 1, gy + R); y++) for (let x = Math.max(0, gx - R); x <= Math.min(GW - 1, gx + R); x++) occ[y * GW + x] = 1;
  }
  if (L.inverted) for (let gx = 0; gx < GW; gx++) for (let gy = 0; gy < Math.ceil((AREA.y0 + 60) / CELL); gy++) occ[gy * GW + gx] = 1;
  return { occ, GW, GH };
}

function composePlate(g, rng, caption) {
  const r = rng.fork('plant');
  const pal = makePal(g);
  let S = growStructure(g, r.fork('structure'));
  let L = layoutPlate(g, S, r.fork('layout'));
  // flowers must stay legible on the plate: grow them larger if the plant had to be shrunk a lot
  const openR = S.flowers.filter((f) => f.stage === 'open').map((f) => f.R).sort((a, b) => a - b);
  const medR = openR.length ? openR[Math.floor(openR.length / 2)] : 0;
  const VIS = { rotate: 1, stellate: 1, campanulate: 0.85, tubular: 0.72, cup: 0.78, lantern: 0.78, labiate: 0.85, globose: 0.88, spiral: 0.9 }[g.flower.form] || 1;
  const WANT = (g.flower.inflorescence === 'solitary' ? 38 : 25) / VIS;
  let boost = 1;
  for (let it = 0; it < 3 && medR && medR * boost * L.s < WANT * 0.97; it++) {
    boost = clamp(boost * (WANT / (medR * boost * L.s)), 1, 3);
    S = growStructure(g, r.fork('structure'), boost);
    L = layoutPlate(g, S, r.fork('layout'));
  }
  // Engrave the plant, then check what was actually drawn: correct the fit if anything
  // strays outside the drawing area, and place the figures against the real drawing.
  let P1 = engravePlant(g, S, L, pal, r);
  const fitBB = (items) => itemsBBox(items.filter((it) => !it.washes.some((w) => w.glow)));
  for (let pass = 0; pass < 3; pass++) {
    const bb = fitBB(P1.items);
    if (!bb) break;
    const over = Math.max(AREA.x0 - bb.x0, bb.x1 - AREA.x1, AREA.y0 - bb.y0, bb.y1 - (AREA.y1 + 8));
    if (over <= 3) break;
    const k = Math.min(1, ((AREA.x1 - AREA.x0) - 8) / (bb.x1 - bb.x0), ((AREA.y1 + 8 - AREA.y0) - 8) / (bb.y1 - bb.y0)) * 0.985;
    const B0 = L.T(P(0, 0));
    L = rescaleLayout(L, k, B0);
    const nb = { x0: B0.x + (bb.x0 - B0.x) * k, x1: B0.x + (bb.x1 - B0.x) * k, y0: B0.y + (bb.y0 - B0.y) * k, y1: B0.y + (bb.y1 - B0.y) * k };
    const dx = nb.x0 < AREA.x0 + 2 ? AREA.x0 + 2 - nb.x0 : nb.x1 > AREA.x1 - 2 ? AREA.x1 - 2 - nb.x1 : 0;
    const dy = nb.y0 < AREA.y0 + 2 ? AREA.y0 + 2 - nb.y0 : nb.y1 > AREA.y1 + 6 ? AREA.y1 + 6 - nb.y1 : 0;
    L = shiftLayout(L, dx, dy);
    P1 = engravePlant(g, S, L, pal, r);
  }
  const figs = g.figures || [];
  const SMAXF = { leaf: 300, root: 290, 'flower-front': 265, 'flower-section': 275, fruit: 235, 'fruit-section': 225, stamen: 235, seed: 205, bud: 205 };
  let grid = occupancy(P1.items, L);
  let occ = grid.occ.slice();
  let boxes = placeFigures(occ, grid.GW, grid.GH, 10, figs, SMAXF, 112, r.fork('figs'));
  for (let pass = 0; pass < 3 && boxes.some((b) => !b); pass++) {
    const bb = fitBB(P1.items) || AREA;
    const anchor = L.inverted ? P((bb.x0 + bb.x1) / 2, bb.y0) : g.presentation === 'whole' ? P((bb.x0 + bb.x1) / 2, bb.y1) : P((bb.x0 + bb.x1) / 2, (bb.y0 + bb.y1) / 2);
    L = rescaleLayout(L, 0.88, anchor);
    // and move away from the side with more room for the figures
    const cx = (bb.x0 + bb.x1) / 2;
    L = shiftLayout(L, cx < LW / 2 ? -Math.min(40, (bb.x0 - AREA.x0) * 0.5) : Math.min(40, (AREA.x1 - bb.x1) * 0.5), 0);
    P1 = engravePlant(g, S, L, pal, r);
    grid = occupancy(P1.items, L);
    occ = grid.occ.slice();
    boxes = placeFigures(occ, grid.GW, grid.GH, 10, figs, SMAXF, 112, r.fork('figs' + pass));
  }
  L.boxes = boxes;
  L.occ = occ;
  const E = { g, r: r.fork('figures'), pal, items: P1.items, marvel: g.marvel, s: L.s };
  const { flowerPoints, crownStart, crownEnd, B } = P1;
  const texts = [];

  // figures
  const labels = (caption.figures && caption.figures.length) ? caption.figures.map(String) : null;
  const figLabel = (i) => {
    if (!labels) return String(i + 2);
    if (labels.length >= figs.length + 1) return labels[i + 1];
    return labels[i] != null ? labels[i] : String(i + 2);
  };
  const mainLabel = labels && labels.length >= figs.length + 1 ? labels[0] : '1';
  figs.forEach((fg, i) => {
    const box = L.boxes[i];
    if (!box) return;
    try {
      const res = engraveFigure(E, fg, box, i, {});
      if (res && res.items) {
        E.items.push(...res.items);
        const bb = res.bb;
        texts.push({ runs: [{ str: figLabel(i), italic: true }], x: clamp((bb.x0 + bb.x1) / 2, box.x + 12, box.x + box.S - 12), y: Math.min(box.y + box.S - 2, bb.y1 + 22), size: 21, align: 'center', fig: true });
      }
    } catch (e) { console.error('plate: figure failed', fg.kind, e); }
  });
  // "1" near the foot of the main plant
  {
    const occ = L.occ, GW = Math.ceil(LW / 10);
    const crownItems = E.items.slice(crownStart, crownEnd);
    const cb = itemsBBox(crownItems) || { x0: B.x, x1: B.x, y0: B.y, y1: B.y };
    let pos = null;
    const target = L.inverted ? P(B.x, cb.y1) : P(B.x, Math.min(B.y, cb.y1));
    for (let rr = 30; rr < 260 && !pos; rr += 12) {
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * TAU + 0.2;
        const q = add(target, P(Math.cos(a) * rr, Math.sin(a) * rr * 0.6));
        if (q.x < AREA.x0 + 10 || q.x > AREA.x1 - 10 || q.y < AREA.y0 + 20 || q.y > AREA.y1 + 10) continue;
        const gx = Math.floor(q.x / 10), gy = Math.floor((q.y - 8) / 10);
        if (!occ[gy * GW + gx] && !occ[(gy - 1) * GW + gx] && !occ[gy * GW + gx + 1] && !occ[gy * GW + gx - 1]) { pos = q; break; }
      }
    }
    if (!pos) pos = P(clamp(B.x + 60, AREA.x0 + 20, AREA.x1 - 20), clamp(B.y + 20, AREA.y0 + 30, AREA.y1));
    texts.push({ runs: [{ str: mainLabel, italic: true }], x: pos.x, y: pos.y, size: 22, align: 'center', fig: true });
  }

  // lettering
  const label = caption.label != null ? String(caption.label) : (g.label || '');
  if (label) texts.push({ runs: [{ str: label }], x: PLATE.x1 - 26, y: PLATE.y0 + 40, size: 24, align: 'right' });
  if (caption.del) texts.push({ runs: [{ str: String(caption.del), italic: true }], x: PLATE.x0 + 22, y: PLATE.y1 - 13, size: 13, align: 'left' });
  if (caption.sculp) texts.push({ runs: [{ str: String(caption.sculp), italic: true }], x: PLATE.x1 - 22, y: PLATE.y1 - 13, size: 13, align: 'right' });
  if (caption.latin || caption.author) {
    const runs = [];
    if (caption.latin) runs.push({ str: String(caption.latin), italic: true });
    if (caption.author) runs.push({ str: (caption.latin ? '  ' : '') + String(caption.author), italic: false, size: 27 });
    texts.push({ runs, x: LW / 2, y: PLATE.y1 + 58, size: 33, align: 'center', maxW: 860 });
  }

  // sanity: drop anything with broken geometry
  const items = E.items.filter((it) => {
    it.lines = it.lines.filter((st) => st && st.pts.every(fin) && ok(st.len));
    it.hatch = it.hatch.filter((st) => st && st.pts.every(fin) && ok(st.len));
    it.washes = it.washes.filter((w) => (w.polys || [w.poly]).every((p) => p && p.every(fin)));
    it.dots = it.dots.filter((d) => d.pts.length && d.pts.every(fin));
    it.fills = it.fills.filter((f) => f.poly && f.poly.length > 2 && f.poly.every(fin));
    if (it.occ) it.occ = it.occ.filter((p) => p && p.length > 2 && p.every(fin));
    if (it.occ && !it.occ.length) it.occ = null;
    if (!ok(it.z)) it.z = 0;
    return it.lines.length || it.hatch.length || it.washes.length || it.dots.length || it.fills.length;
  });
  return { items, texts, flowerPoints, layout: L };
}
