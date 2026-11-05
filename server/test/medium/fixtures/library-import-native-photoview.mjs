// Native Photoview qualification: the parent seeds a disposable Photoview 2.4.0 (SQLite) with four accounts,
// directory grants, a shared directory and a viewer favourite, stops it, and hands its storage to this runner.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
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

const family = 'photoview';
const byText = (left, right) => left.localeCompare(right);
const byJson = (left, right) => byText(JSON.stringify(left), JSON.stringify(right));
const { directory, stateDirectory, sourceDirectory, runId, input } = await nativeContext(family);
assert.equal(input.databasePath, path.join(sourceDirectory, 'storage/photoview.sqlite'));
assert.equal(input.originals, path.join(sourceDirectory, 'originals'));
assert.match(input.container.id, /^[a-f0-9]{64}$/u);
assert.equal(input.container.name, `frameleaf-photoview-${runId}`);
const { default: fixture } = await import('src/library-import/fixtures/photoview/2.4.0-sqlite.json', {
  with: { type: 'json' },
});
const { captureSqliteSnapshot } = await import('src/library-import/sqlite.js');
const { openPhotoviewSnapshot, readPhotoviewManifest } = await import('src/library-import/photoview.js');
const { publishAdapterImportBundle } = await import('src/library-import/photoprism-bundle.js');
const { verifyImportedPassword } = await import('src/library-import/passwords.js');

// Stopped-writer fingerprint: the main database plus any committed pages left in its WAL.
const fingerprint = async () => {
  let wal;
  try {
    wal = await stat(input.databasePath + '-wal');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return {
    database: await sha256(input.databasePath),
    wal: wal?.size ? await sha256(input.databasePath + '-wal') : 'absent',
  };
};
const authorize = stoppedContainerAuthority({ family, runId, containers: [input.container], fingerprint });
await authorize();
const captured = await captureSqliteSnapshot(input.databasePath, directory);
const revision = await sha256(captured.path);
const verifySource = async () => {
  await authorize();
  assert.equal(await sha256(captured.path), revision, 'Captured Photoview snapshot changed');
};
await verifySource();

// Every seeded directory belongs to the account it is named after; the shared directory is assigned to alice,
// who (with bob) can read it and who marked its photo a favourite.
const directoryOwner = { admin: 'admin', alice: 'alice', bob: 'bob', shared: 'alice' };
const actorOf = (sourcePath) => {
  const [, photos, top] = String(sourcePath).split('/', 3);
  assert.equal(photos, 'photos');
  assert.ok(Object.hasOwn(directoryOwner, top), 'Unexpected Photoview directory');
  return directoryOwner[top];
};
const captions = new Map(input.seeds.filter((seed) => seed.caption).map((seed) => [seed.path, seed.caption]));
const operationId = randomUUID(),
  destinationId = randomUUID();
const sourceRoot = input.originals;
const destinationRoot = path.join(directory, 'destination');
const snapshot = openPhotoviewSnapshot(captured.path, fixture.source.version);
let published, expected;
try {
  const users = [...snapshot.rows('users')].flat();
  const media = [...snapshot.rows('media')].flat();
  const albums = [...snapshot.rows('albums')].flat();
  assert.equal(users.length, 4);
  assert.equal(media.length, input.seeds.length);
  const actors = Object.fromEntries(
    Object.entries(input.actors).map(([actor, { id }]) => {
      assert.ok(users.some((row) => String(row.id) === id && row.username === `fixture_${actor}`));
      return [actor, id];
    }),
  );
  const files = media.map((row) => {
    const relative = String(row.path).slice('/photos/'.length);
    const seed = input.seeds.find((entry) => entry.path === relative);
    assert.ok(seed, 'Source original must have independent seed evidence');
    return { id: `media:${row.id}`, path: relative, sha256: seed.sha256, assetId: String(row.id) };
  });
  for (const file of files)
    await mkdir(path.join(destinationRoot, 'owner', path.posix.dirname(file.path)), { recursive: true, mode: 0o700 });
  const { roots, observed, placements } = await copyPlacements({ sourceRoot, destinationRoot, files });
  for (const file of observed)
    assert.equal(file.bytes, input.seeds.find((seed) => seed.path === file.path).bytes, 'Seed byte count changed');
  const source = {
    kind: family,
    version: fixture.source.version,
    identity: input.container.id,
    revision,
    schemaSha256: snapshot.schemaSha256,
  };
  const { manifest, archive } = readPhotoviewManifest(snapshot, {
    source,
    inventory: {
      complete: true,
      ownershipComplete: true,
      privacyComplete: true,
      writersStopped: true,
      revisionBefore: revision,
      revisionAfter: revision,
    },
    sourceRoot: '/photos',
    photoOwners: Object.fromEntries(media.map((row) => [String(row.id), actors[actorOf(row.path)]])),
    albumOwners: Object.fromEntries(albums.map((row) => [String(row.id), actors[actorOf(row.path)]])),
    files: observed,
  });
  // Reviewed Photoview differences for this library: raw rows archived, nested directories flattened, share links
  // and multi-reader directories not recreated, nanosecond scan clocks truncated to microseconds, and the
  // captioned originals' EXIF clock stored by Photoview as UTC without a provable regional offset.
  const reviewedLosses = new Set([
    'PHOTOVIEW_SOURCE_METADATA_ARCHIVED',
    'PHOTOVIEW_DIRECTORY_HIERARCHY_ARCHIVED',
    'PHOTOVIEW_SHARING_RESTRICTED',
    'PHOTOVIEW_CAPTURE_PRECISION_ARCHIVED',
    'PHOTOVIEW_CAPTURE_TIME_ZONE_UNRESOLVED',
  ]);
  const reported = new Set(manifest.losses.map((loss) => loss.code));
  assert.deepEqual(
    [...reported].filter((code) => !reviewedLosses.has(code)),
    [],
    'Unreviewed Photoview loss reported',
  );
  for (const code of ['PHOTOVIEW_SOURCE_METADATA_ARCHIVED', 'PHOTOVIEW_SHARING_RESTRICTED'])
    assert.ok(reported.has(code), 'Expected Photoview loss missing: ' + code);
  const ownerMappings = users.map((row) => ({ sourceId: String(row.id), destinationId: randomUUID() }));
  const destinationOf = new Map(ownerMappings.map((owner) => [owner.sourceId, owner.destinationId]));
  const owners = [];
  for (const { sourceId, destinationId: destinationUserId } of ownerMappings) {
    const credential = await snapshot.password({ operationId, sourceUserId: sourceId, destinationUserId });
    assert.ok(credential, 'Photoview account must carry a compatible password');
    owners.push({ intent: ownerIntent(sourceId, revision), credential });
  }
  published = await publishAdapterImportBundle({
    manifest,
    archive,
    approvedLossCodes: reported,
    roots,
    placements,
    ownerMappings,
    owners,
    stagingRoot: directory,
    operationId,
    destinationId,
    verifySource,
  });
  const favourites = new Map([[String(input.sharedMediaId), true]]);
  expected = {
    destinationOf,
    actors,
    losses: [...reported].toSorted(byText),
    assets: media.map((row) => {
      const relative = String(row.path).slice('/photos/'.length);
      return {
        sourceId: String(row.id),
        owner: destinationOf.get(actors[actorOf(row.path)]),
        sha256: input.seeds.find((seed) => seed.path === relative).sha256,
        description: captions.get(relative) ?? 'none',
        favorite: favourites.get(String(row.id)) ?? false,
        name: path.posix.basename(relative),
      };
    }),
    albums: albums
      .map((row) => {
        const owner = actors[actorOf(row.path)];
        return {
          name: row.title,
          owner: destinationOf.get(owner),
          members: media
            .filter((item) => item.album_id === row.id && actors[actorOf(item.path)] === owner)
            .map((item) => String(item.id))
            .toSorted(byText),
        };
      })
      .toSorted(byJson),
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
      assert.ok(asset, 'Imported Photoview asset missing');
      assert.equal(asset.owner, want.owner);
      assert.equal(await sha256(asset.originalPath), want.sha256);
      assert.equal(asset.originalFileName, want.name);
      assert.equal(asset.description || 'none', want.description);
      assert.equal(asset.isFavorite, want.favorite);
      assert.equal(asset.visibility, 'timeline');
      assert.equal(asset.locked, false);
    }
    assert.ok(
      expected.assets.some((asset) => asset.description !== 'none'),
      'At least one seeded caption must be checked',
    );
    assert.equal(expected.assets.filter((asset) => asset.favorite).length, 1);
    const shared = assets.find((row) => row.sourceId === String(input.sharedMediaId));
    assert.equal(shared.owner, expected.destinationOf.get(expected.actors.alice));
    assert.equal(shared.isFavorite, true, "Alice's favourite on the shared photo must survive");
    const actual = albums
      .map((row) => ({ name: row.name, owner: row.owner, members: [...row.members].toSorted(byText) }))
      .toSorted(byJson);
    assert.deepEqual(actual, expected.albums);
    assert.ok(actual.some((album) => album.members.length > 0));
    for (const [actor, { id, password }] of Object.entries(input.actors)) {
      const rows = await query('SELECT password,"importClaimPending",email FROM public."user" WHERE id=$1::uuid', [
        expected.destinationOf.get(id),
      ]);
      assert.equal(rows.length, 1, `Imported ${actor} account missing`);
      assert.equal(rows[0].importClaimPending, false);
      assert.equal(await verifyImportedPassword(password, rows[0].password), true, `${actor} password not preserved`);
      assert.equal(await verifyImportedPassword('wrong-' + password, rows[0].password), false);
    }
  },
  result: {
    nativeScope: 'photoview-multi-account-directory-copy',
    originalFiles: expected.assets.length,
    owners: Object.keys(input.actors).length,
    sharedDirectoryOwner: 'alice',
    viewerFavouriteVerified: true,
    passwordsPreserved: Object.keys(input.actors).length,
    approvedLosses: expected.losses,
  },
});
