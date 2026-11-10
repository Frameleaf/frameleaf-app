import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from 'src/immich-import/adapters.js';
import { assertCanonicalDestination } from 'src/immich-import/destination-schema.js';
import { ImmichImportService } from 'src/immich-import/importer.js';
import { ImportConfig, ImportDatabase, ImportRow } from 'src/immich-import/types.js';

vi.mock('src/immich-import/destination-schema.js', () => ({ assertCanonicalDestination: vi.fn() }));

let admissionDirectory: string;
beforeEach(async () => {
  admissionDirectory = await mkdtemp(join(tmpdir(), 'import-admission-'));
  await mkdir(join(admissionDirectory, 'source'));
  await mkdir(join(admissionDirectory, 'target'));
  config.mediaRoots = [{ source: join(admissionDirectory, 'source'), target: join(admissionDirectory, 'target') }];
  vi.mocked(assertCanonicalDestination).mockReset().mockResolvedValue(undefined);
});

afterEach(async () => rm(admissionDirectory, { recursive: true, force: true }));

const config: ImportConfig = {
  version: '3.2.4',
  sourceId: 'source-library',
  writersStopped: true,
  mediaRoots: [{ source: '/source', target: '/target' }],
};
const createImporter = (run?: ImportRow, populated = false) => {
  const statements: string[] = [];
  const source: ImportDatabase = {
    query: () => Promise.resolve([{ system_identifier: 'source', database_oid: '1' }]),
    transaction: async (body) => body(source),
  };
  const destination: ImportDatabase = {
    query: async (statement) => {
      await Promise.resolve();
      statements.push(statement);
      if (statement.includes('pg_control_system')) return [{ system_identifier: 'destination', database_oid: '1' }];
      if (statement.includes('server_version_num')) return [{ version: 190_000 }];
      if (statement.includes('FROM pg_extension')) return [{ extname: 'vector' }];
      if (statement.includes('pg_get_indexdef'))
        return [
          { relname: 'clip_index', amname: 'hnsw', definition: 'embedding vector_cosine_ops' },
          { relname: 'face_index', amname: 'hnsw', definition: 'embedding vector_cosine_ops' },
        ];
      if (statement.includes('SELECT status,source_fingerprint')) return run ? [run] : [];
      if (statement.includes('FROM pg_tables')) return [{ tablename: 'user' }];
      if (statement.includes('SELECT 1 FROM public."user"')) return populated ? [{ exists: true }] : [];
      if (statement.includes('pg_try_advisory_lock')) return [{ acquired: true }];
      if (statement.includes('count(*)')) return [{ count: statement.includes('dispatched_at') ? '1' : '0' }];
      return [];
    },
    transaction: async (body) => body(destination),
  };
  const importer = new ImmichImportService(destination, source, { ...config });
  vi.spyOn(importer.source, 'preflight').mockResolvedValue('same-source');
  return { importer, statements };
};

describe('import admission and activation gates', () => {
  it('checks empty media roots before consulting source or writing a journal', async () => {
    const { importer, statements } = createImporter();
    importer.config.mediaRoots = [{ source: admissionDirectory, target: admissionDirectory }];
    await expect(importer.preflight()).rejects.toThrow('INDEPENDENT_COPY');
    expect(importer.source.preflight).not.toHaveBeenCalled();
    expect(statements).toEqual([]);
  });

  it('rechecks empty roots after dispatch before activation when a destination becomes a source alias', async () => {
    const { importer, statements } = createImporter({
      status: 'verifying',
      source_fingerprint: 'same-source',
      config_fingerprint: digest(config),
    });
    vi.spyOn(importer.source, 'batches').mockImplementation(async function* () {});
    const query = importer.destination.query.bind(importer.destination);
    vi.spyOn(importer.destination, 'query').mockImplementation((statement, values) =>
      statement.includes('dispatched_at IS NULL') ? Promise.resolve([{ count: '0' }]) : query(statement, values),
    );
    const dispatch = vi.fn(async () => {
      await rm(config.mediaRoots[0].target, { recursive: true });
      await symlink(config.mediaRoots[0].source, config.mediaRoots[0].target);
    });
    await expect(importer.verify(dispatch)).rejects.toThrow('INDEPENDENT_COPY');
    expect(dispatch).toHaveBeenCalledOnce();
    expect(statements.some((statement) => statement.includes("SET status='activated'"))).toBe(false);
  });

  it('refuses destination drift before journal writes', async () => {
    const { importer, statements } = createImporter();
    vi.mocked(assertCanonicalDestination).mockRejectedValueOnce(new Error('DESTINATION_SCHEMA_NOT_CANONICAL'));
    await expect(importer.run()).rejects.toThrow('DESTINATION_SCHEMA_NOT_CANONICAL');
    expect(statements.some((statement) => /^(INSERT|UPDATE)/u.test(statement))).toBe(false);
  });

  it('refuses changing a journal from independent-copy to Manager in-place', async () => {
    const { importer, statements } = createImporter({
      status: 'copying',
      source_fingerprint: 'same-source',
      config_fingerprint: digest(config),
    });
    importer.config.mediaRoots = [{ source: '/source', target: '/source' }];
    importer.config.media = {
      mode: 'manager-in-place',
      authority: 'frameleaf-manager',
      operationId: 'operation-1',
      deploymentId: 'deployment-1',
    };
    await expect(importer.run(true)).rejects.toThrow('RESUME_SOURCE_OR_CONFIGURATION_CHANGED');
    expect(statements.some((statement) => /^(INSERT|UPDATE)/u.test(statement))).toBe(false);
  });

  it.each([
    { scope: 'unadmitted', space: null, key: 'legacy', producerScope: 'unadmitted', accepted: true },
    { scope: 'clip', space: {}, key: 'legacy', producerScope: 'unadmitted', accepted: false },
    { scope: 'unadmitted', space: null, key: 'image:clip:changed', producerScope: 'unadmitted', accepted: false },
    { scope: 'unadmitted', space: null, key: 'legacy', producerScope: 'clip', accepted: false },
  ])('admits only pristine desktop CLIP bootstrap rows: %j', async (seed) => {
    const { importer, statements } = createImporter();
    const query = importer.destination.query.bind(importer.destination);
    vi.spyOn(importer.destination, 'query').mockImplementation((sql, args) => {
      if (sql.includes('FROM pg_tables'))
        return Promise.resolve([{ tablename: 'desktop_clip_index' }, { tablename: 'desktop_clip_producer' }]);
      if (sql.includes('FROM public."desktop_clip_index"'))
        return Promise.resolve([{ scope: seed.scope, space: seed.space }]);
      if (sql.includes('FROM public."desktop_clip_producer"'))
        return Promise.resolve([{ key: seed.key, scope: seed.producerScope }]);
      return query(sql, args);
    });
    if (seed.accepted) await expect(importer.preflight()).resolves.toMatchObject({ status: 'fresh' });
    else await expect(importer.preflight()).rejects.toThrow('DESTINATION_NOT_FRESH');
    expect(statements.some((statement) => /^(INSERT|UPDATE)/u.test(statement))).toBe(false);
  });

  it('refuses populated destinations before journal writes', async () => {
    const { importer, statements } = createImporter(undefined, true);
    await expect(importer.run()).rejects.toThrow('DESTINATION_NOT_FRESH');
    expect(statements.some((statement) => /^(INSERT|UPDATE)/u.test(statement))).toBe(false);
  });

  it.each([
    { status: 'copying', source_fingerprint: 'another-source', config_fingerprint: digest(config) },
    { status: 'copying', source_fingerprint: 'same-source', config_fingerprint: 'changed-map' },
    { status: 'abandoned', source_fingerprint: 'same-source', config_fingerprint: digest(config) },
  ])('refuses changed or abandoned resumptions', async (state) => {
    const { importer, statements } = createImporter(state);
    await expect(importer.run(true)).rejects.toThrow();
    expect(statements.some((statement) => /^(INSERT|UPDATE)/u.test(statement))).toBe(false);
  });

  it('does not activate until derived repair is durably dispatched', async () => {
    const { importer, statements } = createImporter({
      status: 'verifying',
      source_fingerprint: 'same-source',
      config_fingerprint: digest(config),
    });
    vi.spyOn(importer.source, 'batches').mockImplementation(async function* () {});
    const dispatch = vi.fn().mockResolvedValue(undefined);
    await expect(importer.verify(dispatch)).rejects.toThrow('DERIVED_WORK_NOT_DURABLY_DISPATCHED');
    expect(dispatch).toHaveBeenCalledOnce();
    expect(statements.some((statement) => statement.includes("SET status='activated'"))).toBe(false);
  });

  it('permission row mismatch blocks dispatch and activation', async () => {
    const { importer, statements } = createImporter({
      status: 'verifying',
      source_fingerprint: 'same-source',
      config_fingerprint: digest(config),
    });
    vi.spyOn(importer.source, 'batches').mockImplementation(async function* (table) {
      await Promise.resolve();
      if (table === 'album_user')
        yield [{ row: { albumId: 'album', userId: 'owner', role: 'owner' }, cursor: ['album', 'owner'] }];
    });
    const dispatch = vi.fn();
    await expect(importer.verify(dispatch)).rejects.toThrow('DESTINATION_ROW_OR_PERMISSION_MISMATCH');
    expect(dispatch).not.toHaveBeenCalled();
    expect(statements.some((statement) => statement.includes("SET status='activated'"))).toBe(false);
  });
});

describe('mapped external originals', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'import-external-'));
    await mkdir(join(directory, 'source'));
    await mkdir(join(directory, 'target'));
  });
  afterEach(async () => rm(directory, { recursive: true, force: true }));

  it('writes the checksum of the mapped external path while verifying the original source path hash', async () => {
    const sourcePath = join(directory, 'source', 'photo.jpg');
    const targetPath = join(directory, 'target', 'photo.jpg');
    await writeFile(sourcePath, 'photo');
    await writeFile(targetPath, 'photo');
    const statements: { sql: string; values: unknown[] }[] = [];
    const db: ImportDatabase = {
      query: async (sql, values = []) => {
        await Promise.resolve();
        statements.push({ sql, values });
        return sql.includes('pg_try_advisory_lock') ? [{ acquired: true }] : [];
      },
      transaction: async (body) => body(db),
    };
    const importer = new ImmichImportService(db, db, {
      ...config,
      mediaRoots: [{ source: join(directory, 'source'), target: join(directory, 'target') }],
    });
    vi.spyOn(importer, 'preflight').mockResolvedValue({
      sourceVersion: '3.2.4',
      sourceCommit: 'fixture',
      notImported: [],
      fingerprint: 'same',
      status: 'fresh',
      embeddings: [],
    });
    vi.spyOn(importer.source, 'batches').mockImplementation(async function* (table) {
      await Promise.resolve();
      if (table === 'asset')
        yield [
          {
            row: {
              id: 'asset',
              originalPath: sourcePath,
              isExternal: true,
              libraryId: 'library',
              checksumAlgorithm: 'sha1-path',
              checksum: String.raw`\x${createHash('sha1').update(`path:${sourcePath}`).digest('hex')}`,
            },
            cursor: ['asset'],
          },
        ];
    });
    await importer.run();
    const inserted = statements.find(({ sql }) => sql.startsWith('INSERT INTO public."asset"'))!;
    expect(JSON.parse(String(inserted.values[0]))).toMatchObject({
      originalPath: targetPath,
      checksum: String.raw`\x${createHash('sha1').update(`path:${targetPath}`).digest('hex')}`,
      checksumAlgorithm: 'sha1-path',
    });
  });

  it('rechecks independent copy ownership before dispatch or activation', async () => {
    const sourcePath = join(directory, 'source', 'photo.jpg');
    const targetPath = join(directory, 'target', 'photo.jpg');
    await writeFile(sourcePath, 'photo');
    await link(sourcePath, targetPath);
    const { importer, statements } = createImporter();
    importer.config.mediaRoots = [{ source: join(directory, 'source'), target: join(directory, 'target') }];
    vi.spyOn(importer, 'preflight').mockResolvedValue({
      sourceVersion: '3.2.4',
      sourceCommit: 'fixture',
      notImported: [],
      fingerprint: 'same',
      status: 'verifying',
      embeddings: [],
    });
    vi.spyOn(importer.source, 'batches').mockImplementation(async function* (table) {
      await Promise.resolve();
      if (table === 'asset')
        yield [
          {
            row: {
              id: 'asset',
              originalPath: sourcePath,
              checksumAlgorithm: 'sha1',
              checksum: createHash('sha1').update('photo').digest('hex'),
            },
            cursor: ['asset'],
          },
        ];
    });
    const dispatch = vi.fn();
    await expect(importer.verify(dispatch)).rejects.toThrow('INDEPENDENT_COPY');
    expect(dispatch).not.toHaveBeenCalled();
    expect(statements.some((sql) => sql.includes("status='activated'"))).toBe(false);
  });
});

describe('media location', () => {
  // Stock Immich compose: library mounted at /data, no IMMICH_MEDIA_LOCATION, saved location /data.
  const stockCompose = (saved: ImportRow[]) => {
    const { importer } = createImporter();
    importer.config.mediaRoots = [{ source: '/data', target: '/data' }];
    importer.config.media = {
      mode: 'manager-in-place',
      authority: 'frameleaf-manager',
      operationId: 'operation-1',
      deploymentId: 'deployment-1',
    };
    vi.spyOn(importer.source, 'batches').mockImplementation(async function* () {});
    const sourceQuery = importer.source.db.query.bind(importer.source.db);
    vi.spyOn(importer.source.db, 'query').mockImplementation((sql, args) =>
      sql.includes("key='MediaLocation'") ? Promise.resolve(saved) : sourceQuery(sql, args),
    );
    const writes: unknown[][] = [];
    const query = importer.destination.query.bind(importer.destination);
    vi.spyOn(importer.destination, 'query').mockImplementation((sql, args) => {
      if (sql.includes('MediaLocation')) writes.push(args ?? []);
      return query(sql, args);
    });
    return { importer, writes };
  };

  it("carries the source's saved media location so the server accepts the imported paths", async () => {
    const { importer, writes } = stockCompose([{ location: '/data' }]);
    await importer.run();
    expect(writes).toEqual([[JSON.stringify({ location: '/data' })]]);
  });

  it('writes nothing when the source never saved a location', async () => {
    const { importer, writes } = stockCompose([]);
    await importer.run();
    expect(writes).toEqual([]);
  });
});

describe('Noodle Gallery data that stays behind', () => {
  const run = async (notImported: string[]) => {
    const inserts: unknown[][] = [];
    const destination = {
      query: vi.fn(async (statement: string, parameters: unknown[] = []) => {
        await Promise.resolve();
        if (statement.includes('"isAdmin"')) return [{ id: 'admin-1' }, { id: 'admin-2' }];
        if (statement.includes('INSERT INTO public.notification')) inserts.push(parameters);
        return [];
      }),
      transaction: vi.fn(),
    } as unknown as ImportDatabase;
    const importer = new ImmichImportService(destination, destination, config);
    importer.source.notImported = notImported;
    await (importer as unknown as { reportNotImported(fingerprint: string): Promise<void> }).reportNotImported('f1');
    return inserts;
  };

  it('tells each administrator which Gallery features held data', async () => {
    const inserts = await run(['Spaces', 'pets']);
    expect(inserts.map(([, userId]) => userId)).toEqual(['admin-1', 'admin-2']);
    expect(inserts[0][3]).toContain('Spaces, pets');
    expect(JSON.parse(String(inserts[0][4]))).toEqual({
      kind: 'noodle-gallery-not-imported',
      items: ['Spaces', 'pets'],
    });
    // A repeated verification derives the same notification ids.
    expect((await run(['Spaces', 'pets']))[0][0]).toBe(inserts[0][0]);
  });

  it('sends nothing when no Gallery-only data held rows', async () => {
    expect(await run([])).toEqual([]);
  });
});

describe('fork sensitive detections', () => {
  const metadata = [
    { id: 'detected', value: { nsfwDetection: { status: 'success', result: { isNsfw: true } } } },
    { id: 'failed', value: { nsfwDetection: { status: 'failed', result: { isNsfw: true } } } },
    {
      id: 'reviewed-safe',
      value: { nsfwDetection: { status: 'success', result: { isNsfw: true }, review: { isNsfw: false } } },
    },
    { id: 'reviewed', value: { nsfwDetection: { review: { isNsfw: true } } } },
    {
      id: 'described',
      value: {
        description: {
          status: 'success',
          result: {
            description: 'A beach',
            safety: { is_nsfw_likely: true, confidence: 'High', indicators: ['nudity'], reason: '' },
          },
        },
      },
    },
    {
      id: 'described-weak',
      value: {
        description: {
          status: 'success',
          result: {
            description: 'A beach',
            safety: { is_nsfw_likely: true, confidence: 'high', indicators: ['swimwear'], reason: 'swimwear' },
          },
        },
      },
    },
  ];
  const convert = async (hideFromLibrary: string | null) => {
    const statements: { sql: string; parameters: unknown[] }[] = [];
    const destination = {
      query: vi.fn(async (sql: string, parameters: unknown[] = []) => {
        await Promise.resolve();
        statements.push({ sql, parameters });
        return sql.includes('FROM public.asset_metadata') && sql.includes('is_nsfw_likely') ? metadata : [];
      }),
      transaction: vi.fn(),
    } as unknown as ImportDatabase;
    const source = {
      query: vi.fn(async (sql: string) => {
        await Promise.resolve();
        return sql.includes('hideFromLibrary') && hideFromLibrary !== null ? [{ enabled: hideFromLibrary }] : [];
      }),
      transaction: vi.fn(),
    } as unknown as ImportDatabase;
    const importer = new ImmichImportService(destination, source, config);
    await (importer as unknown as { convertLocks(): Promise<void> }).convertLocks();
    const rebuilt = statements.find(({ sql }) => sql.includes('SET is_nsfw=true'));
    const locked = statements.filter(({ sql }) => sql.includes('WHERE is_nsfw'));
    return { rebuilt: rebuilt && JSON.parse(rebuilt.parameters[0] as string), locked };
  };

  it("rebuilds is_nsfw with the server's rule: reviews decide, failed detections and weak descriptions do not count", async () => {
    expect((await convert(null)).rebuilt).toEqual(['detected', 'reviewed', 'described']);
  });

  it('locks detections when the source hid them from the library', async () => {
    expect((await convert('true')).locked).toEqual([expect.objectContaining({ parameters: ['detected'] })]);
  });

  it('leaves detections unlocked when hiding was off or never saved', async () => {
    expect((await convert('false')).locked).toEqual([]);
    expect((await convert(null)).locked).toEqual([]);
  });
});

describe('a lost Immich original records what Immich knew', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'import-lost-'));
    await mkdir(join(directory, 'source', 'library', 'admin', '2021', '07'), { recursive: true });
    await mkdir(join(directory, 'target', 'library', 'admin', '2021', '07'), { recursive: true });
  });
  afterEach(async () => rm(directory, { recursive: true, force: true }));

  const fixture = readFileSync(new URL('fixtures/structure/3.1.0.sql', import.meta.url), 'utf8');
  const assetRow = (id: string, name: string, path: string) => ({
    id,
    ownerId: 'owner-1',
    storageLabel: 'admin',
    originalFileName: name,
    originalPath: path,
    isExternal: false,
    libraryId: null,
  });

  const setup = (moves: Array<{ entityId: string; newPath: string }>, hasTable = true) => {
    const roots = [{ source: join(directory, 'source'), target: join(directory, 'target') }];
    const findings = new Set<string>();
    const written: { finding?: unknown[]; steps: Array<Record<string, unknown>>; roots?: unknown[] }[] = [];
    const sourceQueries: string[] = [];
    const source: ImportDatabase = {
      query: (statement, values = []) => {
        sourceQueries.push(statement);
        if (statement.includes('to_regclass')) return Promise.resolve([{ present: hasTable }]);
        if (statement.includes('move_history')) {
          const ids = new Set(JSON.parse(String(values[0])) as string[]);
          return Promise.resolve(moves.filter(({ entityId }) => ids.has(entityId)));
        }
        return Promise.resolve([]);
      },
      transaction: (body) => body(source),
    };
    const destination: ImportDatabase = {
      query: (statement, values = []) => {
        if (statement.includes('FROM public.asset a')) {
          return Promise.resolve([
            assetRow('asset-moved', 'IMG_1.jpg', join(directory, 'target', 'library', 'admin', 'IMG_1.jpg')),
            assetRow('asset-plain', 'IMG_2.jpg', join(directory, 'target', 'library', 'admin', 'IMG_2.jpg')),
          ]);
        }
        if (statement.includes('INSERT INTO public.asset_health ')) {
          const key = String(values[0]);
          const fresh = !findings.has(key);
          findings.add(key);
          if (fresh) written.push({ finding: values, steps: JSON.parse(String(values.at(-1))) });
          return Promise.resolve([]);
        }
        if (statement.includes("key='FileFixSourceRoots'") || statement.includes('file-fix-source-roots')) {
          written.push({ steps: [], roots: JSON.parse(String(values[0])) });
        }
        return Promise.resolve([]);
      },
      transaction: (body) => body(destination),
    };
    const importer = new ImmichImportService(destination, source, { ...config, mediaRoots: roots });
    const lost = (importer as unknown as { lostOriginals: Map<string, unknown> }).lostOriginals;
    lost.set('asset-moved', { reason: 'missing', immichPath: join(directory, 'source', 'library', 'admin', 'IMG_1.jpg') });
    lost.set('asset-plain', { reason: 'missing', immichPath: join(directory, 'source', 'library', 'admin', 'IMG_2.jpg') });
    const record = () =>
      (importer as unknown as { recordLostOriginalProblems(): Promise<void> }).recordLostOriginalProblems();
    return { importer, record, written, sourceQueries };
  };

  it('uses the frozen move_history shape', () => {
    const table = fixture.slice(fixture.indexOf('CREATE TABLE public.move_history'));
    const columns = table.slice(0, table.indexOf(');'));
    for (const column of ['"entityId" uuid', '"pathType"', '"oldPath"', '"newPath"']) expect(columns).toContain(column);
  });

  it('a lost Immich original records where Immich was moving it', async () => {
    const intended = join(directory, 'source', 'library', 'admin', '2021', '07', 'IMG_1.jpg');
    await writeFile(join(directory, 'target', 'library', 'admin', '2021', '07', 'IMG_1.jpg'), 'there');
    const { record, written } = setup([{ entityId: 'asset-moved', newPath: intended }]);

    await record();

    const moved = written.find((entry) => (entry.finding as unknown[] | undefined)?.[0] === 'asset-moved')!;
    expect(moved.finding).toEqual(
      expect.arrayContaining(['asset-moved', 'missing', 'missing', 'critical', 'IMG_1.jpg']),
    );
    expect(moved.steps).toEqual([
      {
        step: 'imported',
        outcome: 'failed',
        facts: { source: 'Immich', sourcePath: 'IMG_1.jpg', intendedPath: '2021/07/IMG_1.jpg' },
      },
      { step: 'looked-where-moving', outcome: 'ok', facts: { folder: '2021/07', name: 'IMG_1.jpg' } },
    ]);
  });

  it('says not-found when nothing is at the intended path', async () => {
    const intended = join(directory, 'source', 'library', 'admin', '2021', '07', 'IMG_1.jpg');
    const { record, written } = setup([{ entityId: 'asset-moved', newPath: intended }]);
    await record();
    const moved = written.find((entry) => (entry.finding as unknown[] | undefined)?.[0] === 'asset-moved')!;
    expect(moved.steps.map(({ step, outcome }) => [step, outcome])).toEqual([
      ['imported', 'failed'],
      ['looked-where-moving', 'not-found'],
    ]);
  });

  it('a lost original with no move record gets only imported/failed, and a re-run writes nothing twice', async () => {
    const { record, written } = setup([]);
    await record();
    await record();
    const findings = written.filter((entry) => entry.finding);
    expect(findings).toHaveLength(2);
    for (const { steps } of findings) {
      expect(steps.map(({ step, outcome }) => [step, outcome])).toEqual([['imported', 'failed']]);
      expect(steps[0].facts).not.toHaveProperty('intendedPath');
    }
  });

  it('does not ask about moves when the source has no move_history', async () => {
    const { record, sourceQueries } = setup([], false);
    await record();
    expect(sourceQueries.some((statement) => statement.includes('FROM public.move_history'))).toBe(false);
  });

  it('remembers the folders Immich used', async () => {
    const { importer, written } = setup([]);
    await (importer as unknown as { rememberSourceRoots(): Promise<void> }).rememberSourceRoots();
    expect(written.find((entry) => entry.roots)?.roots).toEqual([join(directory, 'source')]);
  });
});
