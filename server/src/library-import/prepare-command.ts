import { dirname } from 'node:path';
import { z } from 'zod';
import { importSourceSchema } from '#library-import-transfer/import-plan';
import { privateImportPathSchema, readPrivateImportJSON } from 'src/library-import/command-input.js';
import { requestImportPreparationAuthority } from 'src/library-import/manager-authority.js';
import { importFileSchema, importTimestampSchema } from 'src/library-import/manifest.js';
import { photoprismSnapshotVerifier, publishPhotoprismSqliteBundle } from 'src/library-import/photoprism-bundle.js';
import { reviewPhotoprismInventory } from 'src/library-import/photoprism-inventory.js';
import { LibraryImportRefused } from 'src/library-import/state.js';

const id = z.string().min(1).max(1024);
const snapshotRequest = {
  version: z.literal(1),
  adapter: z.literal('photoprism-sqlite'),
  operationId: z.uuid(),
  destinationId: z.uuid(),
  snapshotPath: privateImportPathSchema,
};
const inspectSchema = z.strictObject({
  ...snapshotRequest,
  format: z.literal('frameleaf-inspect-library-import'),
  source: importSourceSchema,
});
const prepareSchema = z.strictObject({
  ...snapshotRequest,
  format: z.literal('frameleaf-prepare-library-import'),
  observed: z.strictObject({
    source: importSourceSchema,
    inventory: z.strictObject({
      complete: z.literal(true),
      ownershipComplete: z.literal(true),
      privacyComplete: z.literal(true),
      writersStopped: z.literal(true),
      revisionBefore: id,
      revisionAfter: id,
    }),
    photoOwners: z.record(id, id),
    albumOwners: z.record(id, id),
    files: z.array(importFileSchema.extend({ modifiedAt: importTimestampSchema })).optional(),
    materializedAlbums: z.record(id, z.array(id)),
  }),
  approvedLossCodes: z.array(id),
  roots: z.array(z.unknown()),
  placements: z.array(z.unknown()),
  ownerMappings: z.array(z.strictObject({ sourceId: id, destinationId: z.uuid() })),
  ownerIntents: z.array(z.unknown()),
});

const requestSchema = z.discriminatedUnion('format', [inspectSchema, prepareSchema]);

/** Private offline preparation. Only the Manager's live approval authorizes this exact request. */
export async function prepareLibraryImport(configPath: string, authorize = requestImportPreparationAuthority) {
  const { value, sha256 } = await readPrivateImportJSON(configPath, 512 * 1024 * 1024);
  const parsed = requestSchema.safeParse(value);
  const stagingRoot = dirname(configPath);
  if (!parsed.success || !parsed.data.snapshotPath.startsWith(stagingRoot + '/'))
    throw new LibraryImportRefused('IMPORT_PREPARATION_INPUT_INVALID');
  const input = parsed.data;
  const source = input.format === 'frameleaf-inspect-library-import' ? input.source : input.observed.source;
  if (source.kind !== 'photoprism') throw new LibraryImportRefused('IMPORT_PREPARATION_INPUT_INVALID');
  const seal = {
    operationId: input.operationId,
    destinationId: input.destinationId,
    source,
    preparationSha256: sha256,
  };
  if (input.format === 'frameleaf-inspect-library-import') {
    const verify = photoprismSnapshotVerifier(input.snapshotPath, source.revision, () => authorize(seal));
    await verify();
    const inventory = reviewPhotoprismInventory(input.snapshotPath, source.version, source.schemaSha256);
    await verify();
    return { operationId: input.operationId, destinationId: input.destinationId, source, inventory };
  }
  const result = await publishPhotoprismSqliteBundle({
    ...input,
    stagingRoot,
    approvedLossCodes: new Set(input.approvedLossCodes),
    verifySource: () => authorize(seal),
  });
  return result.receipt;
}
