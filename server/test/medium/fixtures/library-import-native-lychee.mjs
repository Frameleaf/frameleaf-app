// Native Lychee qualification: the parent owns the stopped disposable application; this imports its capture.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  copyPlacements,
  nativeContext,
  ownerIntent,
  runNativeCommonImport,
  sha256,
  stoppedContainerAuthority,
  // The lifecycle spec copies the shared helper beside this runner in its isolated build.
  // eslint-disable-next-line import-x/no-unresolved
} from './native-common.mjs';

const { directory, stateDirectory, sourceDirectory, runId, input } = await nativeContext('lychee');
const { default: fixture } = await import('src/library-import/fixtures/lychee/7.12.0-sqlite.json', {
  with: { type: 'json' },
});
const { openLycheeSnapshot, readLycheeManifest } = await import('src/library-import/lychee.js');
const { publishAdapterImportBundle } = await import('src/library-import/photoprism-bundle.js');
const { verifyImportedPassword } = await import('src/library-import/passwords.js');
const { captureSqliteSnapshot } = await import('src/library-import/sqlite.js');

assert.equal(input.databasePath, path.join(sourceDirectory, 'database/database.sqlite'));
assert.equal(input.uploadsRoot, path.join(sourceDirectory, 'uploads'));
assert.equal(input.sourceUserId, '1');
assert.equal(input.containers.length, 1);
assert.match(input.containers[0].id, /^[a-f0-9]{64}$/u);
assert.equal(input.photos.length, 2);
const ordered = (left, right) => left.localeCompare(right);
const absent = async (path) => {
  try {
    await access(path);
    return false;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return true;
  }
};
const authorize = stoppedContainerAuthority({
  family: 'lychee',
  runId,
  containers: input.containers,
  // Lychee's SQLite connection uses a rollback journal; a hot journal or WAL would mean an unfinished writer.
  fingerprint: async () => ({
    database: await sha256(input.databasePath),
    journal: !(await absent(input.databasePath + '-journal')),
    wal: !(await absent(input.databasePath + '-wal')),
  }),
});
await authorize();
const captured = await captureSqliteSnapshot(input.databasePath, directory);
assert.equal(captured.schemaSha256, fixture.schemaSha256);
const revision = await sha256(captured.path);
const verifySource = async () => {
  await authorize();
  assert.equal(await sha256(captured.path), revision, 'Captured Lychee snapshot changed');
};
await verifySource();
const operationId = randomUUID(),
  destinationId = randomUUID(),
  ownerId = randomUUID();
const destinationRoot = path.join(directory, 'destination');
await mkdir(destinationRoot, { mode: 0o700 });
const snapshot = openLycheeSnapshot(captured.path, fixture.source.version);
let bundle, approvedLossCodes, credential;
try {
  const users = [...snapshot.rows('users')].flat();
  assert.equal(users.length, 1);
  assert.equal(users[0].id, 1n);
  assert.equal(users[0].username, input.username);
  assert.equal(users[0].may_administrate, 1n);
  assert.equal(users[0].is_ldap, 0n);
  assert.ok(!Object.hasOwn(users[0], 'password'));
  const photos = [...snapshot.rows('photos')].flat();
  assert.deepEqual(new Set(photos.map((photo) => photo.id)), new Set(input.photos.map((photo) => photo.id)));
  const variants = [...snapshot.rows('size_variants')].flat().filter((variant) => variant.type <= 1n);
  assert.equal(variants.length, input.photos.length);
  const files = variants.map((variant) => {
    const expected = input.photos.find((photo) => photo.id === variant.photo_id);
    assert.ok(expected && expected.path === variant.short_path, 'Source original must have independent API evidence');
    assert.equal(variant.type, 1n);
    assert.equal(String(variant.filesize), expected.bytes);
    return {
      id: `variant:${variant.id}`,
      assetId: variant.photo_id,
      path: variant.short_path,
      sha256: expected.sha256,
    };
  });
  const { roots, observed, placements } = await copyPlacements({
    sourceRoot: input.uploadsRoot,
    destinationRoot,
    files,
  });
  for (const placement of placements)
    await mkdir(path.dirname(path.join(destinationRoot, placement.destinationPath)), { recursive: true, mode: 0o700 });
  const source = {
    kind: 'lychee',
    version: fixture.source.version,
    identity: input.containers[0].id,
    revision,
    schemaSha256: captured.schemaSha256,
  };
  const { manifest, archive } = readLycheeManifest(snapshot, {
    source,
    inventory: {
      complete: true,
      ownershipComplete: true,
      privacyComplete: true,
      writersStopped: true,
      revisionBefore: revision,
      revisionAfter: revision,
    },
    files: observed,
    materializedAlbums: {},
  });
  // Reviewed differences: source-only columns stay in the protected archive and Lychee titles have no destination field.
  approvedLossCodes = ['LYCHEE_SOURCE_METADATA_ARCHIVED', 'LYCHEE_TITLE_ARCHIVED'];
  assert.deepEqual([...new Set(manifest.losses.map((loss) => loss.code))].toSorted(ordered), approvedLossCodes);
  assert.equal(manifest.losses.filter((loss) => loss.code === 'LYCHEE_TITLE_ARCHIVED').length, input.photos.length);
  credential = await snapshot.password({ operationId, sourceUserId: input.sourceUserId, destinationUserId: ownerId });
  assert.ok(credential, 'Lychee local administrator password must be portable');
  bundle = await publishAdapterImportBundle({
    manifest,
    archive,
    approvedLossCodes: new Set(approvedLossCodes),
    roots,
    placements,
    ownerMappings: [{ sourceId: input.sourceUserId, destinationId: ownerId }],
    owners: [{ intent: ownerIntent(input.sourceUserId, revision), credential }],
    stagingRoot: directory,
    operationId,
    destinationId,
    verifySource,
  });
} finally {
  snapshot.close();
}
await runNativeCommonImport({
  source: 'lychee',
  directory,
  stateDirectory,
  bundleDirectory: bundle.bundleDirectory,
  receipt: bundle.receipt,
  operationId,
  destinationId,
  authorize: verifySource,
  expectedAssets: input.photos.length,
  async verify({ query, assets, albums }) {
    const [owner] = await query('SELECT password,"isAdmin","importClaimPending" FROM public."user" WHERE id=$1::uuid', [
      ownerId,
    ]);
    assert.equal(owner.isAdmin, false);
    assert.equal(owner.importClaimPending, false);
    assert.equal(await verifyImportedPassword(input.password, owner.password), true);
    assert.equal(await verifyImportedPassword('wrong-' + input.password, owner.password), false);
    for (const expected of input.photos) {
      const asset = assets.find((row) => row.sourceId === expected.id);
      assert.ok(asset, 'Seeded Lychee photo missing from destination');
      assert.equal(asset.owner, ownerId);
      assert.equal(await sha256(asset.originalPath), expected.sha256);
      assert.equal(await sha256(path.join(input.uploadsRoot, expected.path)), expected.sha256);
      assert.equal(asset.originalFileName, expected.path.split('/').at(-1));
      assert.equal(asset.description, expected.caption);
      assert.ok(asset.lockedProperties.includes('description'));
      assert.equal(asset.isFavorite, expected.favorite);
      assert.equal(asset.rating, expected.rating);
      assert.equal(asset.visibility, 'timeline');
      assert.equal(asset.locked, false);
      assert.equal(new Date(asset.fileCreatedAt).toISOString(), expected.takenAt);
      assert.equal(new Date(asset.localDateTime).toISOString(), expected.localDateTime);
    }
    assert.equal(albums.length, 1);
    assert.deepEqual(
      { ...albums[0], members: albums[0].members.toSorted(ordered) },
      {
        name: input.album.name,
        description: input.album.description,
        owner: ownerId,
        members: input.photos.map((photo) => photo.id).toSorted(ordered),
      },
    );
  },
  result: {
    nativeScope: 'single-local-admin-copy',
    originalFiles: input.photos.length,
    passwordPreserved: true,
    approvedLossCodes,
  },
});
