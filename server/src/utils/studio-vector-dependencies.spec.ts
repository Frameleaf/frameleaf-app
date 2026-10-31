import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { extractStudioResourceReferences } from 'src/utils/studio-resources.js';
import {
  parseStudioLottieDependencies,
  readStudioVectorBindings,
  validateStudioVectorClosure,
} from 'src/utils/studio-vector-dependencies.js';

const parent = { kind: 'vector-graphic', id: '11111111-1111-4111-8111-111111111111', checksum: 'a'.repeat(64) };
const child = { kind: 'project-import', id: '22222222-2222-4222-8222-222222222222', checksum: 'b'.repeat(64) };
const location = { format: 'lottie-json', entry: null, pointer: '/assets/0/p', role: 'image' };
const binding = { parent, location, child };
describe('immutable vector dependency declarations', () => {
  it('preserves explicit kind, parent checksum and parsed location', () => {
    expect(readStudioVectorBindings({ studioVectorDependencies: { version: 1, bindings: [binding] } })).toEqual([
      binding,
    ]);
  });
  it.each([
    { ...binding, child: { ...child, kind: 'vector-graphic' } },
    { ...binding, child: { ...child, checksum: 'B'.repeat(64) } },
    { ...binding, location: { ...location, pointer: '/assets/00/p' } },
    { ...binding, location: { ...location, entry: '../animation.json' } },
    { ...binding, parent: { ...parent, ownerId: 'invented' } },
  ])('refuses aliases, invented authority and wrong kinds', (row) => {
    expect(() => readStudioVectorBindings({ studioVectorDependencies: { version: 1, bindings: [row] } })).toThrow();
  });
  it('refuses duplicate parsed locations even with different children', () => {
    expect(() =>
      readStudioVectorBindings({
        studioVectorDependencies: {
          version: 1,
          bindings: [binding, { ...binding, child: { ...child, checksum: 'c'.repeat(64) } }],
        },
      }),
    ).toThrow();
  });
  it('discovers image and font locations including otherwise unused images', () => {
    const text = JSON.stringify({
      v: '5.9',
      layers: [],
      assets: [{ id: 'offrange', p: 'a.png', u: 'images/' }],
      fonts: { list: [{ fName: 'Example', fPath: 'https://uncontrolled/font.woff2' }] },
    });
    expect(parseStudioLottieDependencies(text).dependencies).toEqual([
      location,
      { format: 'lottie-json', entry: null, pointer: '/fonts/list/0/fPath', role: 'font' },
    ]);
  });
  it('rejects duplicate JSON keys instead of last-key dependency ambiguity', () => {
    expect(() =>
      parseStudioLottieDependencies('{"v":"5","layers":[],"assets":[],"assets":[{"p":"foreign.png"}]}'),
    ).toThrow();
  });
  it.each(['data:application/json;base64,e30=', 'data:image/svg+xml;base64,PHN2Zz48c2NyaXB0Lz48L3N2Zz4='])(
    'refuses wrong MIME and unsafe nested SVG embedded image bytes',
    (p) => {
      expect(() => parseStudioLottieDependencies(JSON.stringify({ v: '5', layers: [], assets: [{ p }] }))).toThrow();
    },
  );
});

it('extracts child kinds explicitly without treating binding IDs as ordinary graph resources', () => {
  const extraction = extractStudioResourceReferences({
    graphicId: parent.id,
    studioVectorDependencies: { version: 1, bindings: [binding] },
  });
  expect(extraction.violations).toEqual([]);
  expect(extraction.references).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: 'vector-graphic', id: parent.id }),
      expect.objectContaining({ kind: 'project-import', id: child.id, vectorDependency: true }),
    ]),
  );
});
it('records malformed bindings as graph refusals', () => {
  expect(
    extractStudioResourceReferences({ studioVectorDependencies: { version: 1, bindings: [binding, binding] } })
      .violations,
  ).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'invalid-id' })]));
});

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
describe('verified vector byte closure', () => {
  const animation = Buffer.from(
    JSON.stringify({ v: '5', layers: [], assets: [{ id: 'image', p: 'foreign.png', u: 'https://uncontrolled/' }] }),
  );
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
    'base64',
  );
  const row = {
    ...binding,
    parent: { ...parent, checksum: digest(animation) },
    child: { ...child, checksum: digest(png) },
  };
  const entries = [
    { ...row.parent, key: `vector-graphic:${parent.id}` },
    { ...row.child, key: `project-import:${child.id}` },
  ];
  const graph = (bindings: unknown[]) => ({ graphicId: parent.id, studioVectorDependencies: { version: 1, bindings } });
  const read = (entry: { id: string }) => Promise.resolve(entry.id === parent.id ? animation : png);
  it('matches independently parsed parent dependencies and exact authorized bytes', async () => {
    await expect(validateStudioVectorClosure(graph([row]), entries, read)).resolves.toBeUndefined();
  });
  it.each([
    { ...row, parent: { ...row.parent, checksum: 'c'.repeat(64) } },
    { ...row, child: { ...row.child, checksum: 'c'.repeat(64) } },
    { ...row, location: { ...location, pointer: '/assets/1/p' } },
    { ...row, child: { ...row.child, kind: 'library-asset' } },
  ])('refuses changed checksums, missing locations and wrong namespace without inference', async (bad) => {
    await expect(validateStudioVectorClosure(graph([bad]), entries, read)).rejects.toThrow();
  });
  it('refuses incomplete and surplus dependency locations', async () => {
    const extra = { ...row, location: { ...location, pointer: '/assets/1/p' } };
    await expect(validateStudioVectorClosure(graph([row, extra]), entries, read)).rejects.toThrow();
    const two = Buffer.from(JSON.stringify({ v: '5', layers: [], assets: [{ p: 'one' }, { p: 'two' }] }));
    const changed = { ...row, parent: { ...row.parent, checksum: digest(two) } };
    await expect(
      validateStudioVectorClosure(graph([changed]), [{ ...entries[0], checksum: digest(two) }, entries[1]], (entry) =>
        Promise.resolve(entry.id === parent.id ? two : png),
      ),
    ).rejects.toThrow();
  });
  it('never admits Lottie JSON as an image despite vector classification', async () => {
    const changed = { ...row, child: { ...row.child, checksum: digest(animation) } };
    await expect(
      validateStudioVectorClosure(graph([changed]), [entries[0], { ...entries[1], checksum: digest(animation) }], () =>
        Promise.resolve(animation),
      ),
    ).rejects.toThrow();
  });
  it('refuses SVG dependencies before the supported sanitized SVG image path exists', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>');
    const changed = { ...row, child: { ...row.child, checksum: digest(svg) } };
    await expect(
      validateStudioVectorClosure(graph([changed]), [entries[0], { ...entries[1], checksum: digest(svg) }], (entry) =>
        Promise.resolve(entry.id === parent.id ? animation : svg),
      ),
    ).rejects.toThrow();
  });
});

it('refuses unsupported network-bearing image slots and malformed dependency containers', () => {
  for (const field of [
    { assets: {} },
    { fonts: { list: {} } },
    { slots: { picture: { p: { p: 'https://uncontrolled/image.png' } } } },
  ]) {
    expect(() => parseStudioLottieDependencies(JSON.stringify({ v: '5', layers: [], ...field }))).toThrow();
  }
});
