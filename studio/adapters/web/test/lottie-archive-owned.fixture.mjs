// Test-owned archive documents and independent expectations. Never renderer-generated.
import { animation, edits } from './lottie-owned.fixture.mjs';
export { edits };
export const archiveVersions = ['1', '2'];
export function archiveFiles(version, unsupportedTheme = false) {
  if (!archiveVersions.includes(version)) throw new Error('OWNED_ARCHIVE_VERSION_REQUIRED');
  const selected = structuredClone(animation);
  const first = structuredClone(animation);
  // Deliberately distinguish the manifest/ZIP-first animation from initial.animation.
  first.nm = 'Wrong manifest-first blue plate';
  first.layers[1].shapes[0].it[1].c.k = [0, 0, 1];
  const prefix = version === '2' ? 'a' : 'animations';
  const json = (value) => new TextEncoder().encode(JSON.stringify(value));
  return {
    [`${prefix}/first.json`]: json(first),
    'manifest.json': json({ version, initial: { animation: 'selected' },
      animations: [
        { id: 'first', themes: ['authored', 'alternate'], initialTheme: 'authored' },
        { id: 'selected', themes: ['authored', 'alternate'], initialTheme: 'authored' },
      ], themes: [{ id: 'authored' }, { id: 'alternate' }] }),
    [`${prefix}/selected.json`]: json(selected),
    't/authored.json': json({ rules: unsupportedTheme
      ? [{ id: 'plateOpacity', type: 'Image', value: 'unproven-resource.png' }]
      : [{ id: 'plateOpacity', type: 'Scalar', value: 25 },
        { id: 'plateScale', type: 'Vector', value: [100, 100] }] }),
    't/alternate.json': json({ rules: [
      { id: 'plateOpacity', type: 'Scalar', value: 75 },
      { id: 'plateScale', type: 'Vector', value: [50, 100] },
    ] }),
  };
}
// Interior samples on transparent native/strict canvases. Values are authored geometry.
export const archiveSamples = [
  { name: 'plate color and opacity', x: 11, y: 12,
    authored: [255, 0, 0, 64], alternate: [255, 0, 0, 191], edited: [0, 255, 0, 128] },
  { name: 'vector scale removed right half', x: 20, y: 12,
    authored: [255, 0, 0, 64], alternate: [0, 0, 0, 0], edited: [0, 0, 0, 0] },
  { name: 'text edit removes glyph center', x: 16, y: 48,
    authored: [255, 255, 255, 255], alternate: [255, 255, 255, 255], edited: [0, 0, 0, 0] },
  { name: 'owned glyph retained left bar', x: 10, y: 48,
    authored: [255, 255, 255, 255], alternate: [255, 255, 255, 255], edited: [255, 255, 255, 255] },
  { name: 'temporal first pose', x: 43, y: 11,
    frame0: [0, 0, 255, 255], frame30: [0, 0, 0, 0] },
  { name: 'temporal second pose', x: 43, y: 27,
    frame0: [0, 0, 0, 0], frame30: [0, 0, 255, 255] },
];
// AVC/MP4 has an opaque black background. Independent composited RGB literals;
// these are NOT computed from a candidate decode or a renderer's canvas output.
export const encodedRgb = {
  authored: [[64, 0, 0], [64, 0, 0], [255, 255, 255], [255, 255, 255]],
  alternate: [[191, 0, 0], [0, 0, 0], [255, 255, 255], [255, 255, 255]],
  edited: [[0, 128, 0], [0, 0, 0], [0, 0, 0], [255, 255, 255]],
};
// Fixed before execution; failures cannot change it. Flat interior AVC samples only.
export const encodedTolerance = 4;
