// Native PiGallery2 qualification: the parent seeds a disposable PiGallery2 3.5.2 (SQLite) with one generated
// administrator and a folder album whose captions and ratings come from embedded EXIF/XMP and an XMP sidecar,
// stops it, and hands its database directory and originals to this runner.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  copyPlacements,
  nativeContext,
  ownerIntent,
  runNativeCommonImport,
  sha256,
  stoppedContainerAuthority,
  // eslint-disable-next-line import-x/no-unresolved -- resolved beside this runner in the isolated build
} from './native-common.mjs';

const family = 'pigallery2';
const byText = (left, right) => left.localeCompare(right);
const { directory, stateDirectory, sourceDirectory, runId, input } = await nativeContext(family);
const databaseDirectory = path.join(sourceDirectory, 'db');
assert.equal(input.databasePath, path.join(databaseDirectory, 'sqlite.db'));
assert.equal(input.originals, path.join(sourceDirectory, 'originals'));
assert.match(input.container.id, /^[a-f0-9]{64}$/u);
assert.equal(input.container.name, `frameleaf-pigallery2-${runId}`);
const { default: fixture } = await import('src/library-import/fixtures/pigallery2/3.5.2-sqlite.json', {
  with: { type: 'json' },
});
const { captureSqliteSnapshot } = await import('src/library-import/sqlite.js');
const { openPigallery2Snapshot, readPigallery2Manifest } = await import('src/library-import/pigallery2.js');
const { resolvePigallery2File } = await import('src/library-import/pigallery2-files.js');
const { pigallery2SidecarCandidates } = await import('src/library-import/pigallery2-sidecars.js');
const { publishAdapterImportBundle } = await import('src/library-import/photoprism-bundle.js');
const { verifyImportedPassword } = await import('src/library-import/passwords.js');

// Stopped-writer fingerprint: every file in the database directory (the database plus any WAL/SHM left behind).
const fingerprint = async () => {
  const state = {};
  const names = await readdir(databaseDirectory);
  for (const name of names.toSorted(byText)) state[name] = await sha256(path.join(databaseDirectory, name));
  assert.ok(state['sqlite.db'], 'PiGallery2 database missing');
  return state;
};
const authorize = stoppedContainerAuthority({ family, runId, containers: [input.container], fingerprint });
await authorize();
const captured = await captureSqliteSnapshot(input.databasePath, directory);
assert.equal(captured.schemaSha256, fixture.schemaSha256, 'Pinned PiGallery2 wrote an unqualified schema');
const revision = await sha256(captured.path);
const verifySource = async () => {
  await authorize();
  assert.equal(await sha256(captured.path), revision, 'Captured PiGallery2 snapshot changed');
};
await verifySource();

const operationId = randomUUID(),
  destinationId = randomUUID(),
  ownerId = randomUUID();
const sourceRoot = input.originals;
const destinationRoot = path.join(directory, 'destination');
const snapshot = openPigallery2Snapshot(captured.path, fixture.source.version);
let published, expected;
try {
  const rows = (table) => [...snapshot.rows(table)].flat();
  const users = rows('user_entity');
  const media = rows('media_entity');
  const directories = new Map(rows('directory_entity').map((row) => [row.id, row]));
  // The generated administrator replaced the dummy admin; no other account, saved search, share or metadata file.
  assert.deepEqual(
    users.map((row) => [String(row.id), row.name, row.role]),
    [[input.sourceUserId, input.username, 4n]],
  );
  assert.equal(rows('album_base_entity').length, 0);
  assert.equal(rows('sharing_entity').length, 0);
  assert.equal(rows('file_entity').length, 0);
  assert.equal(media.length, input.seeds.length);
  const files = media.map((row) => {
    const resolved = resolvePigallery2File('media_entity', row, directories.get(row.directoryId));
    const seed = input.seeds.find((entry) => entry.path === resolved.path);
    assert.ok(seed, 'Source original must have independent seed evidence');
    assert.equal(resolved.bytes, seed.bytes);
    return { id: resolved.id, path: resolved.path, sha256: seed.sha256, assetId: String(row.id) };
  });
  // The owner's native download inventory is the access evidence for the explicit single-account assignment.
  assert.deepEqual(
    input.inventory.map((entry) => `${entry.path}:${entry.sha256}`).toSorted(byText),
    files.map((file) => `${file.path}:${file.sha256}`).toSorted(byText),
  );
  for (const file of files)
    await mkdir(path.join(destinationRoot, 'owner', path.posix.dirname(file.path)), { recursive: true, mode: 0o700 });
  const { roots, observed, placements } = await copyPlacements({ sourceRoot, destinationRoot, files });
  // Every existing native sidecar candidate (exact, case-sensitive names) is byte-verified into the archive.
  const archivedFiles = [];
  for (const file of files) {
    const folder = path.posix.dirname(file.path);
    const present = new Set(await readdir(path.join(sourceRoot, folder)));
    for (const candidate of pigallery2SidecarCandidates(file.path)) {
      if (!present.has(path.posix.basename(candidate))) continue;
      const content = new Uint8Array(await readFile(path.join(sourceRoot, candidate)));
      archivedFiles.push({
        path: candidate,
        bytes: String(content.byteLength),
        sha256: await sha256(path.join(sourceRoot, candidate)),
        content,
      });
    }
  }
  assert.deepEqual(
    archivedFiles.map(({ path: file, bytes, sha256: digest }) => ({ path: file, bytes, sha256: digest })),
    input.sidecars,
  );
  const source = {
    kind: family,
    version: fixture.source.version,
    identity: input.container.id,
    revision,
    schemaSha256: snapshot.schemaSha256,
  };
  const { manifest, archive } = readPigallery2Manifest(snapshot, {
    source,
    inventory: {
      complete: true,
      ownershipComplete: true,
      privacyComplete: true,
      writersStopped: true,
      revisionBefore: revision,
      revisionAfter: revision,
    },
    owners: Object.fromEntries(media.map((row) => [String(row.id), input.sourceUserId])),
    grants: { [input.sourceUserId]: media.map((row) => String(row.id)) },
    materializedAlbums: {},
    files: observed,
    archivedFiles,
  });
  // Reviewed PiGallery2 differences for this library: raw rows and the sidecar are kept in the protected archive,
  // and global guest/allow-block configuration is outside the snapshot, so sharing stays restricted.
  const reviewedLosses = ['PIGALLERY2_SHARING_RESTRICTED', 'PIGALLERY2_SOURCE_METADATA_ARCHIVED'];
  const reported = [...new Set(manifest.losses.map((loss) => loss.code))].toSorted(byText);
  assert.deepEqual(reported, reviewedLosses, 'Unreviewed PiGallery2 loss reported');
  const ownerMappings = [{ sourceId: input.sourceUserId, destinationId: ownerId }];
  const credential = await snapshot.password({
    operationId,
    sourceUserId: input.sourceUserId,
    destinationUserId: ownerId,
  });
  assert.ok(credential, 'PiGallery2 account must carry a compatible bcrypt password');
  published = await publishAdapterImportBundle({
    manifest,
    archive,
    approvedLossCodes: new Set(reported),
    roots,
    placements,
    ownerMappings,
    owners: [{ intent: ownerIntent(input.sourceUserId, revision), credential }],
    stagingRoot: directory,
    operationId,
    destinationId,
    verifySource,
  });
  expected = {
    losses: reported,
    assets: media.map((row) => {
      const file = files.find((entry) => entry.assetId === String(row.id));
      return { sourceId: String(row.id), ...input.seeds.find((seed) => seed.path === file.path) };
    }),
    album: {
      name: input.album,
      owner: ownerId,
      members: media.map((row) => String(row.id)).toSorted(byText),
    },
  };
} finally {
  snapshot.close();
}

await runNativeCommonImport({
  source: family,
  directory,
  stateDirectory,
  bundleDirectory: published.bundleDirectory,
  receipt: published.receipt,
  operationId,
  destinationId,
  authorize,
  expectedAssets: expected.assets.length,
  verify: async ({ query, assets, albums }) => {
    for (const want of expected.assets) {
      const asset = assets.find((row) => row.sourceId === want.sourceId);
      assert.ok(asset, 'Imported PiGallery2 asset missing');
      assert.equal(asset.owner, ownerId);
      assert.equal(await sha256(asset.originalPath), want.sha256);
      assert.equal(asset.originalFileName, path.posix.basename(want.path));
      assert.equal(asset.description, want.caption);
      assert.equal(asset.rating, want.rating);
      assert.equal(asset.isFavorite, false);
      assert.equal(asset.visibility, 'timeline');
      assert.equal(asset.locked, false);
      assert.equal(new Date(asset.fileCreatedAt).toISOString(), want.takenAt);
      assert.equal(new Date(asset.localDateTime).toISOString(), want.localDateTime);
      assert.ok(asset.lockedProperties.includes('description'));
    }
    assert.deepEqual(
      albums.map((row) => ({ name: row.name, owner: row.owner, members: [...row.members].toSorted(byText) })),
      [expected.album],
    );
    const rows = await query('SELECT password,"importClaimPending","isAdmin" FROM public."user" WHERE id=$1::uuid', [
      ownerId,
    ]);
    assert.equal(rows.length, 1, 'Imported PiGallery2 owner missing');
    assert.equal(rows[0].importClaimPending, false);
    assert.equal(await verifyImportedPassword(input.password, rows[0].password), true, 'Password not preserved');
    assert.equal(await verifyImportedPassword('wrong-' + input.password, rows[0].password), false);
  },
  result: {
    nativeScope: 'pigallery2-single-account-folder-album-copy',
    originalFiles: expected.assets.length,
    archivedSidecars: input.sidecars.length,
    owners: 1,
    folderAlbum: expected.album.name,
    captionsVerified: expected.assets.length,
    ratingsVerified: expected.assets.map((asset) => asset.rating),
    passwordsPreserved: 1,
    approvedLosses: expected.losses,
  },
});
