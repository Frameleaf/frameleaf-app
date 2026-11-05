// Native LibrePhotos 1.5.1 (PostgreSQL) qualification: the parent seeds the official unified application and its
// pinned PostgreSQL, stops the application and keeps the database running for this read-only snapshot runner.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  copyPlacements,
  nativeContext,
  ownerIntent,
  runNativeCommonImport,
  sha256,
  stoppedContainerAuthority,
  // eslint-disable-next-line import-x/no-unresolved -- resolved beside this runner in the isolated build
} from './native-common.mjs';

const family = 'librephotos';
const execute = promisify(execFile);
const byText = (left, right) => left.localeCompare(right);
const { directory, stateDirectory, sourceDirectory, runId, input } = await nativeContext(family);
const { default: fixture } = await import('src/library-import/fixtures/librephotos/1.5.1-postgres18.json', {
  with: { type: 'json' },
});
const { openLibrephotosPostgresSnapshot } = await import('src/library-import/librephotos-postgres-source.js');
const { readLibrephotosManifest } = await import('src/library-import/librephotos-manifest.js');
const { publishAdapterImportBundle } = await import('src/library-import/photoprism-bundle.js');
const { verifyImportedPassword } = await import('src/library-import/passwords.js');

assert.equal(input.sourceRoot, path.join(sourceDirectory, 'originals'));
assert.equal(input.containerSourceRoot, '/data');
assert.equal(input.application.name, `frameleaf-${family}-app-${runId}`);
assert.equal(input.database.name, `frameleaf-${family}-db-${runId}`);
assert.match(input.application.id, /^[a-f0-9]{64}$/u);
assert.match(input.database.id, /^[a-f0-9]{64}$/u);
assert.equal(input.photos.length, 2);

// Writers are fenced by the stopped application; the database stays up (restart disabled) only for this read, and
// its logical content is fingerprinted with a deterministic plain-format dump.
const fingerprint = async () => {
  const { stdout } = await execute(
    'docker',
    // A fixed psql \restrict key: pg_dump 18 otherwise writes a random one into every dump.
    [
      'exec',
      input.database.id,
      'pg_dump',
      '-U',
      input.database.user,
      '-d',
      input.database.database,
      '--no-password',
      '--restrict-key=frameleafLibrephotosQualification',
    ],
    { encoding: 'buffer', timeout: 60_000, maxBuffer: 256 * 1024 * 1024 },
  );
  return createHash('sha256').update(stdout).digest('hex');
};
const appStopped = stoppedContainerAuthority({
  family,
  runId,
  containers: [input.application],
  fingerprint,
});
const authorize = async () => {
  const { stdout } = await execute('docker', ['inspect', input.database.id], { timeout: 10_000 });
  const [actor] = JSON.parse(stdout);
  assert.equal(actor.Id, input.database.id);
  assert.equal(actor.Image, input.database.image);
  assert.equal(actor.Name, '/' + input.database.name);
  assert.equal(actor.Config.Labels['app.frameleaf.qualification-family'], family);
  assert.equal(actor.Config.Labels['app.frameleaf.qualification-run'], runId);
  assert.equal(actor.State.Running, true, 'Native source database must stay available for the read');
  assert.equal(actor.HostConfig.RestartPolicy.Name, 'no', 'Native source restart must remain disabled');
  await appStopped();
};
await authorize();
const revision = await fingerprint();
assert.equal(revision, input.database.dumpSha256, 'Native source database changed after the application stopped');
const verifySource = async () => {
  await authorize();
  assert.equal(await fingerprint(), revision, 'Native source database changed');
};

const operationId = randomUUID(),
  destinationId = randomUUID(),
  ownerId = randomUUID();
const destinationRoot = path.join(directory, 'destination');
const snapshot = await openLibrephotosPostgresSnapshot(input.database.url, fixture.source.version, true);
let published, losses, credential;
try {
  assert.equal(snapshot.schemaSha256, fixture.schemaSha256);
  const rows = async (table) => {
    const all = [];
    for await (const batch of snapshot.rows(table)) all.push(...batch);
    return all;
  };
  const users = await rows('api_user');
  assert.deepEqual(
    users.map((user) => [String(user.id), user.username, user.is_active]),
    [[input.sourceUserId, 'fixture_admin', 1n]],
  );
  const sourcePhotos = await rows('api_photo');
  const sourceFiles = await rows('api_file');
  assert.deepEqual(
    sourcePhotos.map((photo) => photo.id).toSorted(byText),
    input.photos.map((photo) => photo.photoId.replaceAll('-', '')).toSorted(byText),
  );
  assert.equal(sourceFiles.length, input.photos.length);
  const files = sourceFiles.map((file) => {
    const relative = path.posix.relative(input.containerSourceRoot, String(file.path));
    const seed = input.photos.find((photo) => photo.path === relative);
    assert.ok(seed, 'Source original must have independent seed evidence');
    const photo = sourcePhotos.find((row) => row.main_file_id === file.hash);
    assert.equal(photo?.id, seed.photoId.replaceAll('-', ''));
    return { id: `file:${file.hash}`, path: relative, sha256: seed.sha256, assetId: photo.id };
  });
  await mkdir(path.join(destinationRoot, 'owner/camera'), { recursive: true, mode: 0o700 });
  const { roots, observed, placements } = await copyPlacements({
    sourceRoot: input.sourceRoot,
    destinationRoot,
    files,
  });
  for (const file of observed)
    assert.equal(file.bytes, input.photos.find((photo) => photo.path === file.path).bytes, 'Seed byte count changed');
  const source = {
    kind: family,
    version: fixture.source.version,
    identity: input.application.id,
    revision,
    schemaSha256: snapshot.schemaSha256,
  };
  const { manifest, archive } = await readLibrephotosManifest(snapshot, {
    source,
    inventory: {
      complete: true,
      ownershipComplete: true,
      privacyComplete: true,
      writersStopped: true,
      revisionBefore: revision,
      revisionAfter: revision,
    },
    sourceRoot: input.containerSourceRoot,
    files: observed,
    // Scanned EXIF offsets give exact capture instants; no manually entered dates need a reviewed offset.
    reviewedCaptureOffsets: {},
  });
  // Reviewed LibrePhotos differences for this library: the allowlisted source rows go to the protected archive.
  const reviewedLosses = new Set(['LIBREPHOTOS_SOURCE_METADATA_ARCHIVED']);
  losses = [...new Set(manifest.losses.map((loss) => loss.code))].toSorted(byText);
  assert.deepEqual(losses, [...reviewedLosses], 'Unreviewed LibrePhotos loss reported');
  credential = await snapshot.password({ operationId, sourceUserId: input.sourceUserId, destinationUserId: ownerId });
  assert.ok(credential, 'LibrePhotos account must carry its Django Argon2 password');
  await snapshot.close();
  await verifySource();
  published = await publishAdapterImportBundle({
    manifest,
    archive,
    approvedLossCodes: reviewedLosses,
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
  await snapshot.close();
}

const photoIds = input.photos.map((photo) => photo.photoId.replaceAll('-', '')).toSorted(byText);
await runNativeCommonImport({
  source: family,
  directory,
  stateDirectory,
  bundleDirectory: published.bundleDirectory,
  receipt: published.receipt,
  operationId,
  destinationId,
  authorize: verifySource,
  expectedAssets: input.photos.length,
  verify: async ({ query, assets, albums }) => {
    for (const photo of input.photos) {
      const asset = assets.find((row) => row.sourceId === photo.photoId.replaceAll('-', ''));
      assert.ok(asset, 'Imported LibrePhotos asset missing');
      assert.equal(asset.owner, ownerId);
      assert.equal(await sha256(asset.originalPath), photo.sha256);
      assert.equal(await sha256(path.join(input.sourceRoot, photo.path)), photo.sha256, 'Source original changed');
      assert.equal(asset.originalFileName, path.posix.basename(photo.path));
      assert.equal(asset.description, photo.caption);
      assert.ok(asset.lockedProperties?.includes('description'), 'Manual caption must be protected');
      assert.equal(asset.isFavorite, photo.favorite);
      assert.equal(asset.rating, photo.rating);
      assert.equal(asset.fileCreatedAt.toISOString(), input.capture.takenAt);
      assert.equal(asset.localDateTime.toISOString(), input.capture.localDateTime);
      assert.equal(asset.visibility, 'timeline');
      assert.equal(asset.locked, false);
    }
    assert.equal(input.photos.filter((photo) => photo.favorite).length, 1);
    assert.deepEqual(
      albums.map((album) => ({
        ...album,
        description: album.description ?? 'none',
        members: [...album.members].toSorted(byText),
      })),
      // LibrePhotos user albums have no description field, so none is imported.
      [{ name: input.album.name, description: 'none', owner: ownerId, members: photoIds }],
    );
    assert.deepEqual(input.album.photoIds.map((id) => id.replaceAll('-', '')).toSorted(byText), photoIds);
    const [owner] = await query('SELECT password,"isAdmin","importClaimPending" FROM public."user" WHERE id=$1::uuid', [
      ownerId,
    ]);
    assert.equal(owner.importClaimPending, false);
    assert.equal(await verifyImportedPassword(input.password, owner.password), true, 'Password not preserved');
    assert.equal(await verifyImportedPassword('wrong-' + input.password, owner.password), false);
  },
  result: {
    nativeScope: 'librephotos-postgres-single-admin-copy',
    sourceDatabase: `postgresql-${fixture.source.database.version}`,
    originalFiles: input.photos.length,
    owners: 1,
    captionsVerified: input.photos.length,
    favouritesVerified: 1,
    albumMembers: photoIds.length,
    captureInstantVerified: true,
    passwordPreserved: 'django-argon2',
    approvedLosses: losses,
  },
});
