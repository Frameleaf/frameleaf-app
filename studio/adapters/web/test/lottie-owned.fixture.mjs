// Entirely authored geometric specimen. No font outlines, images or catalog assets.
// Schema provenance: exact dotlottie-web 0.76.0/core pins in the source handoff.
const property = (k) => ({ a: 0, k });
const transform = (p = [0, 0, 0]) => ({
  o: property(100), r: property(0), p: property(p),
  a: property([0, 0, 0]), s: property([100, 100, 100]),
});
const path = (x, y, w, h) => ({ ty: 'sh', ks: property({
  i: [[0, 0], [0, 0], [0, 0], [0, 0]],
  o: [[0, 0], [0, 0], [0, 0], [0, 0]],
  v: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], c: true,
}) });
const glyph = (ch, paths) => ({ ch, size: 100, style: 'Regular', w: 20,
  fFamily: 'FL105OwnedGeometry', data: { shapes: [{ ty: 'gr', it: paths }] } });
const layer = (ind, ty, nm, ks, extra) => ({
  ddd: 0, ind, ty, nm, sr: 1, ip: 0, op: 60, st: 0, bm: 0, ks, ...extra,
});
export const animation = {
  v: '5.12.2', fr: 30, ip: 0, op: 60, w: 64, h: 64, ddd: 0,
  nm: 'FL105 owned glyph, opacity and scale qualification', assets: [],
  fonts: { list: [{ fName: 'FL105OwnedGeometry-Regular',
    fFamily: 'FL105OwnedGeometry', fStyle: 'Regular', ascent: 0 }] },
  chars: [glyph('A', [path(0, -16, 16, 16)]),
    glyph('B', [path(0, -16, 4, 16), path(12, -16, 4, 16)])],
  slots: { plateOpacity: { p: property(100) }, plateScale: { p: property([100, 100]) } },
  layers: [
    layer(1, 5, 'Owned text', transform([8, 56, 0]), { t: {
      d: { k: [{ t: 0, s: { s: 100, f: 'FL105OwnedGeometry-Regular',
        t: 'A', j: 0, tr: 0, lh: 100, ls: 0, fc: [1, 1, 1] } }] },
      p: {}, m: { g: 1, a: property([0, 0]) }, a: [],
    } }),
    layer(2, 4, 'Edited plate', transform(), { shapes: [{ ty: 'gr', it: [
      path(0, 0, 16, 16),
      { ty: 'fl', nm: 'Plate fill', c: property([1, 0, 0]),
        o: { ...property(100), sid: 'plateOpacity' }, r: 1 },
      { ty: 'tr', p: property([8, 8]), a: property([0, 0]),
        s: { ...property([100, 100]), sid: 'plateScale' }, r: property(0), o: property(100) },
    ] }] }),
    layer(3, 4, 'Held temporal witness', { ...transform(), p: { a: 1, k: [
      { t: 0, s: [40, 8, 0], h: 1 }, { t: 30, s: [40, 24, 0], h: 1 },
    ] } }, { shapes: [path(0, 0, 8, 8),
      { ty: 'fl', c: property([0, 0, 1]), o: property(100), r: 1 }] }),
  ],
};
export const edits = {
  colors: { c0: '#00ff00' }, text: { '0': 'B' },
  slots: { plateOpacity: 50, plateScale: [50, 100] },
};
// Independent literal interior expectations. No renderer output feeds this table.
// Captures use the actual native Lottie canvas/strict provider with transparent background.
export const samples = [
  { name: 'plate color and opacity', x: 11, y: 12, authored: [255, 0, 0, 255], edited: [0, 255, 0, 128] },
  { name: 'vector scale removed right half', x: 20, y: 12, authored: [255, 0, 0, 255], edited: [0, 0, 0, 0] },
  { name: 'text edit removes glyph center', x: 16, y: 48, authored: [255, 255, 255, 255], edited: [0, 0, 0, 0] },
  { name: 'owned glyph retained left bar', x: 10, y: 48, authored: [255, 255, 255, 255], edited: [255, 255, 255, 255] },
  { name: 'temporal first pose', x: 43, y: 11, frame0: [0, 0, 255, 255], frame30: [0, 0, 0, 0] },
  { name: 'temporal second pose', x: 43, y: 27, frame0: [0, 0, 0, 0], frame30: [0, 0, 255, 255] },
];
