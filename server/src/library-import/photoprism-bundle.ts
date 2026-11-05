import { createHash } from 'node:crypto';
import { type BigIntStats } from 'node:fs';
import { writeLibraryImportBundle } from 'src/library-import/bundle-output.js';
import { openPrivateImportFile } from 'src/library-import/command-input.js';
import { type ImportManifest } from 'src/library-import/manifest.js';
import { parseImportedOwnerIntent } from 'src/library-import/owner-reconciliation.js';
import { type PhotoprismInventoryRecord, readPhotoprismInventory } from 'src/library-import/photoprism-inventory.js';
import { assemblePhotoprismManifest } from 'src/library-import/photoprism-manifest.js';
import { openPhotoprismSnapshot } from 'src/library-import/photoprism.js';
import { LibraryImportRefused } from 'src/library-import/state.js';
import { reviewImportFiles } from 'src/library-import/transfer-runtime.js';

type BundleInput = Parameters<typeof writeLibraryImportBundle>[0];

type PublishInput = {
  approvedLossCodes: ReadonlySet<string>;
  roots: unknown;
  placements: unknown;
  ownerMappings: unknown;
  owners: BundleInput['owners'];
  stagingRoot: string;
  operationId: string;
  destinationId: string;
  verifySource: () => Promise<void>;
};

/** The adapter supplies qualified account, privacy, and original-file evidence from its frozen snapshot. */
export async function publishPhotoprismImportBundle(
  input: PublishInput & {
    records: Iterable<PhotoprismInventoryRecord>;
    observed: Parameters<typeof assemblePhotoprismManifest>[1];
  },
) {
  await input.verifySource();
  return publishAdapterImportBundle({ ...input, ...assemblePhotoprismManifest(input.records, input.observed) });
}

/** Source-neutral publication of one adapter's manifest and archive; the caller has already fenced the source. */
export async function publishAdapterImportBundle(
  input: PublishInput & { manifest: ImportManifest; archive: BundleInput['records'] },
) {
  const { manifest, archive } = input;
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

/** Read compatible verifiers from the same sealed SQLite snapshot as the asset inventory. */
export async function publishPhotoprismSqliteBundle(
  input: Omit<Parameters<typeof publishPhotoprismImportBundle>[0], 'records' | 'owners' | 'ownerMappings'> & {
    snapshotPath: string;
    ownerMappings: { sourceId: string; destinationId: string }[];
    ownerIntents: unknown[];
  },
) {
  const { source } = input.observed;
  const identity = (stat: BigIntStats) => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
  let sealed: string | undefined;
  const verifySource = async () => {
    await input.verifySource();
    const file = await openPrivateImportFile(input.snapshotPath);
    try {
      const before = identity(await file.stat({ bigint: true }));
      if (sealed === undefined) {
        const hash = createHash('sha256');
        for await (const bytes of file.createReadStream({ autoClose: false })) hash.update(bytes);
        if (hash.digest('hex') !== source.revision || identity(await file.stat({ bigint: true })) !== before)
          throw new LibraryImportRefused('IMPORT_SOURCE_SNAPSHOT_CHANGED');
        sealed = before;
      } else if (sealed !== before) {
        throw new LibraryImportRefused('IMPORT_SOURCE_SNAPSHOT_CHANGED');
      }
    } finally {
      await file.close();
    }
  };
  await verifySource();
  const snapshot = openPhotoprismSnapshot(input.snapshotPath, source.version);
  try {
    const mapped = new Map(input.ownerMappings.map(({ sourceId, destinationId }) => [sourceId, destinationId]));
    const users = new Map([...snapshot.rows('users')].flat().map((row) => [row.user_uid, row]));
    const owners = [];
    for (const raw of input.ownerIntents) {
      const intent = parseImportedOwnerIntent(raw);
      const destinationUserId = mapped.get(intent.sourceUserId);
      if (!destinationUserId || intent.login.snapshotSha256 !== source.revision)
        throw new LibraryImportRefused('OWNER_QUALIFICATION_CHANGED');
      const preserve =
        intent.disposition.kind === 'preserve' ||
        (intent.disposition.kind === 'restricted' && intent.disposition.credential === 'preserve');
      const user = users.get(intent.sourceUserId);
      if (
        preserve &&
        (!user ||
          user.id !== 1n ||
          user.auth_provider !== 'local' ||
          user.auth_method !== '' ||
          user.super_admin !== 1n ||
          user.can_login !== 1n ||
          user.user_role !== 'admin' ||
          user.user_scope !== '*' ||
          user.user_attr !== '' ||
          user.base_path !== '' ||
          user.expires_at !== null ||
          user.deleted_at !== null)
      )
        throw new LibraryImportRefused('PHOTOPRISM_PASSWORD_POLICY_UNQUALIFIED');
      const credential = preserve
        ? await snapshot.password({
            operationId: input.operationId,
            sourceUserId: intent.sourceUserId,
            destinationUserId,
          })
        : undefined;
      owners.push({ intent, credential });
    }
    return await publishPhotoprismImportBundle({
      ...input,
      records: readPhotoprismInventory(input.snapshotPath, source.version),
      owners,
      verifySource,
    });
  } finally {
    snapshot.close();
  }
}
