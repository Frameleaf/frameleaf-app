import { type ImportDatabase, ImportRefused } from 'src/immich-import/types.js';
import { assertFreshImportDestination } from 'src/library-import/admission.js';
import { LibraryImportJournal, LibraryImportRefused } from 'src/library-import/state.js';

vi.mock('src/library-import/admission.js', () => ({ assertFreshImportDestination: vi.fn() }));

const binding = {
  operationId: '11111111-1111-4111-8111-111111111111',
  manifestSha256: 'a'.repeat(64),
  planSha256: 'b'.repeat(64),
  source: {
    kind: 'photoview',
    version: '2.4.0',
    identity: 'synthetic',
    revision: 'frozen',
    schemaSha256: 'c'.repeat(64),
  },
};
const database = () => {
  const db: ImportDatabase = {
    query: vi.fn((statement: string) =>
      Promise.resolve(statement.includes('pg_try_advisory') ? [{ acquired: true }] : []),
    ),
    transaction: (body) => body(db),
  };
  return db;
};

beforeEach(() => vi.mocked(assertFreshImportDestination).mockReset());

it.each(['DESTINATION_NOT_FRESH', 'ORPHANED_IMPORT_JOURNAL'])(
  'reports %s as a generic import refusal',
  async (code) => {
    const db = database();
    vi.mocked(assertFreshImportDestination).mockRejectedValueOnce(new ImportRefused(code));
    const result = new LibraryImportJournal(db).begin(binding);
    await expect(result).rejects.toBeInstanceOf(LibraryImportRefused);
    await expect(result).rejects.toMatchObject({ code, message: `Library import refused: ${code}` });
    expect(vi.mocked(db.query).mock.calls.every(([statement]) => statement.startsWith('SELECT'))).toBe(true);
  },
);

it('retains unrelated admission errors unchanged', async () => {
  const error = new Error('synthetic transport failure');
  vi.mocked(assertFreshImportDestination).mockRejectedValueOnce(error);
  await expect(new LibraryImportJournal(database()).begin(binding)).rejects.toBe(error);
});
