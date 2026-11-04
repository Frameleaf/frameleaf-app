import { writeLibraryImportBundle } from 'src/library-import/bundle-output.js';
import { type PhotoprismInventoryRecord } from 'src/library-import/photoprism-inventory.js';
import { assemblePhotoprismManifest } from 'src/library-import/photoprism-manifest.js';
import { LibraryImportRefused } from 'src/library-import/state.js';
import { reviewImportFiles } from 'src/library-import/transfer-runtime.js';

type BundleInput = Parameters<typeof writeLibraryImportBundle>[0];

/** The adapter supplies qualified account, privacy, and original-file evidence from its frozen snapshot. */
export async function publishPhotoprismImportBundle(input: {
  records: Iterable<PhotoprismInventoryRecord>;
  observed: Parameters<typeof assemblePhotoprismManifest>[1];
  approvedLossCodes: ReadonlySet<string>;
  roots: unknown;
  placements: unknown;
  ownerMappings: unknown;
  owners: BundleInput['owners'];
  stagingRoot: string;
  operationId: string;
  destinationId: string;
  verifySource: () => Promise<void>;
}) {
  await input.verifySource();
  const { manifest, archive } = assemblePhotoprismManifest(input.records, input.observed);
  for (const loss of manifest.losses) {
    if (!input.approvedLossCodes.has(loss.code)) throw new LibraryImportRefused('IMPORT_LOSSES_NOT_ACKNOWLEDGED');
    loss.acknowledged = true;
  }
  const plan = await reviewImportFiles({
    version: 2,
    source: manifest.source,
    destinationId: input.destinationId,
    owners: input.ownerMappings,
    roots: input.roots,
    files: input.placements,
  });
  await input.verifySource();
  const bundle = await writeLibraryImportBundle({
    stagingRoot: input.stagingRoot,
    operationId: input.operationId,
    destinationId: input.destinationId,
    manifest,
    plan,
    owners: input.owners,
    records: archive,
  });
  await input.verifySource();
  return bundle;
}
