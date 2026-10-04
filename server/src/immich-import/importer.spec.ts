import { digest } from './adapters.js';
import { ImmichImportService } from './importer.js';
import { ImportConfig, ImportDatabase, ImportRow } from './types.js';

const config: ImportConfig = {
  version: '3.2.4',
  sourceId: 'source-library',
  writersStopped: true,
  mediaRoots: [{ source: '/source', target: '/target' }],
};
const createImporter = (run?: ImportRow, populated = false) => {
  const statements: string[] = [];
  const source: ImportDatabase = {
    query: async () => [{ system_identifier: 'source', database_oid: '1' }],
    transaction: async (body) => body(source),
  };
  const destination: ImportDatabase = {
    query: async (statement) => {
      statements.push(statement);
      if (statement.includes('pg_control_system')) return [{ system_identifier: 'destination', database_oid: '1' }];
      if (statement.includes('server_version_num')) return [{ version: 190000 }];
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
  const importer = new ImmichImportService(destination, source, config);
  vi.spyOn(importer.source, 'preflight').mockResolvedValue('same-source');
  return { importer, statements };
};

describe('import admission and activation gates', () => {
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
      if (table === 'album_user')
        yield [{ row: { albumId: 'album', userId: 'owner', role: 'owner' }, cursor: ['album', 'owner'] }];
    });
    const dispatch = vi.fn();
    await expect(importer.verify(dispatch)).rejects.toThrow('DESTINATION_ROW_OR_PERMISSION_MISMATCH');
    expect(dispatch).not.toHaveBeenCalled();
    expect(statements.some((statement) => statement.includes("SET status='activated'"))).toBe(false);
  });
});
