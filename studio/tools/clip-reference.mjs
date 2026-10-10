// Engine-free reference for the Canvas 2D clip transitions of the render spec (studio/spec,
// README section T6). Written from the spec pages alone: the scan conversion of T6 and the
// layers of each transition page. render-goldens.test.mjs runs it against the committed
// goldens, so the prose is shown to be enough: every straight-edged clip reproduces the
// engine's pixels exactly, and the three curved outlines (ovalIris, eyeIris, heartShape)
// stay inside their cases' tolerances when the true curve is used.

const f32 = Math.fround;
// T6 step 2: a coordinate becomes a whole number of 1/64 pixel, rounded towards zero.
const snap = (v) => Math.trunc(f32(f32(v) * 64));

// T6 step 1: cut a segment to the frame. Parts above or below the frame are dropped; parts
// left or right of it are replaced by vertical segments on the frame's left or right edge.
function cutToFrame(p0, p1, W, H) {
  let [x0, y0] = p0;
  let [x1, y1] = p1;
  const flipped = y0 > y1;
  if (flipped) [x0, y0, x1, y1] = [x1, y1, x0, y0];
  if (y1 <= 0 || y0 >= H) return [];
  const xAt = (y) => f32(x0 + ((y - y0) * (x1 - x0)) / (y1 - y0));
  let top = [x0, y0];
  let bottom = [x1, y1];
  if (y0 < 0) top = [xAt(0), 0];
  if (y1 > H) bottom = [xAt(H), H];
  let [l, r] = top[0] <= bottom[0] ? [top, bottom] : [bottom, top];
  const yAt = (x) => f32(l[1] + ((x - l[0]) * (r[1] - l[1])) / (r[0] - l[0]));
  const pieces = [];
  if (r[0] <= 0) pieces.push([[0, l[1]], [0, r[1]]]);
  else if (l[0] >= W) pieces.push([[W, l[1]], [W, r[1]]]);
  else {
    if (l[0] < 0) { const y = yAt(0); pieces.push([[0, l[1]], [0, y]]); l = [0, y]; }
    let tail = null;
    if (r[0] > W) { const y = yAt(W); tail = [[W, y], [W, r[1]]]; r = [W, y]; }
    pieces.push([l, r]);
    if (tail) pieces.push(tail);
  }
  // Each piece keeps the direction of the segment it came from (the winding rule needs it).
  return pieces.map(([a, b]) => ((a[1] <= b[1]) !== flipped ? [a, b] : [b, a]));
}

/**
 * T6: which pixel centres of a W x H frame a closed path covers.
 * `path` is a list of sub-paths, each a list of [x, y] vertices, closed implicitly.
 * Returns a Uint8Array of W*H flags, row-major.
 */
export function scanConvert(path, rule, W, H) {
  const edges = [];
  for (const sub of path) {
    for (let k = 0; k < sub.length; k++) {
      for (const [a, b] of cutToFrame(sub[k], sub[(k + 1) % sub.length], W, H)) {
        let x0 = snap(a[0]);
        let y0 = snap(a[1]);
        let x1 = snap(b[0]);
        let y1 = snap(b[1]);
        let winding = 1;
        if (y0 > y1) { [x0, y0, x1, y1] = [x1, y1, x0, y0]; winding = -1; }
        // T6 step 3: the rows an edge covers.
        const first = (y0 + 32) >> 6;
        const end = (y1 + 32) >> 6;
        if (first === end) continue;
        // T6 step 4: slope and first-row x in 16.16 fixed point, both rounded towards zero / down.
        const slope = Math.trunc(((x1 - x0) * 65536) / (y1 - y0));
        const toCentre = first * 64 + 32 - y0;
        const x = (x0 + Number((BigInt(slope) * BigInt(toCentre)) >> 16n)) * 1024;
        edges.push({ first, end, x, slope, winding });
      }
    }
  }
  const mask = new Uint8Array(W * H);
  for (let j = 0; j < H; j++) {
    const crossings = edges.filter((e) => e.first <= j && j < e.end)
      .map((e) => ({ x: e.x + e.slope * (j - e.first), winding: e.winding }))
      .sort((p, q) => p.x - q.x);
    let winding = 0;
    for (let k = 0; k + 1 < crossings.length; k++) {
      winding += crossings[k].winding;
      if (rule === 'evenodd' ? !(winding & 1) : winding === 0) continue;
      // T6 step 5: the span between two crossings.
      const from = Math.max(0, (crossings[k].x + 32768) >> 16);
      const to = Math.min(W, (crossings[k + 1].x + 32768) >> 16);
      for (let i = from; i < to; i++) mask[j * W + i] = 1;
    }
  }
  return mask;
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const CURVE_CHORDS = 256;
function cubicPoints(p0, p1, p2, p3) {
  const out = [];
  for (let k = 1; k <= CURVE_CHORDS; k++) {
    const t = k / CURVE_CHORDS;
    const u = 1 - t;
    out.push([0, 1].map((c) => u * u * u * p0[c] + 3 * u * u * t * p1[c] + 3 * u * t * t * p2[c] + t * t * t * p3[c]));
  }
  return out;
}
const regular = (sides, rotation) => Array.from({ length: sides }, (_, i) => {
  const angle = rotation + (i / sides) * Math.PI * 2;
  return [Math.cos(angle), Math.sin(angle)];
});
const UNIT = {
  arrowIris: [[0, -1], [0.68, 1], [0, 0.36], [-0.68, 1]],
  crossIris: [[-0.28, -1], [0.28, -1], [0.28, -0.28], [1, -0.28], [1, 0.28], [0.28, 0.28], [0.28, 1], [-0.28, 1], [-0.28, 0.28], [-1, 0.28], [-1, -0.28], [-0.28, -0.28]],
  diamondIris: regular(4, -Math.PI / 2),
  hexagonIris: regular(6, 0),
  pentagonIris: regular(5, -Math.PI / 2),
  squareIris: [[-1, -1], [1, -1], [1, 1], [-1, 1]],
  triangleIris: regular(3, -Math.PI / 2),
  boxShape: [[-1, -0.62], [1, -0.62], [1, 0.62], [-1, 0.62]],
  starShape: Array.from({ length: 10 }, (_, i) => {
    const angle = -Math.PI / 2 + (i / 10) * Math.PI * 2;
    const radius = i % 2 === 0 ? 1 : 0.42;
    return [Math.cos(angle) * radius, Math.sin(angle) * radius];
  }),
};
export const CURVED_CLIPS = ['ovalIris', 'eyeIris', 'heartShape'];
export const IRIS_CLIPS = ['arrowIris', 'crossIris', 'diamondIris', 'eyeIris', 'hexagonIris', 'ovalIris', 'pentagonIris', 'squareIris', 'triangleIris'];
export const SHAPE_CLIPS = ['boxShape', 'heartShape', 'starShape', 'triangleLeftShape', 'triangleRightShape'];
export const MASK_CLIPS = ['barnDoor', 'split', 'bandWipe', 'centerWipe', 'edgeWipe', 'radialWipe', 'venetianBlindWipe'];
export const CLIP_TRANSITIONS = [...IRIS_CLIPS, ...SHAPE_CLIPS, ...MASK_CLIPS];

const rectangle = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];

// The aperture (iris and shape pages): the outline of the hole, in pixels.
function aperture(id, p, W, H) {
  const cx = W / 2;
  const cy = H / 2;
  if (id === 'triangleLeftShape') return [[0, 0], [W * p * 2.24, 0], [0, H * p * 2.24]];
  if (id === 'triangleRightShape') return [[W, 0], [W - W * p * 2.24, 0], [W, H * p * 2.24]];
  const s = id === 'boxShape' ? p * Math.max(W / 2, H / (2 * 0.62)) * 1.12 : p * Math.max(W, H) * 1.45;
  const at = (u, v) => [cx + u * s, cy + v * s];
  if (id === 'ovalIris') {
    const rx = s * (W >= H ? 1.15 : 0.85);
    const ry = s * 0.72;
    return Array.from({ length: 4 * CURVE_CHORDS }, (_, i) => {
      const angle = (i / (4 * CURVE_CHORDS)) * Math.PI * 2;
      return [cx + rx * Math.cos(angle), cy + ry * Math.sin(angle)];
    });
  }
  if (id === 'eyeIris') {
    const rx = s * 1.02;
    const ry = s * 0.42;
    const left = [cx - rx, cy];
    const right = [cx + rx, cy];
    return [left, ...cubicPoints(left, [cx - rx * 0.5, cy - ry], [cx + rx * 0.5, cy - ry], right),
      ...cubicPoints(right, [cx + rx * 0.5, cy + ry], [cx - rx * 0.5, cy + ry], left).slice(0, -1)];
  }
  if (id === 'heartShape') {
    return [at(0, 0.78),
      ...cubicPoints(at(0, 0.78), at(-1.08, 0.12), at(-0.96, -0.78), at(-0.36, -0.78)),
      ...cubicPoints(at(-0.36, -0.78), at(-0.12, -0.78), at(0, -0.58), at(0, -0.42)),
      ...cubicPoints(at(0, -0.42), at(0, -0.58), at(0.12, -0.78), at(0.36, -0.78)),
      ...cubicPoints(at(0.36, -0.78), at(0.96, -0.78), at(1.08, 0.12), at(0, 0.78)).slice(0, -1)];
  }
  return UNIT[id].map(([u, v]) => at(u, v));
}

// The clip that keeps the outgoing picture (the wipe and motion pages), non-zero rule.
function outgoingMask(id, p, W, H, direction) {
  if (id === 'barnDoor') {
    const d = Math.max(0, (W / 2) * (1 - p));
    return [rectangle(0, 0, d, H), rectangle(W - d, 0, d, H)];
  }
  if (id === 'split') {
    const w = Math.max(0, (W / 2) * (1 - p));
    const h = Math.max(0, (H / 2) * (1 - p));
    return [rectangle(0, 0, w, h), rectangle(W - w, 0, w, h), rectangle(0, H - h, w, h), rectangle(W - w, H - h, w, h)];
  }
  if (id === 'bandWipe') {
    const band = H / 10;
    return Array.from({ length: 10 }, (_, i) => {
      const stagger = (i % 2) * 0.18;
      const reveal = W * clamp01((p - stagger) / Math.max(0.2, 1 - stagger));
      return i % 2 === 0 ? rectangle(reveal, i * band, W - reveal, band) : rectangle(0, i * band, W - reveal, band);
    });
  }
  if (id === 'venetianBlindWipe') {
    const slat = H / 10;
    return Array.from({ length: 10 }, (_, i) => rectangle(0, i * slat, W, slat * (1 - p)));
  }
  if (id === 'centerWipe') {
    const side = (W / 2) * (1 - p);
    return [rectangle(0, 0, side, H), rectangle(W - side, 0, side, H)];
  }
  if (id === 'edgeWipe') {
    if (direction === 'from-left') return [rectangle(W * p, 0, W * (1 - p), H)];
    if (direction === 'from-right') return [rectangle(0, 0, W * (1 - p), H)];
    if (direction === 'from-bottom') return [rectangle(0, 0, W, H * (1 - p))];
    return [rectangle(0, H * p, W, H * (1 - p))];
  }
  // radialWipe
  if (p <= 0) return [rectangle(0, 0, W, H)];
  if (p >= 1) return [];
  const cx = W / 2;
  const cy = H / 2;
  const R = Math.sqrt(W * W + H * H);
  return [0, 1, 2, 3].map((k) => {
    const start = -Math.PI / 2 + k * (Math.PI / 2) + p * (Math.PI / 2);
    const end = -Math.PI / 2 + (k + 1) * (Math.PI / 2);
    const arc = Array.from({ length: 65 }, (_, i) => {
      const angle = start + ((end - start) * i) / 64;
      return [cx + Math.cos(angle) * R, cy + Math.sin(angle) * R];
    });
    return [[cx, cy], ...arc];
  });
}

/** Where the outgoing picture A is drawn (1) and where only B shows (0). */
export function outgoingCoverage(id, progress, W, H, direction) {
  const p = clamp01(progress);
  if (MASK_CLIPS.includes(id)) return scanConvert(outgoingMask(id, p, W, H, direction), 'nonzero', W, H);
  return scanConvert([rectangle(0, 0, W, H), aperture(id, p, W, H)], 'evenodd', W, H);
}

/**
 * The whole frame of a clip transition from opaque or translucent 8-bit inputs
 * (straight RGBA, 0..1, row-major), as straight RGBA 0..1.
 */
export function renderClipTransition(c, a, b, W, H) {
  const p = clamp01(c.progress);
  const iris = IRIS_CLIPS.includes(c.id);
  let dim = c.properties?.outgoingDim;
  if (typeof dim !== 'number' || !Number.isFinite(dim)) dim = 0.06;
  dim = Math.max(0, Math.min(0.12, dim));
  const gB = iris ? 0.9 + 0.1 * p : 1;
  const gA = iris ? 1 - dim * p : 1;
  const keep = outgoingCoverage(c.id, p, W, H, c.direction ?? undefined);
  const out = new Array(W * H * 4);
  for (let k = 0; k < W * H; k++) {
    const at = k * 4;
    // Premultiplied source-over on a transparent frame: B with g_B, then A with g_A inside the clip.
    const alphaB = b[at + 3] * gB;
    const alphaA = keep[k] ? a[at + 3] * gA : 0;
    const alpha = alphaA + (1 - alphaA) * alphaB;
    for (let ch = 0; ch < 3; ch++) {
      const premultiplied = a[at + ch] * alphaA + (1 - alphaA) * b[at + ch] * alphaB;
      out[at + ch] = alpha > 0 ? premultiplied / alpha : 0;
    }
    out[at + 3] = alpha;
  }
  return out;
}

// ---- Stroked erase transitions (spiralWipe, xWipe): T6, strokes ----
export const STROKE_TRANSITIONS = ['spiralWipe', 'xWipe'];
const STROKE_SAMPLES = 8;

function distanceToSegment(px, py, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - a[0] - t * dx, py - a[1] - t * dy);
}

/** Stroke coverage of every pixel: the fraction of the pixel's area inside the stroke outline. */
export function strokeCoverage(id, progress, W, H) {
  const p = clamp01(progress);
  const D = Math.sqrt(W * W + H * H);
  let inside;
  if (id === 'xWipe') {
    // Two butt-capped segments: within half the width of the diagonal, between its ends.
    const width = 0.36 * p * D || 1;
    const band = (px, py, a, b) => {
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const along = ((px - a[0]) * dx + (py - a[1]) * dy) / D;
      return along >= 0 && along <= D && Math.abs((px - a[0]) * dy - (py - a[1]) * dx) / D <= width / 2;
    };
    inside = (px, py) => band(px, py, [0, 0], [W, H]) || band(px, py, [W, 0], [0, H]);
  } else {
    // A round-capped, round-joined polyline: within half the width of any of its segments.
    const R = 0.58 * D;
    const width = p === 0 ? 1 : (R / 3.8) * (0.04 + 1.25 * p);
    const points = Array.from({ length: 221 }, (_, i) => {
      const t = i / 220;
      const angle = t * Math.PI * 2 * 3.8;
      return [W / 2 + Math.cos(angle) * R * t, H / 2 + Math.sin(angle) * R * t];
    });
    inside = (px, py) => {
      for (let i = 0; i < 220; i++) if (distanceToSegment(px, py, points[i], points[i + 1]) <= width / 2) return true;
      return false;
    };
  }
  const coverage = new Float64Array(W * H);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      let hits = 0;
      for (let sy = 0; sy < STROKE_SAMPLES; sy++) {
        for (let sx = 0; sx < STROKE_SAMPLES; sx++) {
          if (inside(i + (sx + 0.5) / STROKE_SAMPLES, j + (sy + 0.5) / STROKE_SAMPLES)) hits++;
        }
      }
      coverage[j * W + i] = hits / (STROKE_SAMPLES * STROKE_SAMPLES);
    }
  }
  return coverage;
}

/** The frame of spiralWipe or xWipe: B, then A with the stroke erased from it (destination-out), source-over. */
export function renderStrokeTransition(c, a, b, W, H) {
  const coverage = strokeCoverage(c.id, c.progress, W, H);
  const out = new Array(W * H * 4);
  for (let k = 0; k < W * H; k++) {
    const at = k * 4;
    const alphaA = a[at + 3] * (1 - coverage[k]);
    const alpha = alphaA + (1 - alphaA) * b[at + 3];
    for (let ch = 0; ch < 3; ch++) out[at + ch] = alpha > 0 ? (a[at + ch] * alphaA + (1 - alphaA) * b[at + ch] * b[at + 3]) / alpha : 0;
    out[at + 3] = alpha;
  }
  return out;
}
