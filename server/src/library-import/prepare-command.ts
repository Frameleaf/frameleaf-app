import { dirname } from 'node:path';
import { z } from 'zod';
import { importSourceSchema } from '#library-import-transfer/import-plan';
import { privateImportPathSchema, readPrivateImportJSON } from 'src/library-import/command-input.js';
import { requestImportPreparationAuthority } from 'src/library-import/manager-authority.js';
import {
  DESTINATION_ROOT,
  inspectPreparationSource,
  preparePreparationSource,
} from 'src/library-import/preparation/prepare.js';
import { type PreparationAdapter } from 'src/library-import/preparation/types.js';
import { LibraryImportRefused } from 'src/library-import/state.js';

/** Source kinds the Manager can import; each has `preparation/<kind>.ts` exporting `adapter`. */
export const preparationAdapterKinds = [
  'photoprism',
  'photoview',
  'pigallery2',
  'lychee',
  'nextcloud',
  'piwigo',
  'librephotos',
  'ente',
] as const;

const id = z.string().min(1).max(1024);
const requestSchema = z.strictObject({
  format: z.literal('frameleaf-prepare-library-import'),
  version: z.literal(2),
  action: z.enum(['inspect', 'prepare']),
  operationId: z.uuid(),
  destinationId: z.uuid(),
  source: importSourceSchema,
  snapshotPath: privateImportPathSchema.optional(),
  /** Restored source database on the preparation's isolated network. */
  databaseUrl: z
    .string()
    .max(2048)
    .regex(/^(mysql|postgres(ql)?):\/\//u)
    .optional(),
  originalsRoot: z.string().regex(/^\/import-media\/[a-z0-9][a-z0-9_-]*$/u),
  sourceRootPath: privateImportPathSchema.optional(),
  approvedLossCodes: z.array(id).max(1000),
  owners: z
    .array(
      z.strictObject({
        sourceId: id,
        destinationId: z.uuid(),
        email: z.email().max(254),
        acknowledgeRestrictions: z.boolean().optional(),
      }),
    )
    .max(10_000),
});

export const loadPreparationAdapter = async (kind: string): Promise<PreparationAdapter> => {
  if (!(preparationAdapterKinds as readonly string[]).includes(kind))
    throw new LibraryImportRefused('IMPORT_PREPARATION_INPUT_INVALID');
  const { adapter } = (await import(`./preparation/${kind}.js`)) as { adapter: PreparationAdapter };
  return adapter;
};

/**
 * Exactly one delivery: a staged SQLite snapshot, a loopback database URL, or neither — only for an adapter that
 * reads an `export` folder from `originalsRoot` (Ente).
 */
export function assertPreparationLocation(
  input: { snapshotPath?: string; databaseUrl?: string },
  adapter: Pick<PreparationAdapter, 'databases'>,
  stagingRoot: string,
) {
  const database = input.databaseUrl?.startsWith('mysql')
    ? 'mysql'
    : input.databaseUrl
      ? 'postgres'
      : input.snapshotPath === undefined
        ? 'export'
        : 'sqlite';
  if (
    (input.snapshotPath !== undefined && input.databaseUrl !== undefined) ||
    !adapter.databases.includes(database) ||
    (input.databaseUrl !== undefined && new URL(input.databaseUrl).hostname !== '127.0.0.1') ||
    (input.snapshotPath !== undefined && !input.snapshotPath.startsWith(stagingRoot + '/'))
  )
    throw new LibraryImportRefused('IMPORT_PREPARATION_INPUT_INVALID');
}

/** Private offline preparation. Only the Manager's live approval authorizes this exact request. */
export async function prepareLibraryImport(
  configPath: string,
  authorize = requestImportPreparationAuthority,
  /** Container mount → path; the native qualification maps the fixed mounts to its own directories. */
  mount = (path: string) => path,
) {
  const { value, sha256 } = await readPrivateImportJSON(configPath, 512 * 1024 * 1024);
  const parsed = requestSchema.safeParse(value);
  const stagingRoot = dirname(configPath);
  if (!parsed.success) throw new LibraryImportRefused('IMPORT_PREPARATION_INPUT_INVALID');
  const input = { ...parsed.data, originalsRoot: mount(parsed.data.originalsRoot) };
  const adapter = await loadPreparationAdapter(input.source.kind);
  assertPreparationLocation(input, adapter, stagingRoot);
  const seal = {
    operationId: input.operationId,
    destinationId: input.destinationId,
    source: input.source,
    preparationSha256: sha256,
  };
  const verifySource = () => authorize(seal);
  if (input.action === 'inspect') {
    await verifySource();
    const inspection = await inspectPreparationSource(adapter, input);
    await verifySource();
    return inspection;
  }
  const result = await preparePreparationSource(adapter, {
    ...input,
    stagingRoot,
    destinationRoot: mount(DESTINATION_ROOT),
    approvedLossCodes: new Set(input.approvedLossCodes),
    verifySource,
  });
  return result.receipt;
}
