import { createHash } from 'node:crypto';
import { type BigIntStats } from 'node:fs';
import { posix } from 'node:path';
import { writeLibraryImportBundle } from 'src/library-import/bundle-output.js';
import { openPrivateImportFile } from 'src/library-import/command-input.js';
import { parseImportedOwnerIntent } from 'src/library-import/owner-reconciliation.js';
import { type PhotoprismInventoryRecord, readPhotoprismInventory } from 'src/library-import/photoprism-inventory.js';
import { assemblePhotoprismManifest } from 'src/library-import/photoprism-manifest.js';
import { type PhotoprismRow, openPhotoprismSnapshot } from 'src/library-import/photoprism.js';
import { LibraryImportRefused } from 'src/library-import/state.js';
import { reviewImportFiles } from 'src/library-import/transfer-runtime.js';

type BundleInput = Parameters<typeof writeLibraryImportBundle>[0];
type ManifestEvidence = Parameters<typeof assemblePhotoprismManifest>[1];

export function photoprismCopyPlacements(
  records: PhotoprismInventoryRecord[],
  roots: { source: string; destination: string },
) {
  return records.flatMap((record) => {
    if (record.type !== 'file' || !record.value.role) return [];
    const file = record.value;
    const extension = posix.extname(file.path);
    if (Buffer.byteLength(extension) > 180) throw new LibraryImportRefused('PHOTOPRISM_FILE_NAME_UNSUPPORTED');
    return [
      {
        id: file.id,
        sourceAssetId: file.photoId,
        sourceFileId: file.id,
        mode: 'copy' as const,
        sourceRoot: roots.source,
        sourcePath: file.path,
        destinationRoot: roots.destination,
        destinationPath: `import-${createHash('sha256').update(file.id).digest('hex')}${extension}`,
        expectedBytes: file.bytes,
      },
    ];
  });
}

export function photoprismFileEvidence(
  records: PhotoprismInventoryRecord[],
  plan: Awaited<ReturnType<typeof reviewImportFiles>>,
): ManifestEvidence['files'] {
  const originals = records.flatMap((record) =>
    record.type === 'file' && record.value.role ? [{ ...record.value, role: record.value.role }] : [],
  );
  if (plan.version !== 2 || originals.length !== plan.files.length)
    throw new LibraryImportRefused('PHOTOPRISM_FILE_EVIDENCE_MISMATCH');
  const reviewed = new Map(plan.files.map((file) => [file.sourceFileId, file]));
  return originals.map((original) => {
    const file = reviewed.get(original.id);
    if (
      !file ||
      file.sourceAssetId !== original.photoId ||
      file.sourcePath !== original.path ||
      file.bytes !== original.bytes
    )
      throw new LibraryImportRefused('PHOTOPRISM_FILE_EVIDENCE_MISMATCH');
    return {
      id: original.id,
      path: original.path,
      bytes: file.bytes,
      sha256: file.sha256,
      role: original.role,
      modifiedAt: new Date(Number(BigInt(file.sourceIdentity.mtimeNs) / 1_000_000n)).toISOString(),
    };
  });
}

/** The adapter supplies qualified account, privacy, and original-file evidence from its frozen snapshot. */
export async function publishPhotoprismImportBundle(input: {
  records: Iterable<PhotoprismInventoryRecord>;
  observed: Omit<ManifestEvidence, 'files'> & { files?: ManifestEvidence['files'] };
  approvedLossCodes: ReadonlySet<string>;
  roots: unknown;
  placements?: unknown;
  copyRoots?: { source: string; destination: string };
  ownerMappings: unknown;
  owners: BundleInput['owners'];
  stagingRoot: string;
  operationId: string;
  destinationId: string;
  verifySource: () => Promise<void>;
}) {
  await input.verifySource();
  const records = [...input.records];
  const plan = await reviewImportFiles({
    version: 2,
    source: input.observed.source,
    destinationId: input.destinationId,
    owners: input.ownerMappings,
    roots: input.roots,
    files: input.copyRoots ? photoprismCopyPlacements(records, input.copyRoots) : input.placements,
  });
  if (input.copyRoots) {
    const source = plan.roots.find(({ id }) => id === input.copyRoots?.source);
    const destination = plan.roots.find(({ id }) => id === input.copyRoots?.destination);
    if (
      !source ||
      !destination ||
      source.path === destination.path ||
      source.path.startsWith(destination.path + '/') ||
      destination.path.startsWith(source.path + '/') ||
      (source.device === destination.device && source.inode === destination.inode)
    )
      throw new LibraryImportRefused('IMPORT_COPY_ROOTS_OVERLAP');
  }
  const files = input.observed.files ?? photoprismFileEvidence(records, plan);
  const { manifest, archive } = assemblePhotoprismManifest(records, { ...input.observed, files });
  for (const loss of manifest.losses) {
    if (!input.approvedLossCodes.has(loss.code)) throw new LibraryImportRefused('IMPORT_LOSSES_NOT_ACKNOWLEDGED');
    loss.acknowledged = true;
  }
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

/** Verify the approved bytes once, then check the same file identity at each authority boundary. */
export function photoprismSnapshotVerifier(snapshotPath: string, revision: string, authorize: () => Promise<void>) {
  const identity = (stat: BigIntStats) => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
  let sealed: string | undefined;
  return async () => {
    await authorize();
    const file = await openPrivateImportFile(snapshotPath);
    try {
      const before = identity(await file.stat({ bigint: true }));
      if (sealed === undefined) {
        const hash = createHash('sha256');
        for await (const bytes of file.createReadStream({ autoClose: false })) hash.update(bytes);
        if (hash.digest('hex') !== revision || identity(await file.stat({ bigint: true })) !== before)
          throw new LibraryImportRefused('IMPORT_SOURCE_SNAPSHOT_CHANGED');
        sealed = before;
      } else if (sealed !== before) {
        throw new LibraryImportRefused('IMPORT_SOURCE_SNAPSHOT_CHANGED');
      }
    } finally {
      await file.close();
    }
  };
}

function isQualifiedLocalAdmin(user: PhotoprismRow | undefined) {
  return (
    user?.id === 1n &&
    user.auth_provider === 'local' &&
    user.auth_method === '' &&
    user.super_admin === 1n &&
    user.can_login === 1n &&
    user.user_role === 'admin' &&
    user.user_scope === '*' &&
    user.user_attr === '' &&
    user.base_path === '' &&
    user.expires_at === null &&
    user.deleted_at === null
  );
}

type SingleOwnerReview = Pick<ManifestEvidence, 'source' | 'materializedAlbums'> & {
  singleOwner: { sourceId: string; confirmEntireLibrary: true };
};

export function photoprismSingleOwnerEvidence(
  records: PhotoprismInventoryRecord[],
  review: SingleOwnerReview,
): Omit<ManifestEvidence, 'files'> {
  const {
    source,
    materializedAlbums,
    singleOwner: { sourceId, confirmEntireLibrary },
  } = review;
  const accounts = records.flatMap((record) =>
    record.type === 'principal' && !record.value.system ? [record.value.id] : [],
  );
  const user = records.find(
    (record) => record.type === 'archive' && record.table === 'users' && record.value.user_uid === sourceId,
  );
  if (
    !confirmEntireLibrary ||
    accounts.length !== 1 ||
    accounts[0] !== sourceId ||
    user?.type !== 'archive' ||
    !isQualifiedLocalAdmin(user.value)
  )
    throw new LibraryImportRefused('PHOTOPRISM_SINGLE_OWNER_UNQUALIFIED');

  const photos = records.filter((record) => record.type === 'photo');
  const albums = records.filter((record) => record.type === 'album');
  if ([...photos, ...albums].some(({ value }) => value.createdBy && value.createdBy !== sourceId))
    throw new LibraryImportRefused('PHOTOPRISM_SINGLE_OWNER_UNQUALIFIED');
  return {
    source,
    materializedAlbums,
    photoOwners: Object.fromEntries(photos.map(({ value }) => [value.id, sourceId])),
    albumOwners: Object.fromEntries(albums.map(({ value }) => [value.id, sourceId])),
    // This entry point holds the source fence and verifies the frozen SQLite inventory.
    // The manifest retains private media and gives destination albums only owner access.
    inventory: {
      complete: true,
      ownershipComplete: true,
      privacyComplete: true,
      writersStopped: true,
      revisionBefore: source.revision,
      revisionAfter: source.revision,
    },
  };
}

/** Read compatible verifiers from the same sealed SQLite snapshot as the asset inventory. */
export async function publishPhotoprismSqliteBundle(
  input: Omit<
    Parameters<typeof publishPhotoprismImportBundle>[0],
    'records' | 'owners' | 'ownerMappings' | 'observed'
  > & {
    snapshotPath: string;
    observed:
      Parameters<typeof publishPhotoprismImportBundle>[0]['observed'] | (SingleOwnerReview & { ownerEmail: string });
    ownerMappings: { sourceId: string; destinationId: string }[];
    ownerIntents?: unknown[];
  },
) {
  const { source } = input.observed;
  const verifySource = photoprismSnapshotVerifier(input.snapshotPath, source.revision, input.verifySource);
  await verifySource();
  const snapshot = openPhotoprismSnapshot(input.snapshotPath, source.version);
  try {
    const records = [...readPhotoprismInventory(input.snapshotPath, source.version, source.schemaSha256)];
    const observed =
      'singleOwner' in input.observed ? photoprismSingleOwnerEvidence(records, input.observed) : input.observed;
    const mapped = new Map(input.ownerMappings.map(({ sourceId, destinationId }) => [sourceId, destinationId]));
    const users = new Map([...snapshot.rows('users')].flat().map((row) => [row.user_uid, row]));
    const owners = [];
    if ('singleOwner' in input.observed) {
      const sourceUserId = input.observed.singleOwner.sourceId;
      const destinationUserId = mapped.get(sourceUserId);
      if (input.ownerIntents !== undefined || input.ownerMappings.length !== 1 || !destinationUserId)
        throw new LibraryImportRefused('OWNER_QUALIFICATION_CHANGED');
      const credential = await snapshot.password({ operationId: input.operationId, sourceUserId, destinationUserId });
      owners.push({
        intent: parseImportedOwnerIntent({
          sourceUserId,
          email: input.observed.ownerEmail,
          login: {
            revision: source.revision,
            snapshotSha256: source.revision,
            accountEnabled: true,
            passwordLoginEnabled: true,
            secondFactorRequired: false,
            externalIdentityRequired: false,
            ownedLibraryAccess: 'full',
            otherRestrictions: 'none',
          },
          disposition: credential
            ? { kind: 'preserve' }
            : { kind: 'claim', reason: 'no-local-verifier', claimPermitted: true },
        }),
        credential,
      });
    }
    for (const raw of input.ownerIntents ?? []) {
      const intent = parseImportedOwnerIntent(raw);
      const destinationUserId = mapped.get(intent.sourceUserId);
      if (!destinationUserId || intent.login.snapshotSha256 !== source.revision)
        throw new LibraryImportRefused('OWNER_QUALIFICATION_CHANGED');
      const preserve =
        intent.disposition.kind === 'preserve' ||
        (intent.disposition.kind === 'restricted' && intent.disposition.credential === 'preserve');
      const user = users.get(intent.sourceUserId);
      if (preserve && !isQualifiedLocalAdmin(user))
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
      records,
      observed,
      owners,
      verifySource,
    });
  } finally {
    snapshot.close();
  }
}
