import type { DatabaseSchema } from '@frameleaf/sql-tools';
import { assertCanonicalDestination } from 'src/immich-import/destination-schema.js';
import { ImportDatabase } from 'src/immich-import/types.js';
import { getFrameleafSchema } from 'src/schema/frameleaf-schema.js';

vi.mock('src/schema/frameleaf-schema.js', () => ({ getFrameleafSchema: vi.fn() }));

// Minimal reader plumbing fixture only; medium tests use the complete real pinned baseline.
const catalog = (): DatabaseSchema => ({
  databaseName: 'fixture',
  schemaName: 'public',
  sequences: [],
  tables: [],
  functions: [],
  enums: [],
  extensions: [],
  parameters: [],
  overrides: [],
  warnings: [],
});
const destination = (): ImportDatabase => {
  const db: ImportDatabase = {
    query: vi.fn().mockResolvedValue([{ constraints: [], triggers: [] }]),
    transaction: async (body) => body(db),
    readSchema: vi.fn().mockResolvedValue(catalog()),
  };
  return db;
};
beforeEach(() => {
  vi.mocked(getFrameleafSchema).mockReset().mockReturnValue(catalog());
});

it('requires both the owned reader and independently queried raw metadata', async () => {
  const db = destination();
  await expect(assertCanonicalDestination(db)).resolves.toBeUndefined();
  expect(db.query).toHaveBeenCalledWith(expect.stringContaining('pg_get_constraintdef'));
  expect(db.query).toHaveBeenCalledWith(expect.stringContaining('pg_get_triggerdef'));
  delete db.readSchema;
  await expect(assertCanonicalDestination(db)).rejects.toThrow('DESTINATION_SCHEMA_NOT_CANONICAL');
});

it('fails closed on missing artifacts, reader warnings and catalog failures without printing the cause', async () => {
  const db = destination();
  vi.mocked(getFrameleafSchema).mockImplementationOnce(() => {
    throw new Error('missing pinned artifact');
  });
  await expect(assertCanonicalDestination(db)).rejects.toThrow('DESTINATION_SCHEMA_NOT_CANONICAL');
  vi.mocked(db.readSchema!).mockResolvedValueOnce({ ...catalog(), warnings: ['unreadable column type'] });
  await expect(assertCanonicalDestination(db)).rejects.toThrow('DESTINATION_SCHEMA_NOT_CANONICAL');
  vi.mocked(db.readSchema!).mockRejectedValueOnce(new Error('secret-bearing connection failure'));
  const failure = await assertCanonicalDestination(db).catch((error: unknown) => error);
  expect(String(failure)).toBe('Error: Immich import refused: DESTINATION_SCHEMA_NOT_CANONICAL');
});

it('refuses unexpected application objects and raw trigger drift even when the modeled reader is unchanged', async () => {
  const db = destination();
  vi.mocked(db.readSchema!).mockResolvedValueOnce({
    ...catalog(),
    tables: [
      { name: 'extra_application_table', columns: [], constraints: [], indexes: [], triggers: [], synchronize: true },
    ],
  });
  await expect(assertCanonicalDestination(db)).rejects.toThrow('DESTINATION_SCHEMA_NOT_CANONICAL');
  vi.mocked(db.query).mockResolvedValueOnce([
    {
      constraints: [],
      triggers: [
        {
          schema: 'public',
          table: 'asset',
          name: 'unexpected_trigger',
          definition: 'CREATE TRIGGER unexpected_trigger',
        },
      ],
    },
  ]);
  await expect(assertCanonicalDestination(db)).rejects.toThrow('DESTINATION_SCHEMA_NOT_CANONICAL');
  vi.mocked(db.query).mockResolvedValueOnce([]);
  await expect(assertCanonicalDestination(db)).rejects.toThrow('DESTINATION_SCHEMA_NOT_CANONICAL');
});
