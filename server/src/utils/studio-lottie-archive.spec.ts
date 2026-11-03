import { createHash } from 'node:crypto';
import { sniffStudioImport } from 'src/utils/studio-imports.js';
import { readLottieArchive, selectArchiveAnimation } from 'src/utils/studio-lottie-archive.js';
import {
  classifyStudioLottieParent,
  materializeStudioLottieSource,
  parseStudioLottieSource,
  validateStudioLottieItem,
} from 'src/utils/studio-lottie-source.js';
import { buildZip, lottieAnimation, ownedLottieArchive } from 'test/fixtures/studio-lottie.js';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const parentId = '11111111-1111-4111-8111-111111111111';
const childId = '22222222-2222-4222-8222-222222222222';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
  'base64',
);
const type = 'application/zip+dotlottie';

describe('owned strict dotLottie archives', () => {
  it('keeps tentative archive recognition isolated from live import admission', async () => {
    const bytes = ownedLottieArchive('2');
    expect(() => sniffStudioImport(bytes.subarray(0, 1024), undefined)).toThrow();
    expect(classifyStudioLottieParent(bytes).contentType).toBe('application/zip+dotlottie');
    await expect(parseStudioLottieSource(bytes.subarray(0, 4), 'application/zip+dotlottie')).rejects.toThrow();
  });

  it('retains raw JSON authored data and refuses archive-only selection without mutating input', async () => {
    const authored = lottieAnimation();
    const bytes = Buffer.from(JSON.stringify(authored));
    const before = Buffer.from(bytes);
    const source = await materializeStudioLottieSource(
      {},
      { kind: 'project-import', id: parentId },
      bytes,
      'application/json',
      [],
      () => {
        return Promise.reject(new Error('UNEXPECTED_DEPENDENCY_READ'));
      },
    );
    expect(source.archive).toBeNull();
    expect(source.documents).toEqual([{ entry: null, document: authored }]);
    expect(bytes).toEqual(before);
    expect(() => validateStudioLottieItem(source, { animationId: 'invented' })).toThrow('Unknown Lottie animation');
  });

  for (const version of ['1', '2'] as const) {
    it(`v${version} selects initial, explicit and absent-initial defaults independently of ZIP order`, async () => {
      const bytes = ownedLottieArchive(version);
      const before = Buffer.from(bytes);
      const archive = await readLottieArchive(bytes);
      expect(selectArchiveAnimation(archive).document.w).toBe(32);
      expect(selectArchiveAnimation(archive, 'first').document.w).toBe(64);
      expect(() => selectArchiveAnimation(archive, 'unknown')).toThrow();
      const fallback = await readLottieArchive(
        ownedLottieArchive(version, {
          manifest: { version, initial: {}, animations: [{ id: 'first' }, { id: 'selected' }] },
        }),
      );
      expect(selectArchiveAnimation(fallback).id).toBe('first');
      expect(bytes).toEqual(before);
    });

    it(`v${version} retains the selected authored default and refuses invalid initial themes`, async () => {
      const archiveBytes = (selected: Record<string, unknown> = {}, rule?: Record<string, unknown>) =>
        ownedLottieArchive(version, {
          manifest: {
            version,
            initial: { animation: 'selected' },
            animations: [
              { id: 'first' },
              { id: 'selected', themes: ['authored', 'alternate'], initialTheme: 'authored', ...selected },
            ],
            themes: [{ id: 'authored' }, { id: 'alternate' }],
          },
          extra: [
            {
              name: 't/authored.json',
              data: Buffer.from(
                JSON.stringify({ rules: [rule === undefined ? { id: 'opacity', type: 'Scalar', value: 25 } : rule] }),
              ),
            },
            {
              name: 't/alternate.json',
              data: Buffer.from(JSON.stringify({ rules: [{ id: 'scale', type: 'Vector', value: [25, 75] }] })),
            },
          ],
        });
      const bytes = archiveBytes(),
        before = Buffer.from(bytes);
      const archive = await readLottieArchive(bytes);
      expect(selectArchiveAnimation(archive)).toMatchObject({
        id: 'selected',
        initialTheme: 'authored',
        themes: ['authored', 'alternate'],
      });
      expect(selectArchiveAnimation(archive, 'first').initialTheme).toBeUndefined();
      expect(bytes).toEqual(before);
      await expect(readLottieArchive(archiveBytes({ initialTheme: 'missing' }))).rejects.toThrow(
        'Lottie archive refused',
      );
      await expect(readLottieArchive(archiveBytes({ themes: ['alternate'] }))).rejects.toThrow(
        'Lottie archive refused',
      );
      await expect(readLottieArchive(archiveBytes({ initialTheme: 1 }))).rejects.toThrow('Lottie archive refused');
      await expect(
        readLottieArchive(
          archiveBytes({}, { id: 'image', type: 'Image', value: 'https://uncontrolled.invalid/image.png' }),
        ),
      ).rejects.toThrow('Lottie archive refused');
    });

    it(`v${version} verifies internal raster and immutable authorized external closure in every animation`, async () => {
      const imageRoot = version === '2' ? 'i' : 'images';
      const bytes = ownedLottieArchive(version, {
        first: { ...lottieAnimation(), assets: [{ p: 'owned.png', u: `${imageRoot}/` }] },
        selected: {
          ...lottieAnimation(32, 64, 30, 90),
          assets: [{ p: 'foreign.png', u: 'https://uncontrolled.invalid/' }],
        },
        extra: [{ name: `${imageRoot}/owned.png`, data: png }],
      });
      const graph = {
        retained: { history: ['opaque'] },
        studioVectorDependencies: {
          version: 1,
          bindings: [
            {
              parent: { kind: 'vector-graphic', id: parentId, checksum: sha(bytes) },
              location: {
                format: 'lottie-json',
                entry: `${version === '2' ? 'a' : 'animations'}/selected.json`,
                pointer: '/assets/0/p',
                role: 'image',
              },
              child: { kind: 'project-import', id: childId, checksum: sha(png) },
            },
          ],
        },
      };
      const original = Buffer.from(bytes),
        before = JSON.stringify(graph);
      const child = {
        key: `project-import:${childId}`,
        kind: 'project-import' as const,
        id: childId,
        checksum: sha(png),
      };
      const read = vi.fn(() => Promise.resolve(png));
      const parsed = await materializeStudioLottieSource(
        graph,
        { kind: 'vector-graphic', id: parentId },
        bytes,
        type,
        [child],
        read,
      );
      expect(read).toHaveBeenCalledTimes(1);
      for (const document of parsed.documents)
        expect(JSON.stringify(document.document)).toContain(`data:image/png;base64,${png.toString('base64')}`);
      expect(bytes).toEqual(original);
      expect(JSON.stringify(graph)).toBe(before);
      await expect(
        materializeStudioLottieSource(graph, { kind: 'vector-graphic', id: parentId }, bytes, type, [], read),
      ).rejects.toThrow('Unauthorized');
      await expect(
        materializeStudioLottieSource(graph, { kind: 'vector-graphic', id: parentId }, bytes, type, [child], () =>
          Promise.resolve(Buffer.from('changed')),
        ),
      ).rejects.toThrow('bytes changed');
    });
  }

  it('validates a second use independently with different selection/timing/dimensions and slot type', async () => {
    const parsed = await parseStudioLottieSource(
      ownedLottieArchive('2', {
        selected: {
          ...lottieAnimation(32, 64, 30, 90),
          slots: { opacity: { p: { k: 100 } }, scale: { p: { k: [100, 100] } } },
        },
      }),
      type,
    );
    const first = { animationId: 'first', sourceWidth: 64, sourceHeight: 32, frameRate: 24, totalFrames: 48 };
    const second = {
      animationId: 'selected',
      sourceWidth: 32,
      sourceHeight: 64,
      frameRate: 30,
      totalFrames: 90,
      slotOverrides: { opacity: 50, scale: [50, 50] },
    };
    expect(() => validateStudioLottieItem(parsed, first)).not.toThrow();
    expect(() => validateStudioLottieItem(parsed, second)).not.toThrow();
    for (const field of ['sourceWidth', 'sourceHeight', 'frameRate', 'totalFrames'])
      expect(() => validateStudioLottieItem(parsed, { ...second, [field]: 1 })).toThrow();
    expect(() => validateStudioLottieItem(parsed, { ...second, slotOverrides: { opacity: [1, 2] } })).toThrow('slot');
    expect(() => validateStudioLottieItem(parsed, { ...second, animationId: 'unknown' })).toThrow();
  });

  it('refuses duplicate names, path aliases/traversal, local-central disagreement and terminal ambiguity', async () => {
    for (const name of [
      '../outside.json',
      '/absolute.json',
      'a/../first.json',
      String.raw`a\first.json`,
      'a//first.json',
    ]) {
      await expect(readLottieArchive(buildZip([{ name, data: Buffer.from('{}') }]))).rejects.toThrow();
    }
    await expect(readLottieArchive(Buffer.from([0x50, 0x4b, 3, 4]))).rejects.toThrow();
    const normal = ownedLottieArchive('2');
    const changedName = Buffer.from(normal);
    changedName[30] = 'z'.codePointAt(0)!;
    const changedCrc = Buffer.from(normal);
    changedCrc[14] ^= 1;
    const changedSize = Buffer.from(normal);
    changedSize[18] ^= 1;
    const changedFlags = Buffer.from(normal);
    changedFlags[6] ^= 1;
    for (const bytes of [
      changedName,
      changedCrc,
      changedSize,
      changedFlags,
      Buffer.concat([normal, Buffer.from('trailer')]),
    ])
      await expect(readLottieArchive(bytes)).rejects.toThrow();
    await expect(
      readLottieArchive(
        buildZip([
          { name: 'manifest.json', data: Buffer.from('{}') },
          { name: 'manifest.json', data: Buffer.from('{}') },
        ]),
      ),
    ).rejects.toThrow();
    await expect(
      readLottieArchive(
        buildZip([
          { name: 'manifest.json', data: Buffer.from('{}') },
          { name: 'MANIFEST.JSON', data: Buffer.from('{}') },
        ]),
      ),
    ).rejects.toThrow();
  });

  it('refuses unreported central records that hide an unknown file from validation', async () => {
    const archive = ownedLottieArchive('2', {
      extra: [{ name: 'unknown/payload', data: Buffer.from('unvalidated') }],
    });
    await expect(readLottieArchive(archive)).rejects.toThrow('Lottie archive refused');
    const understated = Buffer.from(archive);
    understated.writeUInt16LE(3, understated.length - 22 + 8);
    understated.writeUInt16LE(3, understated.length - 22 + 10);
    await expect(readLottieArchive(understated)).rejects.toThrow('Lottie archive refused');
  });

  it('accepts deflate level hints in the general-purpose flags', async () => {
    const archive = Buffer.from(ownedLottieArchive('2'));
    for (let offset = 0; offset + 4 <= archive.length; offset++) {
      const signature = archive.readUInt32LE(offset);
      if (signature === 0x04_03_4b_50) archive.writeUInt16LE(0x06, offset + 6);
      else if (signature === 0x02_01_4b_50) archive.writeUInt16LE(0x06, offset + 8);
    }
    await expect(readLottieArchive(archive)).resolves.toBeDefined();
  });

  it('refuses encrypted/unsupported/expanded entries and unproved active theme/resource branches', async () => {
    for (const declare of [{ flags: 1 }, { method: 12 }, { uncompressedSize: 17 * 1024 * 1024 }])
      await expect(
        readLottieArchive(buildZip([{ name: 'manifest.json', data: Buffer.from('{}'), declare }])),
      ).rejects.toThrow();
    for (const rule of [
      { id: 'x', type: 'Image', value: { p: 'https://uncontrolled.invalid/' } },
      { id: 'x', type: 'Scalar', value: [{ t: 0, s: 1 }] },
      { id: 'x', type: 'Text', value: { text: 'x', fontFamily: 'unproved' } },
    ]) {
      await expect(
        readLottieArchive(
          ownedLottieArchive('2', {
            manifest: { version: '2', animations: [{ id: 'first' }, { id: 'selected' }], themes: [{ id: 'unsafe' }] },
            extra: [
              {
                name: 't/unsafe.json',
                data: Buffer.from(
                  JSON.stringify({ rules: [rule === undefined ? { id: 'opacity', type: 'Scalar', value: 25 } : rule] }),
                ),
              },
            ],
          }),
        ),
      ).rejects.toThrow();
    }
    await expect(
      parseStudioLottieSource(
        ownedLottieArchive('2', {
          first: { ...lottieAnimation(), assets: [{ p: 'data:image/svg+xml;base64,PHN2Zy8+' }] },
        }),
        type,
      ),
    ).rejects.toThrow();
  });
});
