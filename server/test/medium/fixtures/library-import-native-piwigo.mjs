// Native Piwigo qualification: the parent installs and seeds a disposable Piwigo 16.4.0 (MariaDB) through its own
// installer and web API, stops it, captures a locked dump and restores it into an isolated read-only server.
// This runner reads that restore with the product reader and imports it through the common command.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { join, posix, relative } from 'node:path';
import { promisify } from 'node:util';
import {
  copyPlacements,
  nativeContext,
  ownerIntent,
  runNativeCommonImport,
  sha256,
  stoppedContainerAuthority,
} from './native-common.mjs';

const execute = promisify(execFile);
const family = 'piwigo';
const { directory, stateDirectory, sourceDirectory, runId, input } = await nativeContext(family);
assert.equal(input.dumpPath, join(sourceDirectory, 'piwigo.sql'));
assert.equal(input.databaseDirectory, join(sourceDirectory, 'mariadb'));
assert.equal(input.sourceRoot, join(sourceDirectory, 'www'));
assert.equal(input.sourceUserId, '1');
for (const [role, container] of Object.entries(input.containers)) {
  assert.match(container.id, /^[a-f0-9]{64}$/u);
  assert.equal(container.name, `frameleaf-piwigo-${role === 'app' ? 'app' : 'db'}-${runId}`);
}
const { default: fixture } = await import('src/library-import/fixtures/piwigo/16.4.0-mariadb.json', {
  with: { type: 'json' },
});
const { readPiwigoRestore, readPiwigoManifest } = await import('src/library-import/piwigo-source.js');
const { publishAdapterImportBundle } = await import('src/library-import/photoprism-bundle.js');
const { verifyImportedPassword } = await import('src/library-import/passwords.js');

const byText = (a, b) => a.localeCompare(b);
const tree = async (root, describe) => {
  const entries = [];
  const walk = async (path) => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) entries.push([relative(root, child), await describe(child)]);
    }
  };
  await walk(root);
  return createHash('sha256')
    .update(JSON.stringify(entries.toSorted(([a], [b]) => a.localeCompare(b))))
    .digest('hex');
};
// Stopped-writer fingerprint: the locked dump bytes, the stored originals' bytes and the stopped server's files.
const fingerprint = async () => ({
  dump: await sha256(input.dumpPath),
  originals: await tree(join(input.sourceRoot, 'upload'), sha256),
  database: await tree(input.databaseDirectory, async (path) => {
    const info = await stat(path, { bigint: true });
    return [info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
  }),
});
const authorize = stoppedContainerAuthority({
  family,
  runId,
  containers: [input.containers.app, input.containers.database],
  fingerprint,
});
await authorize();
const revision = await sha256(input.dumpPath);
assert.equal(revision, input.dumpSha256, 'Locked Piwigo capture changed');
// The isolated restore is the only live reader target: labelled for this run, pinned engine, running.
const restoreIdentity = async () => {
  const { stdout } = await execute('docker', ['inspect', input.restore.container.id], { timeout: 10_000 });
  const [actor] = JSON.parse(stdout);
  assert.equal(actor.Name, `/frameleaf-piwigo-restore-${runId}`);
  assert.equal(actor.Image, input.restore.container.image);
  assert.equal(actor.Config.Image, fixture.runtime.databaseImage);
  assert.equal(actor.Config.Labels['app.frameleaf.qualification-family'], family);
  assert.equal(actor.Config.Labels['app.frameleaf.qualification-run'], runId);
  assert.equal(actor.State.Running, true);
};
const verifySource = async () => {
  await authorize();
  await restoreIdentity();
};
await verifySource();

const operationId = randomUUID(),
  destinationId = randomUUID(),
  ownerId = randomUUID();
const destinationRoot = join(directory, 'destination');
const files = input.seeds.map((seed) => ({
  id: `image:${seed.imageId}:original`,
  path: seed.path,
  sha256: seed.sha256,
  assetId: seed.imageId,
}));
for (const file of files)
  await mkdir(join(destinationRoot, 'owner', posix.dirname(file.path)), { recursive: true, mode: 0o700 });
const { roots, observed, placements } = await copyPlacements({ sourceRoot: input.sourceRoot, destinationRoot, files });
for (const file of observed)
  assert.equal(file.bytes, input.seeds.find((seed) => seed.path === file.path).bytes, 'Seed byte count changed');
const source = {
  kind: family,
  version: fixture.source.version,
  identity: input.containers.app.id,
  revision,
  schemaSha256: fixture.schemaSha256,
};
const imageIds = input.seeds.map((seed) => seed.imageId);
let credential;
const { manifest, archive } = await readPiwigoManifest(
  readPiwigoRestore(
    {
      host: input.restore.host,
      port: input.restore.port,
      user: input.restore.user,
      password: input.restore.password,
      database: input.restore.database,
      prefix: fixture.tablePrefix,
      version: fixture.source.version,
    },
    async (read) => {
      credential = await read({ operationId, sourceUserId: input.sourceUserId, destinationUserId: ownerId });
    },
  ),
  {
    source,
    inventory: {
      complete: true,
      ownershipComplete: true,
      privacyComplete: true,
      writersStopped: true,
      revisionBefore: revision,
      revisionAfter: revision,
    },
    // The installer's webmaster uploaded and organized every photo; guest (2) owns nothing.
    photoOwners: Object.fromEntries(imageIds.map((id) => [id, input.sourceUserId])),
    albumOwners: { [input.album.id]: input.sourceUserId },
    reviewedCaptureOffsets: Object.fromEntries(imageIds.map((id) => [id, 0])),
    reviewedMissingImageIds: [],
    files: observed,
  },
);
assert.ok(credential, 'Piwigo webmaster must carry a portable PHPass verifier');
assert.deepEqual(manifest.users, [{ id: input.sourceUserId, name: input.username }]);
assert.deepEqual(manifest.assets.map((asset) => asset.id).toSorted(byText), [...imageIds].toSorted(byText));
// Reviewed Piwigo differences for this library: raw rows archived, source access rules not recreated, titles
// kept only in the archive, and the public aggregate score archived separately from the owner's vote.
const reviewedLosses = new Set([
  'PIWIGO_SOURCE_METADATA_ARCHIVED',
  'PIWIGO_SHARING_RESTRICTED',
  'PIWIGO_TITLE_ARCHIVED',
  'PIWIGO_AGGREGATE_RATING_ARCHIVED',
]);
const reported = new Set(manifest.losses.map((loss) => loss.code));
assert.deepEqual([...reported].toSorted(byText), [...reviewedLosses].toSorted(byText), 'Unexpected Piwigo loss set');
const ownerMappings = [{ sourceId: input.sourceUserId, destinationId: ownerId }];
const published = await publishAdapterImportBundle({
  manifest,
  archive,
  approvedLossCodes: reported,
  roots,
  placements,
  ownerMappings,
  owners: [{ intent: ownerIntent(input.sourceUserId, revision), credential }],
  stagingRoot: directory,
  operationId,
  destinationId,
  verifySource,
});

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
    for (const seed of input.seeds) {
      const asset = assets.find((row) => row.sourceId === seed.imageId);
      assert.ok(asset, 'Imported Piwigo photo missing');
      assert.equal(asset.owner, ownerId);
      assert.equal(await sha256(asset.originalPath), seed.sha256);
      assert.equal(asset.originalFileName, seed.fileName);
      assert.equal(asset.description, seed.caption);
      assert.equal(asset.isFavorite, seed.favorite);
      assert.equal(asset.rating, seed.rating);
      assert.equal(new Date(asset.localDateTime).toISOString(), seed.dateCreation.replace(' ', 'T') + '.000Z');
      assert.equal(asset.visibility, 'timeline');
      assert.equal(asset.locked, false);
    }
    assert.equal(input.seeds.filter((seed) => seed.favorite).length, 1);
    assert.equal(input.seeds.filter((seed) => seed.rating !== null).length, 1);
    assert.deepEqual(
      albums.map((row) => ({ ...row, members: [...row.members].toSorted(byText) })),
      [
        {
          name: input.album.name,
          description: input.album.description,
          owner: ownerId,
          members: [...input.album.imageIds].toSorted(byText),
        },
      ],
    );
    const rows = await query('SELECT password,"isAdmin","importClaimPending" FROM public."user" WHERE id=$1::uuid', [
      ownerId,
    ]);
    assert.equal(rows.length, 1, 'Imported Piwigo owner missing');
    assert.equal(rows[0].isAdmin, false);
    assert.equal(rows[0].importClaimPending, false);
    assert.equal(await verifyImportedPassword(input.password, rows[0].password), true, 'PHPass password not preserved');
    assert.equal(await verifyImportedPassword('wrong-' + input.password, rows[0].password), false);
  },
  result: {
    nativeScope: 'piwigo-webmaster-mariadb-restore-copy',
    originalFiles: input.seeds.length,
    owners: 1,
    album: true,
    captionsVerified: input.seeds.length,
    favouriteVerified: true,
    ownerRatingVerified: true,
    passwordsPreserved: 1,
    approvedLosses: [...reported].toSorted(byText),
  },
});
