// HDR and colour-management goldens of the Studio render spec (studio/spec/hdr.md, the native-app
// contract). Engine-free: the case list, the inputs, the buffer encodings, the comparison rule and
// an independent reference written from the prose of hdr.md are defined here, so a native client
// can rebuild every case without the engine. hdr-goldens.browser.mjs runs the cases through the
// real engine and writes the expected values; nothing in a golden is written by hand.
import assert from 'node:assert/strict';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import {
  EFFECT_SIZE, effectSdrInput, effectHdrInput, roundHalf, compareCase, sha256,
  encodeBuffer as encodeRenderBuffer, decodeBuffer as decodeRenderBuffer,
} from './render-goldens.mjs';

export { compareCase };
export const HDR_GOLDENS_FORMAT = 'frameleaf-studio-hdr-goldens';
export const HDR_GOLDENS_VERSION = 1;
export const IMAGE_SIZE = EFFECT_SIZE;

// ---- buffers: the render-goldens encodings plus binary32 for signal frames ----
export const HDR_ENCODINGS = ['f16le-deflate-base64', 'rgba8-deflate-base64', 'f32le-deflate-base64'];
export function encodeBuffer(values, encoding) {
  if (encoding !== 'f32le-deflate-base64') return encodeRenderBuffer(values, encoding);
  const buf = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => buf.writeFloatLE(v, i * 4));
  return deflateRawSync(buf, { level: 9 }).toString('base64');
}
export function decodeBuffer(data, encoding) {
  if (encoding !== 'f32le-deflate-base64') return decodeRenderBuffer(data, encoding);
  const buf = inflateRawSync(Buffer.from(data, 'base64'));
  return Array.from({ length: buf.length / 4 }, (_, i) => buf.readFloatLE(i * 4));
}

// ---- stage vectors -------------------------------------------------------------------------
// A stage case is { name, stage, args, exact }. `exact` cases involve only + - x / , square roots,
// comparisons and selection in binary64 (and powers whose base is exactly 0 or 1, which IEEE 754
// defines exactly), and must be reproduced bit for bit; the others involve powers, logarithms or
// exponentials of other arguments and carry STAGE_TOLERANCE.
export const STAGE_TOLERANCE = { abs: 1e-12, relative: 1e-9 };
const EXACT_STAGES = ['resolve', 'sourceRange', 'timelineRange', 'decoderTransfer', 'bt709ToBt2020', 'bt2020ToBt709', 'ycbcrToSignal', 'rasterAdmission'];
export const STAGES = [
  ...EXACT_STAGES, 'srgbDecode', 'srgbEncode', 'pqEncode', 'pqDecode', 'hlgOetf', 'hlgInverseOetf', 'hlgSystemGamma',
  'hlgOotf', 'hlgInverseOotf', 'signalToWorking', 'workingToSignal', 'eetf', 'sdrDisplay', 'ingestLight',
];

const TRIPLETS = [
  [0, 0, 0], [0.18, 0.18, 0.18], [1, 1, 1], [1, 0, 0], [0, 1, 0], [0, 0, 1], [0.25, 0.5, 0.75],
  [2.25, 1.8, 1.2], [4, 4, 4], [8, 2, 0.5], [-0.25, 0.5, 1.25], [1.2, -0.1, -0.1], [49, 49, 49], [60, 0.5, 0.5],
];
const SIGNALS = [[0, 0, 0], [0.1, 0.1, 0.1], [0.5, 0.5, 0.5], [0.58, 0.58, 0.58], [0.75, 0.75, 0.75], [1, 1, 1],
  [1, 0, 0], [0, 1, 0], [0, 0, 1], [0.2, 0.6, 0.9], [0.9, 0.4, 0.05], [1.5, -0.25, 0.5]];
const HDR = { workingRange: 'hdr' };

/** The complete, ordered stage case list. */
export function stageCases() {
  const cases = [];
  const add = (stage, args, exact = EXACT_STAGES.includes(stage)) => {
    cases.push({ name: `${stage}/${cases.filter((c) => c.stage === stage).length}`, stage, args, exact });
  };
  // H2: the colour-management record and its defaults.
  for (const [settings, sourceRange] of [
    [null, 'sdr'], [null, 'hdr'], [{}, 'sdr'], [{ workingRange: 'sdr' }, 'sdr'], [{ workingRange: 'sdr' }, 'hdr'],
    [HDR, 'sdr'], [{ workingRange: 'HDR' }, 'sdr'], [{ workingRange: 'pq' }, 'sdr'],
    [{ ...HDR, referenceWhiteNits: 100 }, 'sdr'], [{ ...HDR, referenceWhiteNits: 0 }, 'sdr'], [{ ...HDR, referenceWhiteNits: -203 }, 'sdr'],
    [{ ...HDR, referenceWhiteNits: '203' }, 'sdr'], [{ ...HDR, masteringPeakNits: 4000 }, 'sdr'], [{ ...HDR, masteringPeakNits: 100 }, 'sdr'],
    [{ ...HDR, referenceWhiteNits: 300, masteringPeakNits: 250 }, 'sdr'], [{ ...HDR, referenceWhiteNits: 2000 }, 'sdr'],
    [{ ...HDR, masteringPeakNits: 0 }, 'sdr'], [{ ...HDR, sdrMonitoring: 'none' }, 'sdr'], [{ ...HDR, sdrMonitoring: 'bt2390' }, 'sdr'],
    [{ ...HDR, sdrMonitoring: 'hable' }, 'sdr'], [{ sdrMonitoring: 'none', masteringPeakNits: 600 }, 'hdr'],
    [{ workingRange: 'sdr', transfer: 'pq', primaries: 'bt2020' }, 'sdr'],
  ]) add('resolve', [settings, sourceRange]);
  // H3: which source transfers make a project HDR.
  for (const list of [[], ['sdr'], [null, 'sdr'], ['pq'], ['hlg'], ['hdr'], ['sdr', null, 'hlg'], ['PQ'], ['smpte2084'], ['arib-std-b67'], ['linear'], ['sdr', 'sdr', 'hdr']]) {
    add('sourceRange', [list]);
  }
  const video = (id, mediaId) => ({ id, type: 'video', mediaId });
  const nest = (id, compositionId) => ({ id, type: 'composition', compositionId });
  const media = { s: { colorTransfer: 'sdr' }, p: { colorTransfer: 'pq' }, h: { colorTransfer: 'hlg' }, x: { colorTransfer: 'hdr' }, u: {} };
  for (const [tracks, compositions] of [
    [[], {}],
    [[{ items: [video('a', 's'), { id: 't', type: 'text' }] }], {}],
    [[{ items: [video('a', 's')] }, { items: [video('b', 'p')] }], {}],
    [[{ items: [video('a', 'h')] }], {}],
    [[{ items: [video('a', 'x')] }], {}],
    [[{ items: [video('a', 'u'), video('b', 'missing')] }], {}],
    [[{ items: [{ id: 'i', type: 'image', mediaId: 'p' }] }], {}],
    [[{ items: [{ id: 'au', type: 'audio', mediaId: 'h' }] }], {}],
    [[{ items: [nest('n', 'c1')] }], { c1: { items: [video('a', 's')] } }],
    [[{ items: [nest('n', 'c1')] }], { c1: { items: [nest('m', 'c2')] }, c2: { tracks: [{ items: [video('a', 'p')] }] } }],
    [[{ items: [nest('n', 'c1')] }], { c1: { items: [nest('m', 'c1'), video('a', 's')] } }],
    [[{ items: [nest('n', 'gone')] }], {}],
    [[{ items: [nest('n', 'c1')] }], { c1: { items: [video('a', 's')], tracks: [{ items: [video('b', 'p')] }] } }],
  ]) add('timelineRange', [tracks, media, compositions]);
  for (const space of [null, {}, { transfer: 'pq' }, { transfer: 'hlg' }, { transfer: 'bt709' }, { transfer: 'iec61966-2-1' }, { transfer: 'smpte2084' }, { transfer: null }]) {
    add('decoderTransfer', [space]);
  }
  // H5: the sRGB curve, extended by odd symmetry. Linear-segment and zero cases are exact.
  for (const v of [0, 0.01, 0.04045, -0.02]) add('srgbDecode', [v], true);
  for (const v of [0.04046, 0.2, 0.5, 0.735, 1, 1.25, -0.5, -1.5]) add('srgbDecode', [v]);
  for (const v of [0, 0.001, 0.0031308, -0.002]) add('srgbEncode', [v], true);
  for (const v of [0.0031309, 0.01, 0.18, 0.5, 1, 4, -0.25, -8]) add('srgbEncode', [v]);
  // H6: PQ. The end points are exact.
  for (const v of [10000, 20000]) add('pqEncode', [v], true);
  for (const v of [0, -5, 0.005, 0.1, 1, 100, 203, 406, 1000, 4000]) add('pqEncode', [v]);
  for (const v of [0, -0.25, 1, 1.5]) add('pqDecode', [v], true);
  for (const v of [1e-6, 0.001, 0.1, 0.25, 0.5, 0.5807, 0.6577, 0.75, 0.9026, 0.999]) add('pqDecode', [v]);
  // H7: HLG. The square-root and square branches are exact.
  for (const v of [0, -1, 0.01, 1 / 12]) add('hlgOetf', [v], true);
  for (const v of [0.0834, 0.2, 0.5, 0.75, 1, 3]) add('hlgOetf', [v]);
  for (const v of [0, -0.5, 0.25, 0.5]) add('hlgInverseOetf', [v], true);
  for (const v of [0.5001, 0.6, 0.75, 0.9, 1, 2]) add('hlgInverseOetf', [v]);
  for (const v of [400, 600, 1000, 2000, 4000]) add('hlgSystemGamma', [v]);
  for (const t of [[0, 0, 0], [-0.5, 0, 0]]) add('hlgOotf', [t, 1000], true);
  for (const t of [[0.18, 0.18, 0.18], [1, 1, 1], [1, 0, 0], [0.5, 0.25, 0.05], [0.26, -0.02, 0.4]]) add('hlgOotf', [t, 1000]);
  for (const t of [[0.5, 0.25, 0.05], [1, 1, 1]]) add('hlgOotf', [t, 400]);
  for (const t of [[0, 0, 0], [0, -10, 0]]) add('hlgInverseOotf', [t, 1000], true);
  for (const t of [[203, 203, 203], [1000, 1000, 1000], [1000, 0, 0], [406, 120, 30], [50, -4, 80]]) add('hlgInverseOotf', [t, 1000]);
  add('hlgInverseOotf', [[406, 120, 30], 400]);
  // H8: the primaries matrices.
  for (const t of TRIPLETS) add('bt709ToBt2020', [t]);
  for (const t of [...TRIPLETS.slice(0, 11), [0.627404, 0.069097, 0.016392]]) add('bt2020ToBt709', [t]);
  // H9: limited-range BT.2020 non-constant-luminance Y'CbCr code values.
  for (const [y, cb, cr, depth] of [
    [64, 512, 512, 10], [940, 512, 512, 10], [502, 512, 512, 10], [0, 512, 512, 10], [1023, 512, 512, 10],
    [502, 64, 512, 10], [502, 960, 512, 10], [502, 512, 64, 10], [502, 512, 960, 10], [300, 400, 700, 10],
    [721, 623.5, 438.25, 10], [877, 0, 1023, 10], [16, 128, 128, 8], [235, 128, 128, 8], [126, 90, 240, 8],
    [2008, 2048, 2048, 12], [3760, 1600, 2500, 12],
  ]) add('ycbcrToSignal', [y, cb, cr, depth]);
  // H10: source signal to working values; H14: working values to delivery signal.
  for (const transfer of ['pq', 'hlg']) {
    for (const s of SIGNALS) add('signalToWorking', [s, transfer, 203]);
    for (const s of [SIGNALS[3], SIGNALS[9]]) add('signalToWorking', [s, transfer, 100]);
  }
  for (const transfer of ['pq', 'hlg']) {
    for (const t of TRIPLETS) add('workingToSignal', [t, transfer, 203]);
    for (const t of [TRIPLETS[2], TRIPLETS[7]]) add('workingToSignal', [t, transfer, 100]);
  }
  // H12: the EETF. Light at or below zero and the no-compression branch are exact.
  for (const [n, s, t] of [[0, 1000, 406], [-5, 1000, 406], [100, 400, 406], [500, 400, 406], [300, 406, 406]]) add('eetf', [n, s, t], true);
  for (const n of [0.01, 1, 50, 100, 148, 150, 203, 300, 406, 600, 812, 1000, 1001, 1200, 4000, 10000]) add('eetf', [n, 1000, 406]);
  for (const [n, s, t] of [[100, 4000, 406], [1000, 4000, 406], [4000, 4000, 406], [200, 4000, 200], [150, 10000, 100], [9000, 10000, 100], [300, 600, 406], [500, 1000, 1000 - 1e-9]]) add('eetf', [n, s, t]);
  // H13: SDR display of working values. SDR projects and values clipped at 0 or 1 are exact.
  for (const t of [[0.25, 0.5, 0.75], [-0.1, 0.5, 1.5]]) add('sdrDisplay', [t, { workingRange: 'sdr' }], true);
  for (const t of [[0, 0, 0], [-1, -0.5, 0], [2, 1, 4]]) add('sdrDisplay', [t, { ...HDR, sdrMonitoring: 'none' }], true);
  add('sdrDisplay', [[0, 0, 0], HDR], true);
  for (const t of TRIPLETS.slice(1)) add('sdrDisplay', [t, HDR]);
  for (const t of [[0.5, 0.5, 0.5], [0.3, 0.2, 0.9], [0.7, 0.4, -0.2]]) add('sdrDisplay', [t, { ...HDR, sdrMonitoring: 'none' }]);
  for (const t of [[-0.6, 0.05, 0.1], [0.02, -0.01, 0.3]]) add('sdrDisplay', [t, HDR]);
  for (const t of [[1, 1, 1], [2.25, 1.8, 1.2], [8, 2, 0.5]]) {
    add('sdrDisplay', [t, { ...HDR, masteringPeakNits: 4000 }]);
    add('sdrDisplay', [t, { ...HDR, masteringPeakNits: 400 }]);
    add('sdrDisplay', [t, { ...HDR, referenceWhiteNits: 100 }]);
  }
  // H13: the ends of the clip are selected, never computed (SRGB(1) is 1 - 2^-53 in binary64).
  for (const t of [[1, 1, 1], [1, 0, 1 + 2 ** -52]]) add('sdrDisplay', [t, { ...HDR, sdrMonitoring: 'none' }], true);
  add('sdrDisplay', [[-20, 1, 2], HDR], true);
  add('sdrDisplay', [[1 - 2 ** -53, 0.5, 0.25], { ...HDR, sdrMonitoring: 'none' }]);
  // H11: admission of a still supplied as an HDR raster (see rasterFromSpec).
  for (const spec of [
    { width: 2, height: 1, transfer: 'pq', samples: 6 }, { width: 2, height: 1, transfer: 'hlg', samples: 6 },
    { width: 2, height: 1, transfer: 'pq', samples: 8 }, { width: 0, height: 1, transfer: 'pq', samples: 0 },
    { width: 2, height: 1, transfer: 'srgb', samples: 6 }, { width: 8000, height: 6001, transfer: 'pq', samples: 6 },
    { width: 1, height: 1, transfer: 'linear', gamut: 0, referenceWhite: 203, pixel: [1, 2, 3, 1] },
    { width: 1, height: 1, transfer: 'linear', gamut: 2, referenceWhite: 10000, pixel: [1, -1, 0.5, 0] },
    { width: 1, height: 1, transfer: 'linear', gamut: 3, referenceWhite: 203, pixel: [1, 2, 3, 1] },
    { width: 1, height: 1, transfer: 'linear', gamut: 0, referenceWhite: 0.5, pixel: [1, 2, 3, 1] },
    { width: 1, height: 1, transfer: 'linear', gamut: 0, referenceWhite: 10001, pixel: [0, 0, 0, 1] },
    { width: 1, height: 1, transfer: 'linear', gamut: 1, referenceWhite: 203, pixel: [49.5, 0, 0, 1] },
    { width: 1, height: 1, transfer: 'linear', gamut: 1, referenceWhite: 203, pixel: [0, -49.5, 0, 1] },
    { width: 1, height: 1, transfer: 'linear', gamut: 1, referenceWhite: 203, pixel: [1, 1, 1, 1.5] },
    { width: 1, height: 1, transfer: 'linear', gamut: 1, referenceWhite: 203, pixel: [1, 1, 1, -0.5] },
    { width: 1, height: 1, transfer: 'linear', gamut: 0, referenceWhite: 203, pixel: [1, 'NaN', 1, 1] },
  ]) add('rasterAdmission', [spec]);
  // H10 by boundary: the scene light (HLG only), the display light and the working values of one
  // signal, for a client whose decoder delivers light instead of the signal.
  for (const transfer of ['pq', 'hlg']) {
    for (const s of [SIGNALS[0], SIGNALS[2], SIGNALS[4], SIGNALS[5], SIGNALS[9], SIGNALS[10]]) add('ingestLight', [s, transfer, 203]);
    add('ingestLight', [SIGNALS[9], transfer, 100]);
  }
  return cases;
}

/** The raster object a rasterAdmission case describes (typed arrays cannot travel as JSON). */
export function rasterFromSpec(spec, { Uint16Array: U16 = Uint16Array, Float32Array: F32 = Float32Array } = {}) {
  if (spec.transfer === 'linear') {
    return { width: spec.width, height: spec.height, transfer: 'linear', gamut: spec.gamut, referenceWhite: spec.referenceWhite,
      rgba: new F32(spec.pixel.map(Number)) };
  }
  return { width: spec.width, height: spec.height, transfer: spec.transfer, rgb: new U16(spec.samples) };
}

// ---- image cases ---------------------------------------------------------------------------
/**
 * Image inputs, all 16 x 12 (render-goldens.mjs):
 *   working  effectHdrInput() rounded to binary16: linear working values, straight alpha
 *   encoded  effectSdrInput() rounded to binary16: sRGB-encoded values, straight alpha
 *   bytes    round(255 x effectSdrInput()): the same picture as 8-bit RGBA
 *   signal16 257 x the RGB bytes: an opaque full-range 16-bit R'G'B' signal picture
 *   planes   the picture as 10-bit limited-range BT.2020 Y'CbCr 4:2:0 (see yuvPlanes)
 */
export function imageInputs() {
  const bytes = effectSdrInput().map((v) => Math.round(v * 255));
  return {
    working: effectHdrInput().map(roundHalf),
    encoded: effectSdrInput().map(roundHalf),
    bytes,
    signal16: bytes.flatMap((b, i) => (i % 4 === 3 ? [] : [b * 257])),
    planes: yuvPlanes(bytes),
  };
}

/**
 * 10-bit planes of the byte picture read as R'G'B' = byte / 255:
 *   Y' = 0.2627 R' + 0.678 G' + 0.0593 B', Cb = (B' - Y') / 1.8814, Cr = (R' - Y') / 1.4746
 *   Y code = round(4 (16 + 219 Y')), chroma code = round(4 (128 + 224 C)), with C averaged over each 2 x 2 block
 * then four code values outside the nominal range: Y(0, 0) = 0, Y(15, 0) = 1023, Cb(7, 5) = 0, Cr(7, 5) = 1023.
 */
export function yuvPlanes(bytes) {
  const { width: W, height: H } = IMAGE_SIZE;
  const y = [];
  const cbFull = [];
  const crFull = [];
  for (let i = 0; i < W * H; i++) {
    const [r, g, b] = [0, 1, 2].map((c) => bytes[i * 4 + c] / 255);
    const luma = 0.2627 * r + 0.678 * g + 0.0593 * b;
    y.push(Math.round(4 * (16 + 219 * luma)));
    cbFull.push((b - luma) / 1.8814);
    crFull.push((r - luma) / 1.4746);
  }
  const sub = (full) => {
    const out = [];
    for (let cy = 0; cy < H / 2; cy++) for (let cx = 0; cx < W / 2; cx++) {
      const at = (dx, dy) => full[(cy * 2 + dy) * W + cx * 2 + dx];
      out.push(Math.round(4 * (128 + 224 * ((at(0, 0) + at(1, 0) + at(0, 1) + at(1, 1)) / 4))));
    }
    return out;
  };
  const cb = sub(cbFull);
  const cr = sub(crFull);
  y[0] = 0;
  y[15] = 1023;
  cb[5 * (W / 2) + 7] = 0;
  cr[5 * (W / 2) + 7] = 1023;
  return { y, cb, cr };
}

/**
 * The ordered image case list. `kind` selects the tolerance floor and the output encoding:
 *   signal   PQ or HLG R'G'B' in [0, 1], binary32
 *   sdr      SDR display R'G'B' in [0, 1], binary32
 *   working  linear working values, binary16
 */
export function imageCases() {
  const cases = [];
  const out = (name, input, target, color, kind) => cases.push({ name: `output/${name}`, stage: 'output', input, target, color, kind });
  out('hdr/pq', 'working', 'pq', HDR, 'signal');
  out('hdr/hlg', 'working', 'hlg', HDR, 'signal');
  out('hdr/pq/white=100', 'working', 'pq', { ...HDR, referenceWhiteNits: 100 }, 'signal');
  out('hdr/hlg/white=100', 'working', 'hlg', { ...HDR, referenceWhiteNits: 100 }, 'signal');
  out('hdr/sdr-display', 'working', 'sdr-display', HDR, 'sdr');
  out('hdr/sdr-display/clip', 'working', 'sdr-display', { ...HDR, sdrMonitoring: 'none' }, 'sdr');
  out('hdr/sdr-display/peak=4000', 'working', 'sdr-display', { ...HDR, masteringPeakNits: 4000 }, 'sdr');
  out('hdr/sdr-display/peak=400', 'working', 'sdr-display', { ...HDR, masteringPeakNits: 400 }, 'sdr');
  out('hdr/sdr-display/white=100', 'working', 'sdr-display', { ...HDR, referenceWhiteNits: 100 }, 'sdr');
  out('sdr/pq', 'encoded', 'pq', {}, 'signal');
  out('sdr/hlg', 'encoded', 'hlg', {}, 'signal');
  out('sdr/sdr-display', 'encoded', 'sdr-display', {}, 'sdr');
  const ingest = (name, extra) => cases.push({ name: `ingest/${name}`, stage: 'ingest', kind: 'working', referenceWhite: 203, ...extra });
  ingest('sdr-texels', { source: 'bytes' });
  ingest('raster/pq', { source: 'raster', transfer: 'pq' });
  ingest('raster/hlg', { source: 'raster', transfer: 'hlg' });
  ingest('raster/pq/white=100', { source: 'raster', transfer: 'pq', referenceWhite: 100 });
  ingest('raster/linear/bt709', { source: 'linear', gamut: 0, rasterWhite: 203 });
  ingest('raster/linear/display-p3', { source: 'linear', gamut: 1, rasterWhite: 203 });
  ingest('raster/linear/bt2020', { source: 'linear', gamut: 2, rasterWhite: 203 });
  ingest('raster/linear/bt709/raster-white=100', { source: 'linear', gamut: 0, rasterWhite: 100 });
  ingest('video/pq', { source: 'planes', transfer: 'pq' });
  ingest('video/hlg', { source: 'planes', transfer: 'hlg' });
  ingest('video/pq/white=100', { source: 'planes', transfer: 'pq', referenceWhite: 100 });
  return cases;
}
export const IMAGE_ENCODING = { signal: 'f32le-deflate-base64', sdr: 'f32le-deflate-base64', working: 'f16le-deflate-base64' };
// Tolerance floors: half a full-range 10-bit code value for a delivery signal, half an 8-bit code
// value for an SDR display, and the linear HDR floor of the render spec (0.004 plus 0.2 %) for
// working values, which are stored as binary16.
export const IMAGE_FLOOR = { signal: { abs: 0.0005, relative: 0 }, sdr: { abs: 0.5 / 255, relative: 0 }, working: { abs: 0.004, relative: 0.002 } };

const sig = (v) => Number(v.toPrecision(3));
/**
 * Tolerance of an image case, by the rule of render-goldens.mjs. The canonical render (binary32
 * on the software GPU) is compared with a second GPU backend and with the binary64 reference of
 * this file; d is the larger of the two differences per channel. abs = max(floor, 1.5 x the
 * largest d outside the relative allowance), meanAbs = max(floor / 2, 1.5 x the mean d), and no
 * outliers. `measured` records both comparisons; crossBackend is null when no second backend ran.
 */
export function deriveHdrTolerance(kind, canonical, other, reference) {
  const floor = IMAGE_FLOOR[kind];
  const stats = (set) => {
    if (!set) return null;
    const d = canonical.map((v, i) => Math.abs(v - set[i]));
    return { max: sig(Math.max(0, ...d)), mean: Number((d.reduce((a, b) => a + b, 0) / d.length).toPrecision(3)) };
  };
  const sets = [other, reference].filter(Boolean);
  const diffs = canonical.map((v, i) => Math.max(0, ...sets.map((set) => Math.abs(v - set[i]))));
  const worst = Math.max(0, ...diffs.filter((d, i) => d > floor.relative * Math.abs(canonical[i])));
  const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  return {
    class: 'pixel', abs: Math.max(floor.abs, sig(worst * 1.5)), relative: floor.relative, outliers: 0,
    meanAbs: Math.max(floor.abs / 2, sig(mean * 1.5)), measured: { crossBackend: stats(other), reference: stats(reference) },
  };
}

/** Compares one stage result with its golden: structure exact, numbers exact or within tolerance. */
export function compareStage(golden, actual) {
  const { abs, relative } = STAGE_TOLERANCE;
  const walk = (want, got) => {
    if (typeof want === 'number') {
      if (typeof got !== 'number' || !Number.isFinite(got)) return false;
      return golden.exact ? got === want : Math.abs(got - want) <= Math.max(abs, relative * Math.abs(want));
    }
    if (Array.isArray(want)) return Array.isArray(got) && got.length === want.length && want.every((v, i) => walk(v, got[i]));
    if (want && typeof want === 'object') {
      return !!got && typeof got === 'object' && Object.keys(want).length === Object.keys(got).length && Object.keys(want).every((k) => walk(want[k], got[k]));
    }
    return want === got;
  };
  return walk(golden.expected, actual);
}

// ---- the independent reference: studio/spec/hdr.md, implemented from its prose ----------------
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const isPositive = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
const HDR_TRANSFERS = ['pq', 'hlg', 'hdr'];

// H2
function resolveRecord(record, sourceRange) {
  const white = isPositive(record?.referenceWhiteNits) ? record.referenceWhiteNits : 203;
  const peak = isPositive(record?.masteringPeakNits) ? record.masteringPeakNits : 1000;
  return {
    workingRange: record?.workingRange === 'hdr' || sourceRange === 'hdr' ? 'hdr' : 'sdr',
    referenceWhiteNits: white,
    masteringPeakNits: peak < white ? white : peak,
    sdrMonitoring: record?.sdrMonitoring === 'none' ? 'none' : 'bt2390',
  };
}
// H3
const rangeOfTransfers = (list) => (list.some((t) => HDR_TRANSFERS.includes(t)) ? 'hdr' : 'sdr');
function rangeOfTimeline(tracks, media, compositions) {
  const visited = new Set();
  const found = [];
  const visit = (items) => {
    for (const item of items) {
      if (item.type === 'composition') {
        if (visited.has(item.compositionId)) continue;
        visited.add(item.compositionId);
        const nested = compositions[item.compositionId];
        if (nested) visit(nested.items ?? (nested.tracks ?? []).flatMap((t) => t.items ?? []));
      } else if (item.mediaId) found.push(media[item.mediaId]?.colorTransfer);
    }
  };
  visit(tracks.flatMap((t) => t.items ?? []));
  return rangeOfTransfers(found);
}
const transferOfDecoder = (space) => (space?.transfer === 'pq' ? 'pq' : space?.transfer === 'hlg' ? 'hlg' : 'sdr');
// H5
const srgbDecode = (v) => { const a = Math.abs(v); return Math.sign(v) * (a <= 0.04045 ? a / 12.92 : ((a + 0.055) / 1.055) ** 2.4); };
const srgbEncode = (v) => { const a = Math.abs(v); return Math.sign(v) * (a <= 0.0031308 ? 12.92 * a : 1.055 * a ** (1 / 2.4) - 0.055); };
// H6
const M1 = 2610 / 16384;
const M2 = 2523 / 32;
const C1 = 3424 / 4096;
const C2 = 2413 / 128;
const C3 = 2392 / 128;
const pqEncode = (nits) => { const y = clamp01(nits / 10000) ** M1; return ((C1 + C2 * y) / (1 + C3 * y)) ** M2; };
const pqDecode = (signal) => { const e = clamp01(signal) ** (1 / M2); return 10000 * (Math.max(e - C1, 0) / (C2 - C3 * e)) ** (1 / M1); };
// H7
const A = 0.17883277;
const B = 1 - 4 * A;
const C = 0.5 - A * Math.log(4 * A);
const hlgOetf = (x) => { const e = clamp01(x); return e <= 1 / 12 ? Math.sqrt(3 * e) : A * Math.log(12 * e - B) + C; };
const hlgInverseOetf = (s) => { const e = clamp01(s); return e <= 0.5 ? (e * e) / 3 : (Math.exp((e - C) / A) + B) / 12; };
const hlgGamma = (peak) => 1.2 + 0.42 * Math.log10(peak / 1000);
const luma2020 = ([r, g, b]) => 0.2627 * r + 0.678 * g + 0.0593 * b;
function hlgOotf(scene, peak) {
  const ys = Math.max(luma2020(scene), 0);
  const gain = ys > 0 ? peak * ys ** (hlgGamma(peak) - 1) : 0;
  return scene.map((v) => v * gain);
}
function hlgInverseOotf(display, peak) {
  const yd = Math.max(luma2020(display), 0);
  if (yd <= 0) return [0, 0, 0];
  const gamma = hlgGamma(peak);
  const scale = 1 / (peak * ((yd / peak) ** (1 / gamma)) ** (gamma - 1));
  return display.map((v) => v * scale);
}
// H8
const TO_2020 = [[0.627404, 0.329282, 0.043314], [0.069097, 0.91954, 0.011361], [0.016392, 0.088013, 0.895595]];
const TO_709 = [[1.660491, -0.587641, -0.07285], [-0.124551, 1.1329, -0.008349], [-0.018151, -0.100579, 1.11873]];
const P3_TO_709 = [[1.224940176, -0.224940176, 0], [-0.042056955, 1.042056955, 0], [-0.019637555, -0.078636046, 1.098273601]];
const apply = (m, [r, g, b]) => m.map((row) => row[0] * r + row[1] * g + row[2] * b);
// H9
function ycbcrToSignal(y, cb, cr, depth) {
  const s = 2 ** (depth - 8);
  const yn = (y / s - 16) / 219;
  const pb = (cb / s - 128) / 224;
  const pr = (cr / s - 128) / 224;
  const kg = 1 - 0.2627 - 0.0593;
  const r = yn + 2 * (1 - 0.2627) * pr;
  const b = yn + 2 * (1 - 0.0593) * pb;
  return [r, (yn - 0.2627 * r - 0.0593 * b) / kg, b].map(clamp01);
}
// H10
function signalToWorking(signal, transfer, white) {
  const nits = transfer === 'pq' ? signal.map(pqDecode) : hlgOotf(signal.map(hlgInverseOetf), 1000);
  return apply(TO_709, nits.map((v) => v / white));
}
// H14
function workingToSignal(working, transfer, white) {
  const nits = apply(TO_2020, working).map((v) => Math.max(v, 0) * white);
  if (transfer === 'pq') return nits.map(pqEncode);
  return hlgInverseOotf(nits.map((v) => Math.min(v, 1000)), 1000).map(hlgOetf);
}
// H12
function eetf(nits, sourcePeak, targetPeak) {
  if (nits <= 0) return 0;
  if (targetPeak >= sourcePeak) return Math.min(nits, targetPeak);
  const top = pqEncode(sourcePeak);
  const e1 = pqEncode(nits) / top;
  const maxLum = pqEncode(targetPeak) / top;
  const ks = 1.5 * maxLum - 0.5;
  let e2 = e1;
  if (e1 > ks && ks < 1) {
    const t = (e1 - ks) / (1 - ks);
    const t2 = t * t;
    const t3 = t2 * t;
    e2 = (2 * t3 - 3 * t2 + 1) * ks + (t3 - 2 * t2 + t) * (1 - ks) + (-2 * t3 + 3 * t2) * maxLum;
  }
  return Math.min(pqDecode(Math.min(e2, 1) * top), targetPeak);
}
// H10, stopped at each boundary: scene light (HLG only), display light in cd/m2, working values.
function ingestLight(signal, transfer, white) {
  const sceneLight = transfer === 'hlg' ? signal.map((v) => hlgInverseOetf(v)) : null;
  const displayLight = sceneLight ? hlgOotf(sceneLight, 1000) : signal.map((v) => pqDecode(v));
  return { sceneLight, displayLight, working: apply(TO_709, displayLight.map((v) => v / white)) };
}
// H13
function sdrDisplay(working, color) {
  if (color.workingRange === 'sdr') return working.map(clamp01);
  // Policy `none`: 0 at or below 0 and 1 at or above 1 by selection; SRGB only strictly between.
  const clip = () => working.map((v) => (v <= 0 ? 0 : v >= 1 ? 1 : srgbEncode(v)));
  if (color.sdrMonitoring === 'none') return clip();
  const y = 0.2126 * working[0] + 0.7152 * working[1] + 0.0722 * working[2];
  if (y <= 0) return clip();
  const nits = y * color.referenceWhiteNits;
  const scale = eetf(nits, color.masteringPeakNits, color.referenceWhiteNits * 2) / nits / 2;
  let scaled = working.map((v) => v * scale);
  const top = Math.max(...scaled);
  if (top > 1) scaled = scaled.map((v) => v / top);
  return scaled.map((v) => clamp01(srgbEncode(v)));
}
// H11
function rasterAdmitted(raster) {
  const { width: w, height: h } = raster;
  if (!Number.isSafeInteger(w) || !Number.isSafeInteger(h) || w <= 0 || h <= 0 || w * h > 48_000_000) return false;
  if (raster.transfer === 'linear') {
    if (raster.rgba.length !== w * h * 4 || ![0, 1, 2].includes(raster.gamut)) return false;
    if (!Number.isFinite(raster.referenceWhite) || raster.referenceWhite < 1 || raster.referenceWhite > 10000) return false;
    return Array.from(raster.rgba).every((v, i) => Number.isFinite(v)
      && (i % 4 === 3 ? v >= 0 && v <= 1 : Math.abs(v) * raster.referenceWhite <= 10000));
  }
  return ['pq', 'hlg'].includes(raster.transfer) && raster.rgb.length === w * h * 3;
}

/** The reference answer of a stage case. */
export function referenceStage({ stage, args }) {
  switch (stage) {
    case 'resolve': return resolveRecord(args[0], args[1]);
    case 'sourceRange': return rangeOfTransfers(args[0]);
    case 'timelineRange': return rangeOfTimeline(...args);
    case 'decoderTransfer': return transferOfDecoder(args[0]);
    case 'srgbDecode': return srgbDecode(args[0]);
    case 'srgbEncode': return srgbEncode(args[0]);
    case 'pqEncode': return pqEncode(args[0]);
    case 'pqDecode': return pqDecode(args[0]);
    case 'hlgOetf': return hlgOetf(args[0]);
    case 'hlgInverseOetf': return hlgInverseOetf(args[0]);
    case 'hlgSystemGamma': return hlgGamma(args[0]);
    case 'hlgOotf': return hlgOotf(...args);
    case 'hlgInverseOotf': return hlgInverseOotf(...args);
    case 'bt709ToBt2020': return apply(TO_2020, args[0]);
    case 'bt2020ToBt709': return apply(TO_709, args[0]);
    case 'ycbcrToSignal': return ycbcrToSignal(...args);
    case 'signalToWorking': return signalToWorking(...args);
    case 'workingToSignal': return workingToSignal(...args);
    case 'eetf': return eetf(...args);
    case 'sdrDisplay': return sdrDisplay(args[0], resolveRecord(args[1], 'sdr'));
    case 'ingestLight': return ingestLight(...args);
    case 'rasterAdmission': return rasterAdmitted(rasterFromSpec(args[0])) ? 'admitted' : 'rejected';
    default: throw new Error(`Unknown stage ${stage}`);
  }
}

/** The reference picture of an image case: RGBA, row-major, in binary64. */
export function referenceImage(c, inputs = imageInputs()) {
  const { width: W, height: H } = IMAGE_SIZE;
  const out = [];
  const pixel = (values, i) => values.slice(i * 4, i * 4 + 4);
  if (c.stage === 'output') {
    const color = resolveRecord(c.color, 'sdr');
    const hdr = color.workingRange === 'hdr';
    for (let i = 0; i < W * H; i++) {
      const [r, g, b, a] = pixel(inputs[c.input], i);
      const linear = hdr ? [r, g, b] : [r, g, b].map(srgbDecode);
      const rgb = c.target === 'sdr-display'
        ? (hdr ? sdrDisplay(linear, color) : [r, g, b].map(clamp01))
        : workingToSignal(linear, c.target, color.referenceWhiteNits);
      out.push(...rgb, clamp01(a));
    }
    return out;
  }
  if (c.source === 'bytes') {
    for (let i = 0; i < W * H; i++) {
      const [r, g, b, a] = pixel(inputs.bytes, i).map((v) => v / 255);
      out.push(srgbDecode(r), srgbDecode(g), srgbDecode(b), a);
    }
  } else if (c.source === 'raster') {
    for (let i = 0; i < W * H; i++) {
      out.push(...signalToWorking(inputs.signal16.slice(i * 3, i * 3 + 3).map((v) => v / 65535), c.transfer, c.referenceWhite), 1);
    }
  } else if (c.source === 'linear') {
    const matrix = [null, P3_TO_709, TO_709][c.gamut];
    for (let i = 0; i < W * H; i++) {
      const [r, g, b, a] = pixel(inputs.working, i);
      const rgb = matrix ? apply(matrix, [r, g, b]) : [r, g, b];
      out.push(...rgb.map((v) => (v * c.rasterWhite) / c.referenceWhite), a);
    }
  } else {
    const { y, cb, cr } = inputs.planes;
    const cw = W / 2;
    const ch = H / 2;
    const chroma = (plane, u, v) => {
      const x0 = Math.floor(u);
      const y0 = Math.floor(v);
      const fx = u - x0;
      const fy = v - y0;
      const at = (dx, dy) => plane[Math.min(Math.max(y0 + dy, 0), ch - 1) * cw + Math.min(Math.max(x0 + dx, 0), cw - 1)];
      const top = at(0, 0) + (at(1, 0) - at(0, 0)) * fx;
      const bottom = at(0, 1) + (at(1, 1) - at(0, 1)) * fx;
      return top + (bottom - top) * fy;
    };
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const u = (i + 0.5) * (cw / W) - 0.5;
      const v = (j + 0.5) * (ch / H) - 0.5;
      const signal = ycbcrToSignal(y[j * W + i], chroma(cb, u, v), chroma(cr, u, v), 10);
      out.push(...signalToWorking(signal, c.transfer, c.referenceWhite), 1);
    }
  }
  return out;
}

/** Structural and coverage validation of studio/spec/goldens/hdr.json (engine-free). */
export function validateHdrGoldens(doc) {
  assert.equal(doc.format, HDR_GOLDENS_FORMAT);
  assert.equal(doc.version, HDR_GOLDENS_VERSION);
  assert.equal(doc.contract, 'studio/spec/hdr.md');
  assert.deepEqual(doc.size, IMAGE_SIZE);
  assert.deepEqual(doc.stageTolerance, STAGE_TOLERANCE);
  const stages = stageCases();
  assert.deepEqual(doc.stages.map(({ expected, ...rest }) => rest), JSON.parse(JSON.stringify(stages)), 'stage cases must be complete and ordered');
  for (const c of doc.stages) assert(c.expected !== undefined && c.expected !== null, `${c.name}: no expected value`);
  for (const stage of STAGES) assert(stages.some((c) => c.stage === stage), `${stage}: no cases`);
  const inputs = imageInputs();
  const encodings = { working: 'f16le-deflate-base64', encoded: 'f16le-deflate-base64', bytes: 'rgba8-deflate-base64' };
  for (const [name, encoding] of Object.entries(encodings)) {
    const input = doc.inputs[name];
    assert.equal(input.encoding, encoding, `${name}: encoding`);
    assert.equal(input.sha256, sha256(input.data), `${name}: digest`);
    const want = name === 'bytes' ? inputs.bytes.map((v) => v / 255) : inputs[name];
    assert.deepEqual(decodeBuffer(input.data, encoding), want, `${name}: input does not match its formula`);
  }
  assert.deepEqual(doc.inputs.signal16.values, inputs.signal16, 'signal16: input does not match its formula');
  assert.deepEqual(doc.inputs.planes.values, inputs.planes, 'planes: input does not match its formula');
  const images = imageCases();
  assert.deepEqual(doc.images.map(({ output, tolerance, ...rest }) => rest), JSON.parse(JSON.stringify(images)), 'image cases must be complete and ordered');
  const channels = IMAGE_SIZE.width * IMAGE_SIZE.height * 4;
  for (const c of doc.images) {
    assert.equal(c.output.encoding, IMAGE_ENCODING[c.kind], `${c.name}: encoding`);
    const values = decodeBuffer(c.output.data, c.output.encoding);
    assert.equal(values.length, channels, `${c.name}: size`);
    assert(values.every(Number.isFinite), `${c.name}: not finite`);
    const floor = IMAGE_FLOOR[c.kind];
    assert(c.tolerance.abs >= floor.abs && c.tolerance.relative === floor.relative && c.tolerance.outliers === 0
      && c.tolerance.meanAbs >= floor.abs / 2, `${c.name}: tolerance below its floor`);
  }
  return { stages: doc.stages.length, exact: doc.stages.filter((c) => c.exact).length, images: doc.images.length };
}
