import { AssetAnnotationsUpdateDto } from 'src/dtos/asset-annotation.dto.js';
import { LibraryManifestDto } from 'src/dtos/library-manifest.dto.js';

const rect = { id: 'a1', kind: 'rect', geometry: { x: 0.05, y: 0.27, width: 0.45, height: 0.2 }, note: 'Headline' };
const arrow = { id: 'a2', kind: 'arrow', geometry: { x: 0.36, y: 0.66, endX: 0.2, endY: 0.56 } };
const text = { id: 'a3', kind: 'text', geometry: { x: 0.44, y: 0.93 }, text: 'v2 · check with Jamie' };
const parse = (items: unknown[]) => AssetAnnotationsUpdateDto.schema.safeParse({ version: 1, items });

describe('Boards annotation documents', () => {
  it('accepts rectangles, arrows and text in normalized coordinates, with an Eagle origin', () => {
    expect(parse([rect, arrow, text, { ...rect, id: 'e1', origin: 'eagle' }]).success).toBe(true);
    expect(parse([]).success).toBe(true);
  });

  it.each([
    ['a coordinate outside the picture', { ...rect, geometry: { ...rect.geometry, x: 1.2 } }],
    ['a rectangle running off the edge', { ...rect, geometry: { x: 0.8, y: 0, width: 0.4, height: 0.1 } }],
    ['a rectangle with no size', { ...rect, geometry: { x: 0.1, y: 0.1, width: 0, height: 0.1 } }],
    ['a rectangle with an end point', { ...rect, geometry: { ...rect.geometry, endX: 0.5, endY: 0.5 } }],
    ['an arrow with no end point', { ...arrow, geometry: { x: 0.1, y: 0.1 } }],
    ['an arrow with a size', { ...arrow, geometry: { ...arrow.geometry, width: 0.1, height: 0.1 } }],
    ['text with a size', { ...text, geometry: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 } }],
    ['words on a rectangle', { ...rect, text: 'Nope' }],
    ['an unknown kind', { ...rect, kind: 'circle' }],
    ['an unknown origin', { ...rect, origin: 'figma' }],
    ['an unknown field', { ...rect, colour: 'red' }],
    ['a note that is too long', { ...rect, note: 'x'.repeat(281) }],
    ['an unsafe id', { ...rect, id: '../a' }],
  ])('refuses %s', (_name, item) => {
    expect(parse([item]).success).toBe(false);
  });

  it('refuses duplicate ids, too many items and other versions', () => {
    expect(parse([rect, { ...arrow, id: 'a1' }]).success).toBe(false);
    expect(parse(Array.from({ length: 201 }, (_, index) => ({ ...text, id: `t${index}` }))).success).toBe(false);
    expect(AssetAnnotationsUpdateDto.schema.safeParse({ version: 2, items: [] }).success).toBe(false);
    expect(AssetAnnotationsUpdateDto.schema.safeParse({ version: 1, sourceRevision: 'x', items: [] }).success).toBe(
      false,
    );
  });

  it('carries annotations in the portable library file and checks them there too', () => {
    const asset = {
      id: '11111111-1111-4111-8111-111111111111',
      file: 'hero.png',
      checksum: { algorithm: 'sha1', value: 'a'.repeat(40) },
      libraryScope: 'design',
      albumIds: [],
      tagIds: [],
    };
    const manifest = (annotations: unknown) => ({
      version: 1,
      albums: [],
      tags: [],
      bookmarks: [],
      assets: [{ ...asset, annotations }],
    });
    expect(LibraryManifestDto.schema.parse(manifest([rect, arrow])).assets[0].annotations).toHaveLength(2);
    expect(LibraryManifestDto.schema.safeParse(manifest([{ ...rect, geometry: { x: 2, y: 0 } }])).success).toBe(false);
  });
});
