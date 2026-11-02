import { pigallery2SidecarCandidates } from 'src/library-import/pigallery2-sidecars.js';

it('retains all four native XMP locations in source order, including case-sensitive variants', () => {
  expect(pigallery2SidecarCandidates('album/été.photo.JPG')).toEqual([
    'album/été.photo.JPG.xmp',
    'album/été.photo.JPG.XMP',
    'album/été.photo.xmp',
    'album/été.photo.XMP',
  ]);
});
it('uses the same candidates for video companions without assuming photo merge semantics', () => {
  expect(pigallery2SidecarCandidates('clip.mp4')).toEqual(['clip.mp4.xmp', 'clip.mp4.XMP', 'clip.xmp', 'clip.XMP']);
});
it('retains a leading-dot filename and avoids duplicate candidates when it has no extension', () => {
  expect(pigallery2SidecarCandidates('album/.original')).toEqual(['album/.original.xmp', 'album/.original.XMP']);
});
it.each([
  '',
  '/photo.jpg',
  '../photo.jpg',
  'album/../photo.jpg',
  'album//photo.jpg',
  String.raw`album\photo.jpg`,
  'C:photo.jpg',
  'a\0.jpg',
  'a'.repeat(4096),
  null,
  42,
])('refuses unsafe or oversized source path %s', (path) => {
  expect(() => pigallery2SidecarCandidates(path)).toThrow(/^PiGallery2 source refused: PIGALLERY2_FILES_INVALID$/);
});
