import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import fixture from 'src/library-import/fixtures/photoview/2.4.0-sqlite.json' with { type: 'json' };
import { verifyImportedPassword } from 'src/library-import/passwords.js';
import { normalizePhotoviewAccess } from 'src/library-import/photoview-access.js';
import { openPhotoviewSnapshot } from 'src/library-import/photoview.js';
import { captureSqliteSnapshot } from 'src/library-import/sqlite.js';

const path = process.env.FRAMELEAF_PHOTOVIEW_APPLICATION_CONFIG;
describe.skipIf(!path)('native Photoview application', () => {
  it('matches independently observed directory access, favourites and compatible accounts', async () => {
    const directory = dirname(path!);
    if (
      basename(path!) !== 'test.json' ||
      !/^application-[A-Za-z0-9]{6}$/u.test(basename(directory)) ||
      !/^frameleaf-photoview-\d+-\d+$/u.test(basename(dirname(directory)))
    )
      throw new Error('Native Photoview test requires a dedicated qualification directory');
    const config = JSON.parse(readFileSync(path!, 'utf8'));
    if (
      config.stagingRoot !== directory ||
      config.databasePath !== join(directory, 'storage', 'photoview.sqlite') ||
      config.originals !== join(directory, 'originals')
    )
      throw new Error('Native Photoview test requires its own source storage');
    const snapshot = await captureSqliteSnapshot(config.databasePath, directory);
    const source = (() => {
      try {
        return openPhotoviewSnapshot(snapshot.path, fixture.source.version);
      } catch (error) {
        const schema = new DatabaseSync(snapshot.path, { readOnly: true, allowExtension: false });
        try {
          expect(schema.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all()).toEqual(
            fixture.objects,
          );
        } finally {
          schema.close();
        }
        throw error;
      }
    })();
    try {
      expect(source.schemaSha256).toBe(snapshot.schemaSha256);
      const users = [...source.rows('users')].flat();
      expect(users).toHaveLength(4);
      const access = normalizePhotoviewAccess({
        users,
        albums: [...source.rows('albums')].flat(),
        media: [...source.rows('media')].flat(),
        userAlbums: [...source.rows('user_albums')].flat(),
        preferences: [...source.rows('user_media_data')].flat(),
      });
      expect(access).toHaveLength(4);
      for (const actor of ['admin', 'alice', 'bob', 'mallory']) {
        const owner = config.actors[actor];
        const user = users.find((row) => String(row.id) === owner.id);
        expect(user).toMatchObject({ username: `fixture_${actor}`, admin: actor === 'admin' ? 1n : 0n });
        expect(user).not.toHaveProperty('password');
        expect(
          access
            .filter((row) => row.readerIds.includes(owner.id))
            .map((row) => row.id)
            .sort(),
        ).toEqual(config.visible[actor].map((row: { id: string }) => row.id).sort());
        const credential = await source.password({
          operationId: randomUUID(),
          sourceUserId: owner.id,
          destinationUserId: randomUUID(),
        });
        expect(credential).toBeDefined();
        expect(await verifyImportedPassword(owner.password, credential!.forImport())).toBe(true);
        expect(await verifyImportedPassword('wrong-' + owner.password, credential!.forImport())).toBe(false);
        expect(JSON.stringify(credential).includes(owner.password)).toBe(false);
      }
      const shared = access.find((row) => row.id === config.sharedMediaId)!;
      expect(shared.readerIds.toSorted()).toEqual([config.actors.alice.id, config.actors.bob.id].sort());
      expect(shared.favorites).toContainEqual({ userId: config.actors.alice.id, favorite: true });
      expect(shared.favorites.some((row) => row.userId === config.actors.bob.id && row.favorite)).toBe(false);
      const originals = [...source.rows('media')].flat();
      for (const row of originals) {
        expect(typeof row.path).toBe('string');
        const seed = config.seeds.find((entry: { path: string }) => '/photos/' + entry.path === row.path);
        expect(seed).toBeDefined();
        const bytes = readFileSync(join(config.originals, seed.path));
        expect(String(bytes.length)).toBe(seed.bytes);
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(seed.sha256);
      }
      const shares = [...source.rows('share_tokens')].flat();
      expect(shares).toHaveLength(2);
      for (const expected of config.protection) {
        const share = shares.find((row) => String(row.id) === expected.id);
        expect(share?.has_password).toBe(expected.protected ? 1n : 0n);
        expect(share).not.toHaveProperty('value');
        expect(share).not.toHaveProperty('password');
      }
    } finally {
      source.close();
    }
  }, 30_000);
});
