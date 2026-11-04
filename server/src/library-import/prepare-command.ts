import { dirname } from 'node:path';
import { z } from 'zod';
import { importSourceSchema } from '#library-import-transfer/import-plan';
import { privateImportPathSchema, readPrivateImportJSON } from 'src/library-import/command-input.js';
import { requestImportPreparationAuthority } from 'src/library-import/manager-authority.js';
import { importFileSchema, importTimestampSchema } from 'src/library-import/manifest.js';
import { publishPhotoprismSqliteBundle } from 'src/library-import/photoprism-bundle.js';
import { reviewPhotoprismInventory } from 'src/library-import/photoprism-inventory.js';
import { reviewPhotoviewInventory } from 'src/library-import/photoview-manifest.js';
import { openPhotoviewSnapshot } from 'src/library-import/photoview.js';
import { importSnapshotVerifier } from 'src/library-import/snapshot-proof.js';
import { LibraryImportRefused } from 'src/library-import/state.js';

const id = z.string().min(1).max(1024);
const snapshotRequest = {
  version: z.literal(1),
  operationId: z.uuid(),
  destinationId: z.uuid(),
  snapshotPath: privateImportPathSchema,
};
const inspectSchema = z.strictObject({
  ...snapshotRequest,
  format: z.literal('frameleaf-inspect-library-import'),
  adapter: z.enum(['photoprism-sqlite', 'photoview-sqlite']),
  source: importSourceSchema,
});
const prepareSchema = z.strictObject({
  ...snapshotRequest,
  format: z.literal('frameleaf-prepare-library-import'),
  adapter: z.literal('photoprism-sqlite'),
  observed: z.union([
    z.strictObject({
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
    z.strictObject({
      source: importSourceSchema,
      materializedAlbums: z.record(id, z.array(id)),
      singleOwner: z.strictObject({ sourceId: id, confirmEntireLibrary: z.literal(true) }),
      ownerEmail: z.email().max(254),
    }),
  ]),
  approvedLossCodes: z.array(id),
  roots: z.array(z.unknown()),
  placements: z.array(z.unknown()).optional(),
  copyRoots: z.strictObject({ source: id, destination: id }).optional(),
  ownerMappings: z.array(z.strictObject({ sourceId: id, destinationId: z.uuid() })),
  ownerIntents: z.array(z.unknown()).optional(),
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
  if (input.adapter !== `${source.kind}-sqlite`) throw new LibraryImportRefused('IMPORT_PREPARATION_INPUT_INVALID');
  const seal = {
    operationId: input.operationId,
    destinationId: input.destinationId,
    source,
    preparationSha256: sha256,
  };
  if (input.format === 'frameleaf-inspect-library-import') {
    const verify = importSnapshotVerifier(input.snapshotPath, source.revision, () => authorize(seal));
    await verify();
    if (input.adapter === 'photoview-sqlite') {
      const snapshot = openPhotoviewSnapshot(input.snapshotPath, source.version);
      try {
        const inventory = reviewPhotoviewInventory(snapshot, source.schemaSha256);
        await verify();
        return { operationId: input.operationId, destinationId: input.destinationId, source, inventory };
      } finally {
        snapshot.close();
      }
    }
    const inventory = reviewPhotoprismInventory(input.snapshotPath, source.version, source.schemaSha256);
    await verify();
    return { operationId: input.operationId, destinationId: input.destinationId, source, inventory };
  }
  if (
    (input.placements === undefined) === (input.copyRoots === undefined) ||
    (input.copyRoots && input.copyRoots.source === input.copyRoots.destination)
  )
    throw new LibraryImportRefused('IMPORT_PREPARATION_INPUT_INVALID');
  if ('singleOwner' in input.observed === (input.ownerIntents !== undefined))
    throw new LibraryImportRefused('IMPORT_PREPARATION_INPUT_INVALID');
  const result = await publishPhotoprismSqliteBundle({
    ...input,
    stagingRoot,
    approvedLossCodes: new Set(input.approvedLossCodes),
    verifySource: () => authorize(seal),
  });
  return result.receipt;
}
