import { createHash } from 'node:crypto';
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
