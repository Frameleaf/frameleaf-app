import { createHash } from 'node:crypto';
import { crc32, deflateRawSync } from 'node:zlib';
import {
  STUDIO_BUNDLE_FORMAT,
  STUDIO_BUNDLE_MANIFEST_ENTRY,
  STUDIO_BUNDLE_MAX_RATIO,
  STUDIO_BUNDLE_PROJECT_ENTRY,
  STUDIO_BUNDLE_RATIO_FLOOR_BYTES,
  STUDIO_BUNDLE_SCHEMA_VERSION,
  StudioBundleArchiveError,
  StudioBundleManifest,
  ZipByteSource,
  bundleMediaEntryName,
  checkStudioBundleManifest,
  checkStudioBundleProject,
  digestZipEntry,
  isBundleExportDownloadable,
  parseBundleExportSnapshot,
  parseBundleImportSnapshot,
  readZipDirectory,
  readZipEntry,
  relinkStudioGraph,
  serializeStudioBundleProject,
  sha256Of,
  studioBundleFileName,
  zipEntryNameProblem,
} from 'src/utils/studio-bundle.js';
import { STUDIO_ENGINE, STUDIO_ENVELOPE_SCHEMA_VERSION, studioEnvelopeDigest } from 'src/utils/studio-project.js';
import { StudioResourceKind } from 'src/utils/studio-resources.js';

/* ------------------------------------------------------------------ */
/* A tiny ZIP writer, so the reader is tested against real archives     */
/* ------------------------------------------------------------------ */

type TestEntry = {
  name: string;
  data: Buffer;
  method?: 0 | 8;
  /** Override what the central directory declares, to test a lying archive. */
  declare?: { compressedSize?: number; uncompressedSize?: number; flags?: number; method?: number };
};

const buildZip = (entries: TestEntry[], options: { eocdEntries?: number } = {}): Buffer => {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const method = entry.method ?? 8;
    const payload = method === 8 ? deflateRawSync(entry.data) : entry.data;
    const name = Buffer.from(entry.name, 'utf8');
    const checksum = crc32(entry.data);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04_03_4b_50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02_01_4b_50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.declare?.flags ?? 0, 8);
    central.writeUInt16LE(entry.declare?.method ?? method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(entry.declare?.compressedSize ?? payload.length, 20);
    central.writeUInt32LE(entry.declare?.uncompressedSize ?? entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);

    locals.push(local, payload);
    centrals.push(central);
    offset += local.length + payload.length;
  }

  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06_05_4b_50, 0);
  eocd.writeUInt16LE(options.eocdEntries ?? entries.length, 8);
  eocd.writeUInt16LE(options.eocdEntries ?? entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, directory, eocd]);
};

const sourceOf = (bytes: Buffer): ZipByteSource => ({
  size: bytes.length,
  read: (position, length) => Promise.resolve(bytes.subarray(position, position + length)),
});

const envelope = (graph: Record<string, unknown>) => ({
  schemaVersion: STUDIO_ENVELOPE_SCHEMA_VERSION,
  engine: STUDIO_ENGINE,
  engineRevision: 'rev-1',
  graph,
});

const assetA = '11111111-1111-4111-8111-111111111111';
const assetB = '22222222-2222-4222-8222-222222222222';

const manifestOf = (project: Buffer, extra: Partial<StudioBundleManifest> = {}): StudioBundleManifest => ({
  format: STUDIO_BUNDLE_FORMAT,
  schemaVersion: STUDIO_BUNDLE_SCHEMA_VERSION,
  createdAt: '2026-09-22T10:00:00.000Z',
  producer: { product: 'frameleaf', version: '3.0.0' },
  project: {
    name: 'Lake trip',
    revision: 4,
    digest: studioEnvelopeDigest(JSON.parse(project.toString('utf8'))),
    sourceProjectId: '0195e2a0-0000-7000-8000-000000000001',
  },
  engine: { engine: STUDIO_ENGINE, engineRevision: 'rev-1' },
  files: { [STUDIO_BUNDLE_PROJECT_ENTRY]: { sha256: sha256Of(project), bytes: project.length } },
  sources: [
    {
      key: `library-asset:${assetA}`,
      kind: StudioResourceKind.LibraryAsset,
      id: assetA,
      mode: 'reference',
      path: null,
      sha256: null,
      bytes: null,
      fileName: 'lake.mov',
      contentType: 'video/quicktime',
    },
  ],
  ...extra,
});

const expectRefusal = async (promise: Promise<unknown>, code: string) => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(StudioBundleArchiveError);
    expect((error as StudioBundleArchiveError).code).toBe(code);
    return;
  }
  throw new Error(`expected refusal ${code}`);
};

/* ------------------------------------------------------------------ */

describe('zipEntryNameProblem', () => {
  it('accepts plain relative names', () => {
    expect(zipEntryNameProblem('manifest.json')).toBeNull();
    expect(zipEntryNameProblem('media/library-asset-abc.mov')).toBeNull();
  });

  it('refuses traversal, absolute paths, backslashes, directories and NUL', () => {
    expect(zipEntryNameProblem('../etc/passwd')).toMatch(/traverses/);
    expect(zipEntryNameProblem('media/../../x')).toMatch(/traverses/);
    expect(zipEntryNameProblem('/etc/passwd')).toMatch(/absolute/);
    expect(zipEntryNameProblem('C:\\media\\x')).toMatch(/backslash/);
    expect(zipEntryNameProblem('media/')).toMatch(/directory/);
    expect(zipEntryNameProblem('a\0b')).toMatch(/NUL/);
    expect(zipEntryNameProblem('')).toMatch(/length/);
  });
});

describe('readZipDirectory', () => {
  it('lists stored and deflated entries with their declared sizes', async () => {
    const zip = buildZip([
      { name: 'manifest.json', data: Buffer.from('{}'), method: 0 },
      { name: 'project.json', data: Buffer.from('{"graph":{}}') },
    ]);
    const directory = await readZipDirectory(sourceOf(zip));

    expect(directory.entries.map((entry) => entry.name)).toEqual(['manifest.json', 'project.json']);
    expect(directory.byName.get('manifest.json')?.compression).toBe('store');
    expect(directory.byName.get('project.json')?.compression).toBe('deflate');
    expect(directory.byName.get('project.json')?.uncompressedSize).toBe(12);
  });

  it('refuses a file that is not a ZIP archive', async () => {
    await expectRefusal(readZipDirectory(sourceOf(Buffer.from('definitely not a zip file, sorry'))), 'bundle_not_zip');
  });

  it('refuses an entry whose name traverses out of the archive', async () => {
    const zip = buildZip([{ name: '../outside.json', data: Buffer.from('{}') }]);
    await expectRefusal(readZipDirectory(sourceOf(zip)), 'bundle_entry_name');
  });

  it('refuses an encrypted entry and an unknown compression method', async () => {
    const encrypted = buildZip([{ name: 'a.json', data: Buffer.from('{}'), declare: { flags: 1 } }]);
    await expectRefusal(readZipDirectory(sourceOf(encrypted)), 'bundle_encrypted');

    const bzip = buildZip([{ name: 'a.json', data: Buffer.from('{}'), declare: { method: 12 } }]);
    await expectRefusal(readZipDirectory(sourceOf(bzip)), 'bundle_compression');
  });

  it('refuses ZIP64 markers', async () => {
    const zip = buildZip([{ name: 'a.json', data: Buffer.from('{}'), declare: { uncompressedSize: 0xff_ff_ff_ff } }]);
    await expectRefusal(readZipDirectory(sourceOf(zip)), 'bundle_zip64');
  });

  it('refuses a decompression bomb by its declared ratio', async () => {
    const zeros = Buffer.alloc(STUDIO_BUNDLE_RATIO_FLOOR_BYTES * 4);
    const compressed = deflateRawSync(zeros);
    expect(zeros.length).toBeGreaterThan(compressed.length * STUDIO_BUNDLE_MAX_RATIO);

    const zip = buildZip([{ name: 'media/library-asset-x.bin', data: zeros }]);
    await expectRefusal(readZipDirectory(sourceOf(zip)), 'bundle_ratio');
  });

  it('refuses a directory that declares more entries than it holds', async () => {
    const zip = buildZip([{ name: 'a.json', data: Buffer.from('{}') }], { eocdEntries: 2 });
    await expectRefusal(readZipDirectory(sourceOf(zip)), 'bundle_corrupt');
  });
});

describe('readZipEntry and digestZipEntry', () => {
  it('reads a stored and a deflated entry back byte for byte', async () => {
    const text = Buffer.from(JSON.stringify({ hello: 'world', nested: { keep: [1, 2, 3] } }));
    const zip = buildZip([
      { name: 'stored.json', data: text, method: 0 },
      { name: 'deflated.json', data: text },
    ]);
    const source = sourceOf(zip);
    const directory = await readZipDirectory(source);

    expect(await readZipEntry(source, directory.byName.get('stored.json')!)).toEqual(text);
    expect(await readZipEntry(source, directory.byName.get('deflated.json')!)).toEqual(text);
  });

  it('refuses an entry that inflates to a different size than it declared', async () => {
    const zip = buildZip([{ name: 'a.json', data: Buffer.from('{"a":1}'), declare: { uncompressedSize: 3 } }]);
    const source = sourceOf(zip);
    const directory = await readZipDirectory(source);
    await expectRefusal(readZipEntry(source, directory.byName.get('a.json')!), 'bundle_corrupt');
  });

  it('digests a large entry in chunks without loading it whole, and reports progress', async () => {
    const media = Buffer.alloc(300_000);
    for (let index = 0; index < media.length; index++) {
      media[index] = (index * 31) % 251;
    }
    const zip = buildZip([{ name: 'media/library-asset-x.mov', data: media, method: 0 }]);
    const source = sourceOf(zip);
    const directory = await readZipDirectory(source);
    const seen: number[] = [];

    const digest = await digestZipEntry(source, directory.byName.get('media/library-asset-x.mov')!, {
      chunkSize: 64 * 1024,
      onProgress: (bytes) => {
        seen.push(bytes);
      },
    });

    expect(digest).toEqual({ sha256: createHash('sha256').update(media).digest('hex'), bytes: media.length });
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.at(-1)).toBe(media.length);
  });

  it('digests a deflated entry through the streaming inflater', async () => {
    const media = Buffer.from('frame '.repeat(40_000));
    const zip = buildZip([{ name: 'media/library-asset-y.bin', data: media }]);
    const source = sourceOf(zip);
    const directory = await readZipDirectory(source);

    const digest = await digestZipEntry(source, directory.byName.get('media/library-asset-y.bin')!, {
      chunkSize: 1024,
    });
    expect(digest.sha256).toBe(sha256Of(media));
  });
});

describe('checkStudioBundleManifest', () => {
  const project = serializeStudioBundleProject(envelope({ tracks: [{ clips: [{ assetId: assetA }] }] }));

  it('accepts a well-formed manifest and normalizes descriptive text', () => {
    const checked = checkStudioBundleManifest({ ...manifestOf(project), producer: { product: 'frameleaf', version: 'x'.repeat(100) } });
    expect(checked.ok).toBe(true);
    if (checked.ok) {
      expect(checked.manifest.producer.version).toHaveLength(64);
      expect(checked.manifest.sources[0].key).toBe(`library-asset:${assetA}`);
    }
  });

  it('refuses another format, another schema version and a manifest that digests itself', () => {
    expect(checkStudioBundleManifest({ ...manifestOf(project), format: 'zip' })).toMatchObject({ ok: false });
    expect(checkStudioBundleManifest({ ...manifestOf(project), schemaVersion: 2 })).toMatchObject({ ok: false });
    const base = manifestOf(project);
    expect(
      checkStudioBundleManifest({
        ...base,
        files: { ...base.files, [STUDIO_BUNDLE_MANIFEST_ENTRY]: { sha256: 'a'.repeat(64), bytes: 1 } },
      }),
    ).toMatchObject({ ok: false });
  });

  it('requires every embedded source to name a listed media entry and every media entry to belong to a source', () => {
    const base = manifestOf(project);
    const embedded = {
      key: `library-asset:${assetB}`,
      kind: StudioResourceKind.LibraryAsset,
      id: assetB,
      mode: 'embedded' as const,
      path: 'media/library-asset-b.mov',
      sha256: 'b'.repeat(64),
      bytes: 10,
      fileName: 'b.mov',
      contentType: 'video/quicktime',
    };

    expect(checkStudioBundleManifest({ ...base, sources: [...base.sources, embedded] })).toMatchObject({
      ok: false,
      detail: expect.stringContaining('not listed in files'),
    });

    expect(
      checkStudioBundleManifest({
        ...base,
        files: { ...base.files, 'media/library-asset-b.mov': { sha256: 'b'.repeat(64), bytes: 10 } },
      }),
    ).toMatchObject({ ok: false, detail: expect.stringContaining('belongs to no source') });

    expect(
      checkStudioBundleManifest({
        ...base,
        files: { ...base.files, 'media/library-asset-b.mov': { sha256: 'b'.repeat(64), bytes: 10 } },
        sources: [...base.sources, embedded],
      }),
    ).toMatchObject({ ok: true });
  });

  it('refuses a source whose key does not match its kind and id, and a traversing file name', () => {
    const base = manifestOf(project);
    expect(
      checkStudioBundleManifest({ ...base, sources: [{ ...base.sources[0], key: 'library-asset:other' }] }),
    ).toMatchObject({ ok: false, detail: expect.stringContaining('key') });
    expect(
      checkStudioBundleManifest({ ...base, files: { ...base.files, '../x': { sha256: 'a'.repeat(64), bytes: 1 } } }),
    ).toMatchObject({ ok: false, detail: expect.stringContaining('traverses') });
  });
});

describe('checkStudioBundleProject', () => {
  it('accepts project.json only when the entry digest and the revision digest both agree', () => {
    const project = serializeStudioBundleProject(envelope({ tracks: [], unknownFutureField: { keep: true } }));
    const manifest = manifestOf(project);
    const checked = checkStudioBundleProject(manifest, project);
    expect(checked.ok).toBe(true);
    if (checked.ok) {
      expect((checked.envelope.graph as Record<string, unknown>).unknownFutureField).toEqual({ keep: true });
    }

    const tampered = serializeStudioBundleProject(envelope({ tracks: [{ id: 't' }] }));
    expect(checkStudioBundleProject(manifest, tampered)).toMatchObject({ ok: false });

    const wrongDigest = { ...manifest, project: { ...manifest.project, digest: 'c'.repeat(64) } };
    expect(checkStudioBundleProject(wrongDigest, project)).toMatchObject({
      ok: false,
      detail: expect.stringContaining('digest'),
    });
  });
});

describe('relinkStudioGraph', () => {
  const graph = {
    sequences: [
      {
        id: 'seq-1',
        tracks: [
          {
            clips: [
              { id: 'c1', assetId: assetA, grade: { look: 'warm' } },
              { id: 'c2', mediaId: assetB, editedMasterOf: assetB },
              { id: 'c3', $resource: { kind: 'library-asset', id: assetA }, note: 'keep me' },
              { id: 'c4', $resource: { kind: 'font', id: assetA } },
            ],
          },
        ],
      },
    ],
    future: { assetIdList: [assetA], notAnId: 'assetId' },
  };

  it('rewrites exactly the source id keys, by kind, and leaves everything else untouched', () => {
    const target = '33333333-3333-4333-8333-333333333333';
    const mapping = new Map([
      [`library-asset:${assetA}`, target],
      [`edited-master:${assetB}`, target],
    ]);
    const result = relinkStudioGraph(graph, mapping);
    const clips = (result.graph as typeof graph).sequences[0].tracks[0].clips;

    expect(clips[0].assetId).toBe(target);
    expect(clips[1].mediaId).toBe(assetB);
    expect(clips[1].editedMasterOf).toBe(target);
    expect(clips[2].$resource).toEqual({ kind: 'library-asset', id: target });
    expect(clips[3].$resource).toEqual({ kind: 'font', id: assetA });
    expect((result.graph as typeof graph).future).toEqual(graph.future);
    expect(result.replaced).toBe(3);
    expect(result.unused).toEqual([]);
    // The input is never mutated.
    expect(graph.sequences[0].tracks[0].clips[0].assetId).toBe(assetA);
  });

  it('reports mapping keys the graph never referenced', () => {
    const result = relinkStudioGraph(graph, new Map([['library-asset:nobody', assetB]]));
    expect(result.replaced).toBe(0);
    expect(result.unused).toEqual(['library-asset:nobody']);
  });
});

describe('names', () => {
  it('builds a media entry name from the kind, the id and a cleaned extension only', () => {
    expect(bundleMediaEntryName({ kind: StudioResourceKind.LibraryAsset, id: assetA, fileName: 'Lake trip.MOV' })).toBe(
      `media/library-asset-${assetA}.MOV`,
    );
    expect(bundleMediaEntryName({ kind: StudioResourceKind.EditedMaster, id: assetB, fileName: '../x.mp4/../' })).toBe(
      `media/edited-master-${assetB}`,
    );
    expect(bundleMediaEntryName({ kind: StudioResourceKind.LibraryAsset, id: assetA, fileName: null })).toBe(
      `media/library-asset-${assetA}`,
    );
  });

  it('names the download after the project and never after the id', () => {
    expect(studioBundleFileName('Lake trip: août 2026')).toBe('Lake-trip-aout-2026.frameleaf-studio.zip');
    expect(studioBundleFileName('   ')).toBe('studio-project.frameleaf-studio.zip');
  });
});

describe('snapshots and results', () => {
  it('parses an export snapshot and drops embed rows it does not recognise', () => {
    const snapshot = parseBundleExportSnapshot({
      kind: 'studio-bundle-export',
      projectId: 'p',
      revision: 3,
      digest: 'd',
      includeMedia: true,
      embed: [{ key: 'k', kind: 'library-asset', id: assetA }, { key: 'bad', kind: 'nope', id: 'x' }, 'junk'],
    });
    expect(snapshot.embed).toEqual([{ key: 'k', kind: 'library-asset', id: assetA }]);
    expect(() => parseBundleExportSnapshot({ kind: 'other' })).toThrow(StudioBundleArchiveError);
  });

  it('parses an import snapshot and keeps only string mappings', () => {
    const snapshot = parseBundleImportSnapshot({
      kind: 'studio-bundle-import',
      uploadId: 'u',
      digest: 'd',
      name: '  Imported  ',
      mapping: { a: assetA, b: 3 },
    });
    expect(snapshot.name).toBe('Imported');
    expect(snapshot.mapping).toEqual({ a: assetA });
  });

  it('treats an export as downloadable only before expiry and before the sweep removed it', () => {
    const now = new Date('2026-09-22T12:00:00.000Z');
    const result = {
      path: '/x',
      fileName: 'x.zip',
      sizeBytes: 1,
      digest: 'd',
      expiresAt: '2026-09-23T12:00:00.000Z',
      embedded: 0,
      referenced: 0,
    };
    expect(isBundleExportDownloadable(result, now)).toBe(true);
    expect(isBundleExportDownloadable({ ...result, expiresAt: '2026-09-22T11:00:00.000Z' }, now)).toBe(false);
    expect(isBundleExportDownloadable({ ...result, expiredAt: '2026-09-22T11:30:00.000Z' }, now)).toBe(false);
    expect(isBundleExportDownloadable(null, now)).toBe(false);
  });
});
