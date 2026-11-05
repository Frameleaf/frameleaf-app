// Native Nextcloud Photos / Memories single-account qualification; the parent owns the disposable application.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  copyPlacements,
  nativeContext,
  ownerIntent,
  runNativeCommonImport,
  sha256,
  stoppedContainerAuthority,
  // eslint-disable-next-line import-x/no-unresolved -- the lifecycle spec copies the helper beside this runner
} from './native-common.mjs';

const family = 'nextcloud';
const { directory, stateDirectory, sourceDirectory, runId, input } = await nativeContext(family);
const { default: fixture } = await import('src/library-import/fixtures/nextcloud/35-8-10.2-sqlite.json', {
  with: { type: 'json' },
});
const { openNextcloudSnapshot, readNextcloudManifest } = await import('src/library-import/nextcloud.js');
const { parseImportedOwnerIntent } = await import('src/library-import/owner-reconciliation.js');
const { verifyImportedPassword } = await import('src/library-import/passwords.js');
const { publishAdapterImportBundle } = await import('src/library-import/photoprism-bundle.js');
const { captureSqliteSnapshot } = await import('src/library-import/sqlite.js');

const sourceRoot = path.join(sourceDirectory, 'data');
assert.equal(input.databasePath, path.join(sourceRoot, 'nextcloud.db'));
assert.equal(input.sourceRoot, sourceRoot);
assert.equal(input.container.name, `frameleaf-nextcloud-app-${runId}`);
assert.match(input.container.id, /^[a-f0-9]{64}$/u);
assert.equal(input.seeds.length, 2);
const byId = (left, right) => left.localeCompare(right);
// A read-only SQLite open of the WAL-mode capture creates an empty WAL; no WAL and an empty WAL hold the same state.
const walSha256 = async (target) => {
  try {
    const info = await stat(target);
    return info.size > 0 ? await sha256(target) : 'no-committed-pages';
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return 'no-committed-pages';
  }
};
const authority = stoppedContainerAuthority({
  family,
  runId,
  containers: [input.container],
  fingerprint: async () => ({
    database: await sha256(input.databasePath),
    wal: await walSha256(input.databasePath + '-wal'),
  }),
});
await authority();
const captured = await captureSqliteSnapshot(input.databasePath, directory);
assert.equal(captured.schemaSha256, fixture.schemaSha256);
const revision = await sha256(captured.path);
const verifySource = async () => {
  await authority();
  assert.equal(await sha256(captured.path), revision, 'Captured Nextcloud snapshot changed');
};

const operationId = randomUUID(),
  destinationId = randomUUID(),
  ownerId = randomUUID();
const destinationRoot = path.join(directory, 'destination');
const snapshot = openNextcloudSnapshot(captured.path, fixture.source.version);
let published;
try {
  const storages = [...snapshot.rows('oc_storages')].flat();
  const home = storages.find((row) => row.id === `home::${input.sourceUserId}`);
  assert.ok(home, 'Native admin home storage missing');
  const storageKey = String(home.numeric_id);
  const storageRoots = { [storageKey]: input.sourceUserId };
  const users = [...snapshot.rows('oc_users')].flat();
  assert.deepEqual(
    users.map((row) => row.uid),
    [input.sourceUserId],
  );
  const mimetypes = new Map([...snapshot.rows('oc_mimetypes')].flat().map((row) => [row.id, row.mimetype]));
  const media = [...snapshot.rows('oc_filecache')]
    .flat()
    .filter((row) => /^(image|video)\//u.test(mimetypes.get(row.mimetype)) && row.storage === home.numeric_id);
  assert.equal(media.length, input.seeds.length, 'Native home media must be exactly the seeded originals');
  const files = media.map((row) => {
    const seed = input.seeds.find((item) => item.fileId === String(row.fileid));
    assert.ok(seed, 'Native file must have independent API byte evidence');
    assert.equal(row.path, `files/${seed.path}`);
    assert.equal(String(row.size), seed.size);
    return {
      id: `file:${row.fileid}`,
      assetId: String(row.fileid),
      path: `${input.sourceUserId}/${row.path}`,
      sha256: seed.sha256,
    };
  });
  for (const file of files)
    await mkdir(path.dirname(path.join(destinationRoot, 'owner', file.path)), { recursive: true, mode: 0o700 });
  const { roots, observed, placements } = await copyPlacements({ sourceRoot, destinationRoot, files });
  const { manifest, archive } = readNextcloudManifest(snapshot, {
    source: {
      kind: 'nextcloud',
      version: fixture.source.version,
      identity: input.container.id,
      revision,
      schemaSha256: captured.schemaSha256,
    },
    inventory: {
      complete: true,
      ownershipComplete: true,
      privacyComplete: true,
      writersStopped: true,
      revisionBefore: revision,
      revisionAfter: revision,
    },
    metadataView: 'memories',
    storageRoots,
    files: observed,
  });
  // Exactly the disclosures this seeded installation reports; anything else must be reviewed before approval.
  const approvedLossCodes = new Set([
    'NEXTCLOUD_SOURCE_METADATA_ARCHIVED',
    'NEXTCLOUD_SHARING_RESTRICTED',
    'NEXTCLOUD_GLOBAL_PRIVACY_REQUIRES_QUALIFICATION',
  ]);
  assert.deepEqual(new Set(manifest.losses.map((loss) => loss.code)), approvedLossCodes);
  const intent = parseImportedOwnerIntent(ownerIntent(input.sourceUserId, revision));
  const credential = await snapshot.password({
    operationId,
    sourceUserId: input.sourceUserId,
    destinationUserId: ownerId,
  });
  assert.ok(credential, 'Native admin password verifier must be portable');
  await verifySource();
  published = await publishAdapterImportBundle({
    manifest,
    archive,
    approvedLossCodes,
    roots,
    placements,
    ownerMappings: [{ sourceId: input.sourceUserId, destinationId: ownerId }],
    owners: [{ intent, credential }],
    stagingRoot: directory,
    operationId,
    destinationId,
    verifySource,
  });
  published.approvedLossCodes = [...approvedLossCodes];
} finally {
  snapshot.close();
}

// Keep a copy of the final result line for the parent script's report; stdout still carries it for the spec.
const print = console.log;
const finalLines = [];
console.log = (...values) => {
  print(...values);
  if (typeof values[0] === 'string' && values[0].startsWith('{')) finalLines.push(values[0]);
};
await runNativeCommonImport({
  source: family,
  directory,
  stateDirectory,
  bundleDirectory: published.bundleDirectory,
  receipt: published.receipt,
  operationId,
  destinationId,
  authorize: verifySource,
  expectedAssets: input.seeds.length,
  verify: async ({ query, assets, albums }) => {
    const [owner] = await query('SELECT password,"isAdmin","importClaimPending" FROM public."user" WHERE id=$1::uuid', [
      ownerId,
    ]);
    assert.equal(owner.isAdmin, false);
    assert.equal(owner.importClaimPending, false);
    assert.equal(await verifyImportedPassword(input.password, owner.password), true);
    assert.equal(await verifyImportedPassword('wrong-' + input.password, owner.password), false);
    for (const seed of input.seeds) {
      const asset = assets.find((row) => row.sourceId === seed.fileId);
      assert.ok(asset, 'Seeded Nextcloud original was not imported');
      assert.equal(asset.owner, ownerId);
      assert.equal(asset.originalFileName, `${seed.name}.jpg`);
      assert.equal(asset.visibility, 'timeline');
      assert.equal(asset.locked, false);
      assert.equal(asset.isFavorite, seed.favorite);
      assert.equal(asset.description, seed.caption);
      assert.equal(asset.rating ?? undefined, undefined, 'Memories exposes no rating editor; none was seeded');
      assert.equal(new Date(asset.fileCreatedAt).getTime(), seed.datetaken * 1000);
      assert.equal(await sha256(asset.originalPath), seed.sha256);
      assert.equal(await sha256(path.join(sourceRoot, input.sourceUserId, 'files', seed.path)), seed.sha256);
    }
    assert.equal(albums.length, 1);
    assert.equal(albums[0].name, input.album.name);
    assert.equal(albums[0].owner, ownerId);
    assert.deepEqual([...albums[0].members].toSorted(byId), input.seeds.map((seed) => seed.fileId).toSorted(byId));
  },
  result: {
    nativeScope: 'single-local-admin-copy',
    originalFiles: input.seeds.length,
    metadataView: 'memories',
    passwordPreserved: true,
    approvedLossCodes: published.approvedLossCodes,
  },
});
console.log = print;
assert.equal(finalLines.length, 1);
await writeFile(path.join(sourceDirectory, 'result.json'), finalLines[0] + '\n', { mode: 0o600 });
