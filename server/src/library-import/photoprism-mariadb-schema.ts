import { z } from 'zod';
import fixture from 'src/library-import/fixtures/photoprism/261029-mariadb114.json' with { type: 'json' };
import { mysqlSchemaFingerprint } from 'src/library-import/mysql-schema.js';

const migration = z.object({
  id: z.string(),
  dialect: z.string(),
  stage: z.string(),
  error: z.literal(''),
  finished_at: z.string(),
});
const version = z.object({ version: z.string(), error: z.literal(''), migrated_at: z.string() });
const completed = (value: string) => !value.startsWith('0001-01-01') && Number.isFinite(Date.parse(value));
const refuse = (code: string): never => {
  throw new Error(`PhotoPrism source refused: ${code}`);
};

/**
 * Schema admission only; source fencing, original bytes, ownership and privacy require separate qualification.
 * `bestEffort` (owner decision FL-1149) skips the version, engine-version, schema-fingerprint, required-migration and
 * build pins; it still requires every recorded migration and the latest version row to have completed without error.
 */
export const admitPhotoprismMariadbSchema = (
  input: {
    schema: unknown;
    version: string;
    databaseVersion: string;
    lowerCaseTableNames: number;
    migrations: unknown;
    versions: unknown;
  },
  options: { bestEffort?: boolean } = {},
): string => {
  const bestEffort = options.bestEffort === true;
  if (!bestEffort && input.version !== fixture.source.version) return refuse('PHOTOPRISM_VERSION_UNQUALIFIED');
  if (
    (!bestEffort && input.databaseVersion !== fixture.runtime.databaseVersion) ||
    input.lowerCaseTableNames !== fixture.runtime.lowerCaseTableNames
  )
    return refuse('PHOTOPRISM_ENGINE_UNQUALIFIED');
  let fingerprint = '';
  try {
    fingerprint = mysqlSchemaFingerprint(input.schema, '');
  } catch {
    if (!bestEffort) return refuse('PHOTOPRISM_SCHEMA_UNQUALIFIED');
  }
  if (!bestEffort && fingerprint !== fixture.schemaSha256) return refuse('PHOTOPRISM_SCHEMA_UNQUALIFIED');
  const migrations = z.array(migration).safeParse(input.migrations);
  const required = new Map(fixture.migrations.map((row) => [row.id, row]));
  if (!migrations.success) return refuse('PHOTOPRISM_MIGRATIONS_INCOMPLETE');
  for (const row of migrations.data) {
    if (!completed(row.finished_at)) return refuse('PHOTOPRISM_MIGRATIONS_INCOMPLETE');
    if (bestEffort) continue;
    const expected = required.get(row.id);
    if (!expected || row.dialect !== expected.dialect || row.stage !== expected.stage)
      return refuse('PHOTOPRISM_MIGRATIONS_INCOMPLETE');
    required.delete(row.id);
  }
  if (!bestEffort && required.size > 0) return refuse('PHOTOPRISM_MIGRATIONS_INCOMPLETE');
  // The reader selects the latest version row, rather than accepting a historical successful build.
  const versions = z.array(version).length(1).safeParse(input.versions);
  if (
    !versions.success ||
    (!bestEffort && versions.data[0].version !== fixture.source.executableVersion) ||
    !completed(versions.data[0].migrated_at)
  )
    return refuse('PHOTOPRISM_BUILD_UNQUALIFIED');
  return fingerprint;
};
