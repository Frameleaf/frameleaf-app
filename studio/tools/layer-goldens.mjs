// Layer-compositing goldens for the Studio render spec (studio/spec/layers.md, the native-app contract).
// Engine-free: the inputs, the case list (small project graphs), the validator and an independent
// reference renderer written from the prose of layers.md are defined here. layer-goldens.browser.mjs
// renders the cases through the real engine and writes studio/spec/goldens/layers.json.
import assert from 'node:assert/strict';
import { deflateSync, crc32 } from 'node:zlib';
import {
  EFFECT_SIZE, TRANSITION_SIZE, effectSdrInput, transitionInputs, encodeBuffer, decodeBuffer, sha256, compareCase,
} from './render-goldens.mjs';

export const LAYER_GOLDENS_FORMAT = 'frameleaf-studio-layer-goldens';
export const LAYER_GOLDENS_VERSION = 1;
export const FRAME = TRANSITION_SIZE; // 48 x 27, the default composition of a case
export const SMALL = EFFECT_SIZE; // 16 x 12, the composition of the blend cases
export const FPS = 30;
export const BLEND_MODES = [
  'normal', 'dissolve', 'darken', 'multiply', 'color-burn', 'linear-burn', 'lighten', 'screen', 'color-dodge',
  'linear-dodge', 'overlay', 'soft-light', 'hard-light', 'vivid-light', 'linear-light', 'pin-light', 'hard-mix',
  'difference', 'exclusion', 'subtract', 'divide', 'hue', 'saturation', 'color', 'luminosity',
];
export const SHAPE_TYPES = ['rectangle', 'circle', 'triangle', 'ellipse', 'star', 'polygon', 'heart', 'path'];

const q8 = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255) / 255;

/**
 * Blend layer input, 16x12, straight alpha, values k/255:
 *   R = (y + 0.5)/12, G = 1 - (x + 0.2)/16, B = (((3x + y) mod 5) + 0.5)/5, alpha 1
 *   x <= 3            alpha 0.5
 *   pixel (0, 0)      alpha 0
 * No channel is 0 or 1, and none is the complement of the effect input's channel at the same pixel,
 * so no blend case sits on a singular point of a mode (layers.md L9).
 */
export function blendLayerInput() {
  const { width: W, height: H } = SMALL;
  const out = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const a = x === 0 && y === 0 ? 0 : x <= 3 ? 0.5 : 1;
      out.push(q8((y + 0.5) / 12), q8(1 - (x + 0.2) / 16), q8((((3 * x + y) % 5) + 0.5) / 5), q8(a));
    }
  }
  return out;
}

/** The media a case may name by `mediaId`: id -> { width, height, values } (straight RGBA, k/255). */
export function layerInputs() {
  const t = transitionInputs();
  return {
    fx: { ...SMALL, values: effectSdrInput(), description: 'render-goldens.mjs effectSdrInput: 16 x 12, sRGB-encoded, straight alpha' },
    layer: { ...SMALL, values: blendLayerInput(), description: 'layer-goldens.mjs blendLayerInput: 16 x 12, sRGB-encoded, straight alpha' },
    a: { ...FRAME, values: t.a, description: 'render-goldens.mjs transitionInputs().a: 48 x 27, opaque' },
    b: { ...FRAME, values: t.b, description: 'render-goldens.mjs transitionInputs().b: 48 x 27, opaque' },
  };
}

/** A straight-alpha 8-bit RGBA PNG as a data URL (how the browser driver hands an input to the engine). */
export function pngDataUrl({ width, height, values }) {
  const stride = 1 + width * 4;
  const raw = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) for (let x = 0; x < width * 4; x++) raw[y * stride + 1 + x] = Math.round(values[y * width * 4 + x] * 255);
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const head = Buffer.alloc(4); head.writeUInt32BE(data.length);
    const tail = Buffer.alloc(4); tail.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([head, body, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const file = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  return `data:image/png;base64,${file.toString('base64')}`;
}

// ---- case construction: small project graphs in the form of protocol section 2 ----
const track = (id, order, extra = {}) => ({
  id, name: id, height: 100, locked: false, syncLock: true, visible: true, muted: false, solo: false, volume: 0, order, items: [], ...extra,
});
const base = (id, trackId, type, extra) => ({ id, trackId, from: 0, durationInFrames: 30, label: id, type, ...extra });
const T = (x, y, width, height, extra = {}) => ({ x, y, width, height, rotation: 0, opacity: 1, ...extra });
const image = (id, trackId, mediaId, transform, extra = {}) => {
  const size = mediaId === 'a' || mediaId === 'b' ? FRAME : SMALL;
  return base(id, trackId, 'image', { mediaId, sourceWidth: size.width, sourceHeight: size.height, ...(transform ? { transform } : {}), ...extra });
};
const shape = (id, trackId, shapeType, transform, extra = {}) => base(id, trackId, 'shape', { shapeType, fillColor: '#e6a23c', transform, ...extra });
const rect = (id, trackId, x, y, w, h, fillColor, extra = {}) => shape(id, trackId, 'rectangle', T(x, y, w, h), { fillColor, ...extra });
const backdrop = (trackId, mediaId = 'a') => image('backdrop', trackId, mediaId, T(0, 0, FRAME.width, FRAME.height));
const effect = (id, gpuEffectType, params) => ({ id, enabled: true, effect: { type: 'gpu-effect', gpuEffectType, params } });
const mask = (id, trackId, shapeType, transform, extra = {}) => shape(id, trackId, shapeType, transform, {
  fillColor: '#ffffff', isMask: true, blendMode: 'normal', maskType: 'clip', maskFeather: 0, maskOpacity: 100, maskInvert: false, ...extra,
});
const vertex = (x, y, inHandle = [0, 0], outHandle = [0, 0]) => ({ position: [x, y], inHandle, outHandle });
const graph = (size, tracks, items, extra = {}) => ({
  metadata: { width: size.width, height: size.height, fps: FPS, frameRate: { num: FPS, den: 1 }, ...(extra.backgroundColor !== undefined ? { backgroundColor: extra.backgroundColor } : {}) },
  timeline: { tracks, items, ...(extra.keyframes ? { keyframes: extra.keyframes } : {}) },
});
const BG = '#204060';
const TWO = () => [track('top', 0), track('bottom', 1)];
const THREE = () => [track('top', 0), track('middle', 1), track('bottom', 2)];

// The pen path used by the path shape and path mask cases: a closed four-vertex outline with two curved sides.
const PEN_CLOSED = [
  vertex(0.1, 0.9), vertex(0.25, 0.1, [0, 0], [0.2, -0.1]), vertex(0.9, 0.3, [-0.2, -0.2], [0, 0]), vertex(0.7, 0.9),
];
// An open three-vertex polyline with one sharp corner (caps, joins and the mitre limit).
const PEN_OPEN = [vertex(0.1, 0.85), vertex(0.5, 0.15), vertex(0.9, 0.85)];
const PEN_SHARP = [vertex(0.1, 0.8), vertex(0.9, 0.5), vertex(0.1, 0.35)];

/** Every case: { name, class, frame, graph, reference }. `reference` cases have a closed-form expectation. */
export function layerCases() {
  const cases = [];
  const add = (name, g, extra = {}) => cases.push({ name, class: name.split('/')[0], frame: 0, reference: false, graph: g, ...extra });
  const ref = (name, g, extra = {}) => add(name, g, { reference: true, ...extra });

  // Background and empty stretches.
  ref('background/default', graph(FRAME, [track('top', 0)], []));
  ref('background/opaque', graph(FRAME, [track('top', 0)], [], { backgroundColor: '#3366cc' }));
  ref('background/short-hex', graph(FRAME, [track('top', 0)], [], { backgroundColor: '#36c' }));
  ref('background/alpha', graph(FRAME, [track('top', 0)], [], { backgroundColor: '#3366cc80' }));
  ref('background/gap', graph(FRAME, [track('top', 0)], [{ ...rect('late', 'top', 0, 0.5, 20, 12, '#ff0000'), from: 10, durationInFrames: 5 }], { backgroundColor: BG }), { frame: 15 });
  ref('background/last-frame-of-item', graph(FRAME, [track('top', 0)], [{ ...rect('late', 'top', 0, 0.5, 20, 12, '#ff0000'), from: 10, durationInFrames: 5 }], { backgroundColor: BG }), { frame: 14 });

  // Layer order.
  const three = () => [
    rect('front', 'top', -8, -3.5, 20, 12, '#d03020'),
    rect('mid', 'middle', 0, 0.5, 20, 12, '#20a040', { transform: T(0, 0.5, 20, 12, { opacity: 0.5 }) }),
    rect('rear', 'bottom', 8, 4.5, 20, 12, '#3050e0'),
  ];
  ref('order/three-tracks', graph(FRAME, THREE(), three(), { backgroundColor: BG }));
  ref('order/hidden-track', graph(FRAME, [track('top', 0), track('middle', 1, { visible: false }), track('bottom', 2)], three(), { backgroundColor: BG }));
  ref('order/solo-track', graph(FRAME, [track('top', 0), track('middle', 1, { solo: true }), track('bottom', 2)], three(), { backgroundColor: BG }));
  ref('order/fractional-order', graph(FRAME, [track('top', 1.5), track('middle', 1), track('bottom', 2)], three(), { backgroundColor: BG }));
  ref('order/stored-order-is-not-layer-order', graph(FRAME, [track('bottom', 2), track('top', 0), track('middle', 1)], three().reverse(), { backgroundColor: BG }));

  // Opacity over a backdrop, with a translucent source.
  for (const opacity of [0, 0.5, 1]) {
    ref(`opacity/${opacity}`, graph(FRAME, TWO(), [image('clip', 'top', 'fx', T(0, 0.5, 16, 12, { opacity })), backdrop('bottom')], { backgroundColor: BG }));
  }

  // Every blend mode: the translucent blend layer over the translucent effect input, 16 x 12.
  for (const mode of BLEND_MODES) {
    ref(`blend/${mode}`, graph(SMALL, TWO(), [
      image('clip', 'top', 'layer', T(0, 0, 16, 12), { blendMode: mode }),
      image('under', 'bottom', 'fx', T(0, 0, 16, 12)),
    ], { backgroundColor: BG }));
  }
  ref('blend/multiply-opacity-0.5', graph(SMALL, TWO(), [
    image('clip', 'top', 'layer', T(0, 0, 16, 12, { opacity: 0.5 }), { blendMode: 'multiply' }),
    image('under', 'bottom', 'fx', T(0, 0, 16, 12)),
  ], { backgroundColor: BG }));
  ref('blend/screen-then-multiply', graph(SMALL, THREE(), [
    image('upper', 'top', 'layer', T(0, 0, 16, 12), { blendMode: 'multiply', transform: T(0, 0, 16, 12, { flipHorizontal: true }) }),
    image('clip', 'middle', 'layer', T(0, 0, 16, 12), { blendMode: 'screen' }),
    image('under', 'bottom', 'fx', T(0, 0, 16, 12)),
  ], { backgroundColor: BG }));
  ref('blend/unknown-mode-is-normal', graph(SMALL, TWO(), [
    image('clip', 'top', 'layer', T(0, 0, 16, 12), { blendMode: 'not-a-blend-mode' }),
    image('under', 'bottom', 'fx', T(0, 0, 16, 12)),
  ], { backgroundColor: BG }));

  // Transform.
  const over = (transform, extra = {}) => graph(FRAME, TWO(), [image('clip', 'top', 'fx', transform, extra), backdrop('bottom', 'b')], { backgroundColor: BG });
  ref('transform/identity', over(T(0, 0.5, 16, 12)));
  ref('transform/default-fit', over(undefined));
  ref('transform/translate-subpixel', over(T(5.25, -3.75, 16, 12)));
  ref('transform/scale-2', over(T(0, 0.5, 32, 24)));
  ref('transform/scale-half', over(T(-10, -5.5, 8, 6)));
  ref('transform/box-wider-than-source', over(T(0, 0.5, 40, 12)));
  add('transform/rotate-30', over(T(0, 0.5, 16, 12, { rotation: 30 })));
  add('transform/rotate-90', over(T(0, 0.5, 16, 12, { rotation: 90 })));
  add('transform/anchor-rotate-30', over(T(0, 0.5, 16, 12, { rotation: 30, anchorX: 0, anchorY: 0 })));
  add('transform/anchor-rotate-90', over(T(0, 0.5, 16, 12, { rotation: 90, anchorX: 0, anchorY: 12 })));
  add('transform/scale-rotate', over(T(4, 0.5, 24, 18, { rotation: 330 })));

  // Transform parents.
  const pose = (x, y, width, height, rotation = 0) => ({ x, y, width, height, rotation });
  ref('parent/translate-scale', graph(FRAME, THREE(), [
    // Bound when the parent was at (0, 0.5) 12 x 8; the parent now sits at (8, 2.5) and is 24 x 16.
    rect('child', 'top', -4, -1.5, 4, 4, '#ffffff', {
      transformParent: { parentItemId: 'parent', parentReference: pose(0, 0.5, 12, 8), childLocalReference: pose(-4, -1.5, 4, 4), childWorldReference: pose(-4, -1.5, 4, 4) },
    }),
    rect('parent', 'middle', 8, 2.5, 24, 16, '#d03020'),
    backdrop('bottom', 'b'),
  ], { backgroundColor: BG }));
  add('parent/rotated-chain', graph(FRAME, [track('top', 0), track('upper', 1), track('middle', 2), track('bottom', 3)], [
    rect('leaf', 'top', 10, 0.5, 6, 4, '#ffffff', {
      transformParent: { parentItemId: 'arm', parentReference: pose(0, 0.5, 20, 6), childLocalReference: pose(10, 0.5, 6, 4), childWorldReference: pose(10, 0.5, 6, 4) },
    }),
    rect('arm', 'upper', 0, 0.5, 20, 6, '#20a040', {
      transform: T(0, 0.5, 20, 6, { rotation: 20 }),
      transformParent: { parentItemId: 'root', parentReference: pose(0, 0.5, 30, 20), childLocalReference: pose(0, 0.5, 20, 6), childWorldReference: pose(0, 0.5, 20, 6) },
    }),
    rect('root', 'middle', 0, 0.5, 30, 20, '#d03020', { transform: T(-4, 0.5, 30, 20, { rotation: 15 }) }),
    backdrop('bottom', 'b'),
  ], { backgroundColor: BG }));
  ref('parent/opacity-is-not-inherited', graph(FRAME, THREE(), [
    rect('child', 'top', -4, -1.5, 4, 4, '#ffffff', {
      transformParent: { parentItemId: 'parent', parentReference: pose(0, 0.5, 12, 8), childLocalReference: pose(-4, -1.5, 4, 4), childWorldReference: pose(-4, -1.5, 4, 4) },
    }),
    rect('parent', 'middle', 8, 2.5, 12, 8, '#d03020', { transform: T(8, 2.5, 12, 8, { opacity: 0.25 }) }),
    backdrop('bottom', 'b'),
  ], { backgroundColor: BG }));
  ref('parent/missing-parent', graph(FRAME, TWO(), [
    rect('child', 'top', -4, -1.5, 4, 4, '#ffffff', {
      transformParent: { parentItemId: 'gone', parentReference: pose(0, 0.5, 12, 8), childLocalReference: pose(-4, -1.5, 4, 4), childWorldReference: pose(6, 4.5, 8, 6) },
    }),
    backdrop('bottom', 'b'),
  ], { backgroundColor: BG }));

  // Crop (the 16 x 12 input drawn at 32 x 24, so a ratio is a whole number of pixels).
  const cropped = (crop, transform = T(0, 0.5, 32, 24)) => over(transform, { crop });
  ref('crop/left', cropped({ left: 0.25 }));
  ref('crop/right', cropped({ right: 0.25 }));
  ref('crop/top', cropped({ top: 0.25 }));
  ref('crop/bottom', cropped({ bottom: 0.25 }));
  ref('crop/all-sides', cropped({ left: 0.125, right: 0.25, top: 0.25, bottom: 0.125 }));
  ref('crop/fractional-edge', cropped({ left: 0.2, top: 0.1 }));
  ref('crop/softness-inward', cropped({ left: 0.25, top: 0.25, softness: -0.25 }));
  ref('crop/softness-outward', cropped({ left: 0.25, top: 0.25, softness: 0.125 }));
  ref('crop/softness-without-crop', cropped({ softness: -0.25 }));
  add('crop/rotated', cropped({ left: 0.25, bottom: 0.25 }, T(0, 0.5, 32, 24, { rotation: 30 })));

  // Corner radius of the item box.
  add('corner-radius/4', over(T(0, 0.5, 32, 24, { cornerRadius: 4 })));
  add('corner-radius/clamped', over(T(0, 0.5, 32, 24, { cornerRadius: 40 })));
  add('corner-radius/box-not-picture', over(T(0, 0.5, 40, 12, { cornerRadius: 5 })));

  // Flips.
  ref('flip/horizontal', over(T(0, 0.5, 16, 12, { flipHorizontal: true })));
  ref('flip/vertical', over(T(0, 0.5, 16, 12, { flipVertical: true })));
  ref('flip/both-cropped', over(T(0, 0.5, 32, 24, { flipHorizontal: true, flipVertical: true }), { crop: { left: 0.25, top: 0.25 } }));
  add('flip/horizontal-rotated', over(T(0, 0.5, 16, 12, { flipHorizontal: true, rotation: 30 })));

  // Corner pin.
  add('corner-pin/image', over(T(0, 0.5, 32, 24), { cornerPin: { topLeft: [4, 2], topRight: [-2, 5], bottomRight: [0, 0], bottomLeft: [6, -3], referenceWidth: 32, referenceHeight: 24 } }));
  add('corner-pin/reference-size', over(T(0, 0.5, 32, 24), { cornerPin: { topLeft: [2, 1], topRight: [-1, 2.5], bottomRight: [0, 0], bottomLeft: [3, -1.5], referenceWidth: 16, referenceHeight: 12 } }));

  // Stage order: the transform precedes the effect stack.
  ref('stage/pixelate-scaled', over(T(1, 0.5, 32, 24), { effects: [effect('px', 'gpu-pixelate', { size: 4 })] }));
  ref('stage/pixelate-translated', over(T(5, 2.5, 16, 12), { effects: [effect('px', 'gpu-pixelate', { size: 4 })] }));
  ref('stage/pixelate-opacity', over(T(1, 0.5, 32, 24, { opacity: 0.5 }), { effects: [effect('px', 'gpu-pixelate', { size: 4 })] }));
  add('stage/pixelate-rotated-cropped', over(T(1, 0.5, 32, 24, { rotation: 30 }), { crop: { left: 0.25 }, effects: [effect('px', 'gpu-pixelate', { size: 4 })] }));
  add('stage/wave-rotated', over(T(0, 0.5, 32, 24, { rotation: 30 }), { effects: [effect('wv', 'gpu-wave', { amplitude: 0.05, frequency: 4, speed: 0, angle: 0 })] }));
  ref('stage/adjustment-layer', graph(FRAME, THREE(), [
    base('adjust', 'top', 'adjustment', { effects: [effect('px', 'gpu-pixelate', { size: 4 })] }),
    image('clip', 'middle', 'fx', T(1, 0.5, 32, 24)),
    backdrop('bottom', 'b'),
  ], { backgroundColor: BG }));
  ref('stage/adjustment-layer-not-above', graph(FRAME, THREE(), [
    image('clip', 'top', 'fx', T(1, 0.5, 32, 24)),
    base('adjust', 'middle', 'adjustment', { effects: [effect('px', 'gpu-pixelate', { size: 4 })] }),
    rect('floor', 'bottom', 0, 0, 48, 27, BG),
  ], { backgroundColor: BG }));

  // Masks: a shape with isMask masks the tracks below it.
  const masked = (m, extra = []) => graph(FRAME, THREE(), [m, ...extra, backdrop('bottom')], { backgroundColor: BG });
  const box = T(-3.5, 1, 25, 15);
  ref('mask/clip', masked(mask('m', 'top', 'rectangle', box)));
  ref('mask/clip-invert', masked(mask('m', 'top', 'rectangle', box, { maskInvert: true })));
  ref('mask/clip-ignores-feather', masked(mask('m', 'top', 'rectangle', box, { maskFeather: 6 })));
  ref('mask/alpha', masked(mask('m', 'top', 'rectangle', box, { maskType: 'alpha' })));
  ref('mask/alpha-invert', masked(mask('m', 'top', 'rectangle', box, { maskType: 'alpha', maskInvert: true })));
  ref('mask/opacity-50', masked(mask('m', 'top', 'rectangle', box, { maskOpacity: 50 })));
  ref('mask/opacity-50-invert', masked(mask('m', 'top', 'rectangle', box, { maskOpacity: 50, maskInvert: true })));
  ref('mask/item-opacity-scales-the-matte', masked(mask('m', 'top', 'rectangle', { ...box, opacity: 0.5 }, { maskType: 'alpha' })));
  ref('mask/feather-2', masked(mask('m', 'top', 'rectangle', box, { maskType: 'alpha', maskFeather: 2 })));
  ref('mask/feather-6', masked(mask('m', 'top', 'rectangle', box, { maskType: 'alpha', maskFeather: 6 })));
  ref('mask/feather-2-invert', masked(mask('m', 'top', 'rectangle', box, { maskType: 'alpha', maskFeather: 2, maskInvert: true })));
  add('mask/clip-ellipse', masked(mask('m', 'top', 'ellipse', T(0, 0.5, 30, 18))));
  add('mask/alpha-ellipse', masked(mask('m', 'top', 'ellipse', T(0, 0.5, 30, 18), { maskType: 'alpha' })));
  add('mask/clip-rotated', masked(mask('m', 'top', 'rectangle', T(0, 0.5, 24, 12, { rotation: 30 }))));
  add('mask/path', masked(mask('m', 'top', 'path', T(0, 0.5, 30, 20), { pathVertices: PEN_CLOSED, pathClosed: true })));
  add('mask/open-path-is-closed', masked(mask('m', 'top', 'path', T(0, 0.5, 30, 20), { pathVertices: PEN_OPEN, pathClosed: false })));
  ref('mask/two-masks-intersect', graph(FRAME, THREE(), [
    mask('m1', 'top', 'rectangle', T(-5.5, 1, 21, 15)), mask('m2', 'middle', 'rectangle', T(5.5, -1, 21, 15)), backdrop('bottom'),
  ], { backgroundColor: BG }));
  ref('mask/scope', graph(FRAME, [track('top', 0), track('middle', 1), track('lower', 2), track('bottom', 3)], [
    rect('above', 'top', -16, -7.5, 8, 6, '#ffffff'),
    mask('m', 'middle', 'rectangle', box), rect('beside', 'middle', 16, -7.5, 8, 6, '#ffffff'),
    rect('below', 'lower', 16, 7.5, 8, 6, '#ffffff'),
    backdrop('bottom'),
  ], { backgroundColor: BG }));
  ref('mask/translucent-item', masked(mask('m', 'top', 'rectangle', box, { maskType: 'alpha' }), [image('clip', 'middle', 'fx', T(0, 0.5, 32, 24))]));
  ref('mask/hidden-track-mask', graph(FRAME, [track('top', 0, { visible: false }), track('middle', 1), track('bottom', 2)], [mask('m', 'top', 'rectangle', box), backdrop('bottom')], { backgroundColor: BG }));
  add('mask/animated-path', masked(mask('m', 'top', 'path', T(0, 0.5, 30, 20), { pathVertices: PEN_CLOSED, pathClosed: true }), []), { frame: 5 });
  cases.at(-1).graph.timeline.keyframes = [{ itemId: 'm', properties: [
    { property: 'pathVertex:1:positionY', keyframes: [{ id: 'k0', frame: 0, value: 0.1, easing: 'linear' }, { id: 'k1', frame: 10, value: 0.5, easing: 'linear' }] },
  ] }];

  // Shapes: every type with fill only, stroke only and both.
  const shapeBox = { rectangle: T(0, 0.5, 30, 18), ellipse: T(0, 0.5, 30, 18) };
  const stroke = { strokeEnabled: true, strokeWidth: 4, strokeColor: '#1c2a6b' };
  const typeExtra = (type) => (type === 'path' ? { pathVertices: PEN_CLOSED, pathClosed: true } : {});
  for (const type of SHAPE_TYPES) {
    const t = shapeBox[type] ?? T(0, 0.5, 30, 20);
    const g = (extra) => graph(FRAME, TWO(), [shape('s', 'top', type, t, { ...typeExtra(type), ...extra }), backdrop('bottom', 'b')], { backgroundColor: BG });
    (type === 'rectangle' ? ref : add)(`shape/${type}/fill`, g({ strokeEnabled: false }));
    (type === 'rectangle' ? ref : add)(`shape/${type}/stroke`, g({ fillEnabled: false, ...stroke }));
    (type === 'rectangle' ? ref : add)(`shape/${type}/fill-stroke`, g(stroke));
  }
  const one = (type, t, extra) => graph(FRAME, TWO(), [shape('s', 'top', type, t, extra), backdrop('bottom', 'b')], { backgroundColor: BG });
  ref('shape/rectangle/subpixel', one('rectangle', T(0.25, 0.75, 20.5, 11), { strokeEnabled: false }));
  ref('shape/rectangle/translucent-fill', one('rectangle', T(0, 0.5, 30, 18), { fillColor: '#e6a23c80', strokeEnabled: false }));
  ref('shape/rectangle/translucent-stroke', one('rectangle', T(0, 0.5, 30, 18), { ...stroke, strokeColor: '#1c2a6b80' }));
  ref('shape/rectangle/translucent-fill-stroke-opacity', one('rectangle', T(0, 0.5, 30, 18, { opacity: 0.5 }), { ...stroke, fillColor: '#e6a23c80', strokeColor: '#1c2a6bc0' }));
  // Values outside the ranges a client writes: what the renderer does with them when it reads a graph.
  add('shape/star/inner-radius-1.5', one('star', T(0, 0.5, 30, 22), { points: 5, innerRadius: 1.5, strokeEnabled: false }));
  add('shape/star/points-5.5', one('star', T(0, 0.5, 30, 22), { points: 5.5, strokeEnabled: false }));
  add('shape/star/points-20', one('star', T(0, 0.5, 30, 22), { points: 20, strokeEnabled: false }));
  add('shape/polygon/points-2', one('polygon', T(0, 0.5, 30, 22), { points: 2, ...stroke }));
  add('shape/rectangle/linear-gradient-alpha', one('rectangle', T(0, 0.5, 30, 18), { fillType: 'linear', gradientStartColor: '#FF000040', gradientEndColor: '#0000ffff', gradientAngle: 0, strokeEnabled: false }));
  add('shape/rectangle/linear-gradient-405', one('rectangle', T(0, 0.5, 30, 18), { fillType: 'linear', gradientStartColor: '#ff0000', gradientEndColor: '#0000ff', gradientAngle: 405, strokeEnabled: false }));
  ref('shape/rectangle/opacity-fill-stroke', one('rectangle', T(0, 0.5, 30, 18, { opacity: 0.5 }), stroke));
  ref('shape/rectangle/stroke-without-color', one('rectangle', T(0, 0.5, 30, 18), { strokeEnabled: true, strokeWidth: 3 }));
  add('shape/rectangle/corner-radius', one('rectangle', T(0, 0.5, 30, 18), { cornerRadius: 5, ...stroke }));
  add('shape/rectangle/corner-radius-clamped', one('rectangle', T(0, 0.5, 30, 18), { cornerRadius: 50, strokeEnabled: false }));
  add('shape/rectangle/transform-corner-radius-clips', one('rectangle', T(0, 0.5, 30, 18, { cornerRadius: 5 }), stroke));
  add('shape/rectangle/rotated', one('rectangle', T(0, 0.5, 24, 12, { rotation: 30 }), stroke));
  add('shape/rectangle/linear-gradient', one('rectangle', T(0, 0.5, 30, 18), { fillType: 'linear', gradientStartColor: '#ff0000', gradientEndColor: '#0000ff', gradientAngle: 0, strokeEnabled: false }));
  add('shape/rectangle/linear-gradient-45', one('rectangle', T(0, 0.5, 30, 18), { fillType: 'linear', gradientStartColor: '#ff0000', gradientEndColor: '#0000ff', gradientAngle: 45, strokeEnabled: false }));
  add('shape/circle/unlocked', one('circle', { ...T(0, 0.5, 36, 18), aspectRatioLocked: false }, stroke));
  for (const direction of ['down', 'left', 'right']) add(`shape/triangle/${direction}`, one('triangle', T(0, 0.5, 30, 20), { direction, strokeEnabled: false }));
  add('shape/triangle/unlocked', one('triangle', { ...T(0, 0.5, 36, 14), aspectRatioLocked: false }, { strokeEnabled: false }));
  add('shape/triangle/corner-radius', one('triangle', T(0, 0.5, 30, 20), { cornerRadius: 3, strokeEnabled: false }));
  add('shape/star/points-7-inner-0.3', one('star', T(0, 0.5, 30, 22), { points: 7, innerRadius: 0.3, strokeEnabled: false }));
  add('shape/star/unlocked', one('star', { ...T(0, 0.5, 40, 16), aspectRatioLocked: false }, { strokeEnabled: false }));
  add('shape/polygon/points-3', one('polygon', T(0, 0.5, 30, 22), { points: 3, strokeEnabled: false }));
  add('shape/polygon/points-8-corner-radius', one('polygon', T(0, 0.5, 30, 22), { points: 8, cornerRadius: 2, strokeEnabled: false }));
  add('shape/heart/unlocked', one('heart', { ...T(0, 0.5, 40, 16), aspectRatioLocked: false }, { strokeEnabled: false }));
  add('shape/path/open', one('path', T(0, 0.5, 30, 20), { pathVertices: PEN_OPEN, pathClosed: false, ...stroke }));
  add('shape/path/open-ignores-fill', one('path', T(0, 0.5, 30, 20), { pathVertices: PEN_OPEN, pathClosed: false, fillEnabled: true, strokeEnabled: false }));
  add('shape/path/closed-straight', one('path', T(0, 0.5, 30, 20), { pathVertices: PEN_OPEN, pathClosed: true, ...stroke }));
  for (const cap of ['butt', 'round', 'square']) add(`shape/path/cap-${cap}`, one('path', T(0, 0.5, 30, 20), { pathVertices: PEN_OPEN, pathClosed: false, fillEnabled: false, strokeEnabled: true, strokeWidth: 5, strokeColor: '#1c2a6b', strokeLineCap: cap, strokeLineJoin: 'round' }));
  for (const join of ['miter', 'round', 'bevel']) add(`shape/path/join-${join}`, one('path', T(0, 0.5, 30, 20), { pathVertices: PEN_OPEN, pathClosed: false, fillEnabled: false, strokeEnabled: true, strokeWidth: 5, strokeColor: '#1c2a6b', strokeLineJoin: join }));
  for (const limit of [1, 4, 10]) add(`shape/path/miter-limit-${limit}`, one('path', T(0, 0.5, 30, 20), { pathVertices: PEN_SHARP, pathClosed: false, fillEnabled: false, strokeEnabled: true, strokeWidth: 3, strokeColor: '#1c2a6b', strokeLineJoin: 'miter', strokeMiterLimit: limit }));
  add('shape/rectangle/trim-25-75', one('rectangle', T(0, 0.5, 30, 18), { fillEnabled: false, ...stroke, trimPathStart: 25, trimPathEnd: 75 }));
  add('shape/rectangle/trim-offset-90', one('rectangle', T(0, 0.5, 30, 18), { fillEnabled: false, ...stroke, trimPathStart: 0, trimPathEnd: 50, trimPathOffset: 90 }));
  add('shape/rectangle/trim-wraps', one('rectangle', T(0, 0.5, 30, 18), { fillEnabled: false, ...stroke, trimPathStart: 75, trimPathEnd: 25 }));
  add('shape/ellipse/trim-0-50', one('ellipse', T(0, 0.5, 30, 18), { fillEnabled: false, ...stroke, trimPathStart: 0, trimPathEnd: 50 }));
  add('shape/path/trim-20-80', one('path', T(0, 0.5, 30, 20), { pathVertices: PEN_OPEN, pathClosed: false, fillEnabled: false, ...stroke, trimPathStart: 20, trimPathEnd: 80 }));
  add('shape/path/taper', one('path', T(0, 0.5, 30, 20), { pathVertices: PEN_OPEN, pathClosed: false, fillEnabled: false, strokeEnabled: true, strokeWidth: 6, strokeColor: '#1c2a6b', taperStartWidth: 0, taperStartLength: 40, taperEndWidth: 50, taperEndLength: 30 }));
  add('shape/rectangle/taper', one('rectangle', T(0, 0.5, 30, 18), { fillEnabled: false, strokeEnabled: true, strokeWidth: 6, strokeColor: '#1c2a6b', taperStartWidth: 0, taperStartLength: 50 }));
  return cases;
}

// ---- the reference renderer: sections L1 to L13 of studio/spec/layers.md, in binary64 ----
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const clamp01 = (v) => clamp(v, 0, 1);
function hexColour(text) {
  let value = String(text).trim().replace(/^#/, '');
  if (value.length === 3 || value.length === 4) value = [...value].map((c) => c + c).join('');
  assert(/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value), `reference: colour ${text}`);
  const at = (i) => parseInt(value.slice(i, i + 2), 16) / 255;
  return [at(0), at(2), at(4), value.length === 8 ? at(6) : 1];
}
// Area of pixel (i, j) covered by the axis-aligned rectangle [l, r) x [t, b).
const overlap = (lo, hi, i) => Math.max(0, Math.min(hi, i + 1) - Math.max(lo, i));
const erf = (x) => {
  const s = Math.sign(x); const a = Math.abs(x); const t = 1 / (1 + 0.3275911 * a);
  return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a));
};
// A Gaussian of deviation sigma convolved with the indicator of [lo, hi), at x.
const blurredSpan = (lo, hi, x, sigma) => 0.5 * (erf((hi - x) / (sigma * Math.SQRT2)) - erf((lo - x) / (sigma * Math.SQRT2)));

function resolveBox(item, size, source) {
  const t = item.transform ?? {};
  const fit = source ? Math.min(size.width / source.width, size.height / source.height) : 1;
  const width = t.width ?? (source ? source.width * fit : size.width);
  const height = t.height ?? (source ? source.height * fit : size.height);
  return { x: t.x ?? 0, y: t.y ?? 0, width, height, rotation: t.rotation ?? 0, opacity: clamp01(t.opacity ?? 1), cornerRadius: t.cornerRadius ?? 0,
    anchorX: t.anchorX ?? width / 2, anchorY: t.anchorY ?? height / 2 };
}
// L7: pose matrices and the parent chain.
const poseMatrix = (p) => {
  const r = (p.rotation * Math.PI) / 180;
  return [Math.cos(r) * p.width, Math.sin(r) * p.width, -Math.sin(r) * p.height, Math.cos(r) * p.height, p.x, p.y];
};
const mul = (l, r) => [l[0] * r[0] + l[2] * r[1], l[1] * r[0] + l[3] * r[1], l[0] * r[2] + l[2] * r[3], l[1] * r[2] + l[3] * r[3], l[0] * r[4] + l[2] * r[5] + l[4], l[1] * r[4] + l[3] * r[5] + l[5]];
const inv = (m) => {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-6) return null;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
};
function worldBox(item, items, size, sources, active = new Set()) {
  const local = resolveBox(item, size, sources[item.mediaId]);
  const binding = item.transformParent;
  if (!binding || active.has(item.id)) return local;
  active.add(item.id);
  const localRef = inv(poseMatrix(binding.childLocalReference));
  let m = localRef ? mul(poseMatrix(binding.childWorldReference), mul(localRef, poseMatrix(local))) : poseMatrix(local);
  const parent = binding.parentItemId ? items.find((x) => x.id === binding.parentItemId) : undefined;
  if (parent && binding.parentReference) {
    const parentRef = inv(poseMatrix(binding.parentReference));
    if (parentRef) m = mul(mul(poseMatrix(worldBox(parent, items, size, sources, active)), parentRef), m);
  }
  active.delete(item.id);
  const width = Math.max(1e-6, Math.hypot(m[0], m[1]));
  const height = Math.max(1e-6, Math.abs(m[0] * m[3] - m[1] * m[2]) / width);
  return { ...local, x: m[4], y: m[5], width, height, rotation: (Math.atan2(m[1], m[0]) * 180) / Math.PI,
    anchorX: local.anchorX * (width / local.width), anchorY: local.anchorY * (height / local.height) };
}
const axisAligned = (box) => Math.abs(box.rotation) < 1e-9;

// One layer: premultiplied RGBA of composition size.
function rectangleLayer(item, box, size) {
  assert(axisAligned(box), `reference: ${item.id} is rotated`);
  const { width: W, height: H } = size;
  const out = new Float64Array(W * H * 4);
  const left = W / 2 + box.x - box.width / 2;
  const top = H / 2 + box.y - box.height / 2;
  const paint = (colour, coverage) => {
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const a = colour[3] * coverage(i, j) * box.opacity;
      if (a <= 0) continue;
      const at = (j * W + i) * 4;
      for (let c = 0; c < 3; c++) out[at + c] = colour[c] * a + out[at + c] * (1 - a);
      out[at + 3] = a + out[at + 3] * (1 - a);
    }
  };
  const area = (l, t, r, b) => (i, j) => (r > l && b > t ? overlap(l, r, i) * overlap(t, b, j) : 0);
  if ((item.fillEnabled ?? true) && item.fillColor) paint(hexColour(item.fillColor), area(left, top, left + box.width, top + box.height));
  const sw = item.strokeWidth;
  if ((item.strokeEnabled ?? true) && typeof sw === 'number' && sw > 0 && item.strokeColor) {
    const outer = area(left - sw / 2, top - sw / 2, left + box.width + sw / 2, top + box.height + sw / 2);
    const inner = area(left + sw / 2, top + sw / 2, left + box.width - sw / 2, top + box.height - sw / 2);
    paint(hexColour(item.strokeColor), (i, j) => outer(i, j) - inner(i, j));
  }
  return out;
}
function cropOf(crop = {}) {
  const pair = (a, b) => (a + b <= 0.999 ? [a, b] : [(a * 0.999) / (a + b), (b * 0.999) / (a + b)]);
  const [left, right] = pair(clamp01(crop.left ?? 0), clamp01(crop.right ?? 0));
  const [top, bottom] = pair(clamp01(crop.top ?? 0), clamp01(crop.bottom ?? 0));
  return { left, right, top, bottom, softness: clamp(crop.softness ?? 0, -1, 1) };
}
function imageLayer(item, box, size, source) {
  assert(axisAligned(box), `reference: ${item.id} is rotated`);
  const { width: W, height: H } = size;
  const out = new Float64Array(W * H * 4);
  const left = W / 2 + box.x - box.width / 2;
  const top = H / 2 + box.y - box.height / 2;
  // L5: contain fit, then crop inside the fitted picture.
  const fit = Math.min(box.width / source.width, box.height / source.height);
  const mw = source.width * fit;
  const mh = source.height * fit;
  const mx = left + (box.width - mw) / 2;
  const my = top + (box.height - mh) / 2;
  const crop = cropOf(item.crop);
  const px = { left: mw * crop.left, right: mw * crop.right, top: mh * crop.top, bottom: mh * crop.bottom };
  const raw = crop.softness * Math.min(mw, mh);
  const soft = Math.abs(raw);
  const grow = Object.fromEntries(Object.entries(px).map(([side, v]) => [side, raw > 0 && v > 0 ? Math.min(soft, v) : 0]));
  const x0 = Math.floor(mx + px.left - grow.left);
  const y0 = Math.floor(my + px.top - grow.top);
  const x1 = Math.ceil(mx + mw - px.right + grow.right);
  const y1 = Math.ceil(my + mh - px.bottom + grow.bottom);
  const feather = Object.fromEntries(Object.entries(px).map(([side, v]) => [side, v > 0 ? (raw > 0 ? grow[side] : soft) : 0]));
  const fitPair = (a, b, span) => {
    const ca = clamp(a, 0, span); const cb = clamp(b, 0, span);
    return ca + cb <= span ? [ca, cb] : [(ca * span) / (ca + cb), (cb * span) / (ca + cb)];
  };
  const [fl, fr] = fitPair(feather.left, feather.right, x1 - x0);
  const [ft, fb] = fitPair(feather.top, feather.bottom, y1 - y0);
  const texel = (sx, sy) => {
    const at = (clamp(sy, 0, source.height - 1) * source.width + clamp(sx, 0, source.width - 1)) * 4;
    const a = source.values[at + 3];
    return [source.values[at] * a, source.values[at + 1] * a, source.values[at + 2] * a, a];
  };
  for (let j = Math.max(0, y0); j < Math.min(H, y1); j++) for (let i = Math.max(0, x0); i < Math.min(W, x1); i++) {
    const cx = i + 0.5;
    const cy = j + 0.5;
    if (cx < mx || cx >= mx + mw || cy < my || cy >= my + mh) continue;
    const u = ((cx - mx) / mw) * source.width - 0.5;
    const v = ((cy - my) / mh) * source.height - 0.5;
    const u0 = Math.floor(u); const v0 = Math.floor(v); const fu = u - u0; const fv = v - v0;
    let ramp = box.opacity;
    if (fl > 0) ramp *= clamp01((cx - x0) / fl);
    if (fr > 0) ramp *= clamp01((x1 - cx) / fr);
    if (ft > 0) ramp *= clamp01((cy - y0) / ft);
    if (fb > 0) ramp *= clamp01((y1 - cy) / fb);
    const taps = [[texel(u0, v0), (1 - fu) * (1 - fv)], [texel(u0 + 1, v0), fu * (1 - fv)], [texel(u0, v0 + 1), (1 - fu) * fv], [texel(u0 + 1, v0 + 1), fu * fv]];
    const at = (j * W + i) * 4;
    for (let c = 0; c < 4; c++) out[at + c] = taps.reduce((sum, [tap, w]) => sum + tap[c] * w, 0) * ramp;
  }
  // L6: flips mirror the drawn item about its anchor point.
  const t = item.transform ?? {};
  const mirror = (buffer, horizontal) => {
    const axis = 2 * (horizontal ? left + box.anchorX : top + box.anchorY);
    assert(Number.isInteger(axis), `reference: ${item.id} flips off the pixel grid`);
    const flipped = new Float64Array(buffer.length);
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const si = horizontal ? axis - 1 - i : i;
      const sj = horizontal ? j : axis - 1 - j;
      if (si < 0 || si >= W || sj < 0 || sj >= H) continue;
      for (let c = 0; c < 4; c++) flipped[(j * W + i) * 4 + c] = buffer[(sj * W + si) * 4 + c];
    }
    return flipped;
  };
  let layer = out;
  if (t.flipHorizontal) layer = mirror(layer, true);
  if (t.flipVertical) layer = mirror(layer, false);
  return layer;
}
// L3: an item's layer is 8-bit premultiplied; read as straight colour it is rounded to 8 bits again.
const quantise = (layer) => layer.map((v) => Math.round(clamp01(v) * 255) / 255);
function straight8(layer, at) {
  const a8 = Math.round(layer[at + 3] * 255);
  if (a8 <= 0) return [0, 0, 0, 0];
  return [...[0, 1, 2].map((c) => Math.min(255, Math.round((Math.round(layer[at + c] * 255) * 255) / a8)) / 255), a8 / 255];
}
// gpu-pixelate (studio/spec/effects/gpu-pixelate.md) on a straight-alpha layer of composition size.
function pixelate(layer, size, s) {
  const { width: W, height: H } = size;
  const straight = (i, j) => straight8(layer, (clamp(j, 0, H - 1) * W + clamp(i, 0, W - 1)) * 4);
  const out = new Float64Array(layer.length);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const x = Math.floor((i + 0.5) / s) * s + s / 2 - 0.5;
    const y = Math.floor((j + 0.5) / s) * s + s / 2 - 0.5;
    const x0 = Math.floor(x); const y0 = Math.floor(y); const fx = x - x0; const fy = y - y0;
    const taps = [[straight(x0, y0), (1 - fx) * (1 - fy)], [straight(x0 + 1, y0), fx * (1 - fy)], [straight(x0, y0 + 1), (1 - fx) * fy], [straight(x0 + 1, y0 + 1), fx * fy]];
    const sample = [0, 1, 2, 3].map((c) => taps.reduce((sum, [tap, w]) => sum + tap[c] * w, 0));
    const at = (j * W + i) * 4;
    for (let c = 0; c < 3; c++) out[at + c] = sample[c] * sample[3];
    out[at + 3] = sample[3];
  }
  return out;
}
// L10: the matte of one rectangle mask at pixel (i, j).
function matte(m, box, size) {
  assert(axisAligned(box) && m.shapeType === 'rectangle', 'reference: only axis-aligned rectangle masks');
  const { width: W, height: H } = size;
  const l = W / 2 + box.x - box.width / 2;
  const t = H / 2 + box.y - box.height / 2;
  const r = l + box.width;
  const b = t + box.height;
  const type = m.maskType ?? 'clip';
  const feather = type === 'alpha' ? (m.maskFeather ?? 0) : 0;
  const strength = (clamp(m.maskOpacity ?? 100, 0, 100) / 100) * box.opacity;
  const invert = m.maskInvert ?? false;
  if (type === 'clip' && strength === 1) {
    return (i, j) => { const inside = i + 0.5 >= l && i + 0.5 < r && j + 0.5 >= t && j + 0.5 < b; return (inside !== invert) ? 1 : 0; };
  }
  if (feather <= 0) return (i, j) => { const cover = overlap(l, r, i) * overlap(t, b, j); return (invert ? 1 - cover : cover) * strength; };
  // The matte is blurred inside the frame: outside the frame it is empty, which shows on an inverted mask.
  return (i, j) => {
    const cover = blurredSpan(l, r, i + 0.5, feather) * blurredSpan(t, b, j + 0.5, feather);
    const frame = blurredSpan(0, W, i + 0.5, feather) * blurredSpan(0, H, j + 0.5, feather);
    return (invert ? frame - cover : cover) * strength;
  };
}
// L9: blend functions on encoded values in [0, 1].
const hsl = ([r, g, b]) => {
  const mx = Math.max(r, g, b); const mn = Math.min(r, g, b); const l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn;
  // L9: the compositor's saturation uses M + m above mid lightness and 2 - M - m below (not the C7 helper).
  const s = l > 0.5 ? d / (mx + mn) : d / (2 - mx - mn);
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
};
const hue = (p, q, t0) => {
  let t = t0; if (t < 0) t += 1; if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
};
const rgbOfHsl = ([h, s, l]) => {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue(p, q, h + 1 / 3), hue(p, q, h), hue(p, q, h - 1 / 3)];
};
const lum = ([r, g, b]) => 0.3 * r + 0.59 * g + 0.11 * b;
const setLum = (c, l) => {
  const d = l - lum(c);
  let r = c.map((v) => v + d);
  const mn = Math.min(...r); const mx = Math.max(...r); const ll = lum(r);
  if (mn < 0) r = r.map((v) => ll + ((v - ll) * ll) / (ll - mn));
  if (mx > 1) r = r.map((v) => ll + ((v - ll) * (1 - ll)) / (mx - ll));
  return r;
};
const f32 = Math.fround;
const burn = (b, l) => (l === 0 ? 0 : 1 - Math.min(1, (1 - b) / Math.max(l, 0.001)));
const dodge = (b, l) => (l === 1 ? 1 : Math.min(1, b / Math.max(1 - l, 0.001)));
const CHANNEL = {
  normal: (b, l) => l, dissolve: (b, l) => l,
  darken: (b, l) => Math.min(b, l), multiply: (b, l) => b * l, 'color-burn': burn, 'linear-burn': (b, l) => Math.max(b + l - 1, 0),
  lighten: (b, l) => Math.max(b, l), screen: (b, l) => 1 - (1 - b) * (1 - l), 'color-dodge': dodge, 'linear-dodge': (b, l) => Math.min(b + l, 1),
  overlay: (b, l) => (b <= 0.5 ? 2 * b * l : 1 - 2 * (1 - b) * (1 - l)),
  'soft-light': (b, l) => (l <= 0.5 ? b - (1 - 2 * l) * b * (1 - b) : b + (2 * l - 1) * (Math.sqrt(b) - b)),
  'hard-light': (b, l) => (l <= 0.5 ? 2 * b * l : 1 - 2 * (1 - b) * (1 - l)),
  'vivid-light': (b, l) => (l <= 0.5 ? burn(b, 2 * l) : dodge(b, 2 * (l - 0.5))),
  'linear-light': (b, l) => clamp01(b + 2 * l - 1),
  'pin-light': (b, l) => (l <= 0.5 ? Math.min(b, 2 * l) : Math.max(b, 2 * (l - 0.5))),
  'hard-mix': (b, l) => (f32(f32(b) + f32(l)) >= 1 ? 1 : 0),
  difference: (b, l) => Math.abs(b - l), exclusion: (b, l) => b + l - 2 * b * l, subtract: (b, l) => Math.max(b - l, 0),
  divide: (b, l) => Math.min(b / Math.max(l, 0.001), 1),
};
// L9: where a mode is discontinuous exactly at the given values, the engine's result is implementation-defined.
const SINGULAR = {
  'color-burn': (b, l) => b === 1 && l === 0,
  'color-dodge': (b, l) => b === 0 && l === 1,
  'vivid-light': (b, l) => (b === 1 && l === 0) || (b === 0 && l === 1),
  'hard-mix': (b, l) => Math.abs(b + l - 1) < 1e-9,
};
export function blendColour(mode, backdropRgb, layerRgb, singular) {
  const b = backdropRgb.map(clamp01);
  const l = layerRgb.map(clamp01);
  if (singular && SINGULAR[mode] && b.some((v, c) => SINGULAR[mode](v, l[c]))) singular();
  if (mode === 'hue') return rgbOfHsl([hsl(l)[0], hsl(b)[1], hsl(b)[2]]);
  if (mode === 'saturation') return rgbOfHsl([hsl(b)[0], hsl(l)[1], hsl(b)[2]]);
  if (mode === 'color') return setLum(rgbOfHsl([hsl(l)[0], hsl(l)[1], 0.5]), lum(b));
  if (mode === 'luminosity') return setLum(b, lum(l));
  const channel = CHANNEL[mode] ?? CHANNEL.normal;
  return b.map((v, c) => channel(v, l[c]));
}
// L9: the dissolve threshold of pixel (i, j) in a W x H frame, in binary32.
export function dissolveThreshold(i, j, W, H) {
  const fract = (v) => f32(v - Math.floor(v));
  const px = f32(f32((i + 0.5) / W) * 8192);
  const py = f32(f32((j + 0.5) / H) * 8192);
  const p = [fract(f32(px * f32(0.1031))), fract(f32(py * f32(0.1031))), fract(f32(px * f32(0.1031)))];
  const d = f32(f32(f32(p[0] * f32(p[1] + f32(33.33))) + f32(p[1] * f32(p[2] + f32(33.33)))) + f32(p[2] * f32(p[0] + f32(33.33))));
  const q = p.map((v) => f32(v + d));
  return fract(f32(f32(q[0] + q[1]) * q[2]));
}

/** The frame of a `reference` case from the prose of layers.md: straight RGBA, row-major. */
export function referenceFrame(spec, inputs = layerInputs(), guarded = []) {
  const { metadata, timeline } = spec.graph;
  const size = { width: metadata.width, height: metadata.height };
  const { width: W, height: H } = size;
  const frame = spec.frame;
  // L2: visible tracks, bottom (largest order) first; a solo track hides every track that is not solo.
  const solo = timeline.tracks.some((t) => t.solo);
  const tracks = timeline.tracks.filter((t) => (solo ? t.solo : t.visible !== false)).sort((p, q) => q.order - p.order);
  const active = (item) => frame >= item.from && frame < item.from + item.durationInFrames;
  const onTrack = (t) => timeline.items.filter((item) => item.trackId === t.id && active(item));
  const masks = tracks.flatMap((t) => onTrack(t).filter((item) => item.type === 'shape' && item.isMask).map((item) => ({ order: t.order, at: matte(item, worldBox(item, timeline.items, size, inputs), size) })));
  const adjustments = tracks.flatMap((t) => onTrack(t).filter((item) => item.type === 'adjustment').map((item) => ({ order: t.order, effects: item.effects ?? [] })));
  // L4: a picture that covers the frame hides every track below it (no mask active).
  const covers = (item) => {
    if (item.type !== 'image' || (item.blendMode && item.blendMode !== 'normal') || item.cornerPin) return false;
    const crop = cropOf(item.crop);
    if (crop.left > 0 || crop.right > 0 || crop.top > 0 || crop.bottom > 0) return false;
    const box = worldBox(item, timeline.items, size, inputs);
    const turn = box.rotation % 360;
    if (box.opacity < 1 || box.cornerRadius > 0 || (turn !== 0 && turn !== 180 && turn !== -180)) return false;
    const left = W / 2 + box.x - box.width / 2;
    const top = H / 2 + box.y - box.height / 2;
    return left <= 1 && top <= 1 && left + box.width >= W - 1 && top + box.height >= H - 1;
  };
  const cover = masks.length > 0 ? undefined : [...tracks].reverse().find((t) => onTrack(t).some(covers));
  // L3: layers blend over an empty frame; the result is then placed over the background.
  const acc = new Float64Array(W * H * 4);
  for (const t of tracks) {
    if (cover && t.order > cover.order) continue;
    for (const item of onTrack(t)) {
      if (item.type === 'adjustment' || (item.type === 'shape' && item.isMask)) continue;
      const box = worldBox(item, timeline.items, size, inputs);
      let layer = quantise(item.type === 'image' ? imageLayer(item, box, size, inputs[item.mediaId]) : rectangleLayer(item, box, size));
      // L8: effects of the adjustment layers above, then the item's own, on the placed item.
      const stack = [...adjustments.filter((a) => a.order < t.order).sort((p, q) => p.order - q.order).flatMap((a) => a.effects), ...(item.effects ?? [])];
      for (const fx of stack.filter((e) => e.enabled)) {
        assert.equal(fx.effect.gpuEffectType, 'gpu-pixelate', 'reference: only gpu-pixelate');
        layer = quantise(pixelate(layer, size, fx.effect.params.size));
      }
      const applied = masks.filter((m) => m.order < t.order);
      const mode = item.blendMode ?? 'normal';
      for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
        const at = (j * W + i) * 4;
        const [r, g, b, a] = straight8(layer, at);
        if (a <= 0) continue;
        let sa = a;
        const source = [r, g, b];
        if (mode === 'dissolve') sa = dissolveThreshold(i, j, W, H) < f32(sa) ? 1 : 0;
        for (const m of applied) sa *= m.at(i, j);
        if (sa <= 0) continue;
        const ba = acc[at + 3];
        const under = [acc[at], acc[at + 1], acc[at + 2]];
        const mixed = blendColour(mode, under, source, ba > 0 ? () => guarded.push(j * W + i) : undefined);
        const oa = sa + ba * (1 - sa);
        for (let c = 0; c < 3; c++) acc[at + c] = (mixed[c] * ba * sa + source[c] * sa * (1 - ba) + under[c] * ba * (1 - sa)) / oa;
        acc[at + 3] = oa;
      }
    }
  }
  const bg = hexColour(metadata.backgroundColor ?? '#000000');
  const out = new Array(W * H * 4);
  for (let p = 0; p < W * H; p++) {
    const a = acc[p * 4 + 3];
    const alpha = a + bg[3] * (1 - a);
    for (let c = 0; c < 3; c++) out[p * 4 + c] = alpha > 0 ? (clamp01(acc[p * 4 + c]) * a + bg[c] * bg[3] * (1 - a)) / alpha : 0;
    out[p * 4 + 3] = alpha;
  }
  return out;
}

/** Structural and coverage validation of studio/spec/goldens/layers.json (engine-free). */
export function validateLayerGoldens(goldens) {
  assert.equal(goldens.format, LAYER_GOLDENS_FORMAT);
  assert.equal(goldens.version, LAYER_GOLDENS_VERSION);
  assert.equal(goldens.kind, 'layers');
  const expected = layerCases();
  assert.deepEqual(goldens.cases.map((c) => c.name), expected.map((c) => c.name), 'layers: cases must be complete and ordered');
  for (const [name, input] of Object.entries(layerInputs())) {
    const stored = goldens.inputs[name];
    assert(stored, `layers: input ${name} missing`);
    assert.deepEqual({ width: stored.width, height: stored.height }, { width: input.width, height: input.height });
    assert.equal(stored.encoding, 'rgba8-deflate-base64');
    assert.deepEqual(decodeBuffer(stored.data, stored.encoding), input.values, `layers: input ${name} is not the documented formula`);
    assert.equal(stored.sha256, sha256(stored.data));
  }
  let channels = 0;
  goldens.cases.forEach((c, index) => {
    const spec = expected[index];
    assert.equal(c.class, spec.class);
    assert.equal(c.frame, spec.frame);
    assert.equal(c.reference, spec.reference);
    assert.deepEqual(c.graph, spec.graph, `${c.name}: graph`);
    assert.deepEqual(c.size, { width: spec.graph.metadata.width, height: spec.graph.metadata.height });
    assert.equal(c.outcome, 'rendered');
    assert.equal(c.output.encoding, 'rgba8-deflate-base64');
    const values = decodeBuffer(c.output.data, c.output.encoding);
    assert.equal(values.length, c.size.width * c.size.height * 4, `${c.name}: output size`);
    assert(c.tolerance && c.tolerance.abs > 0 && c.tolerance.abs <= 0.25 && Number.isInteger(c.tolerance.outliers) && c.tolerance.meanAbs > 0 && ['pixel', 'edge', 'statistical'].includes(c.tolerance.class), `${c.name}: tolerance`);
    assert(compareCase({ ...c, expected: values }, values).pass);
    channels += values.length;
  });
  return { cases: goldens.cases.length, channels };
}

export { encodeBuffer, decodeBuffer, sha256, compareCase };
