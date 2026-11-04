import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import fixture from 'src/library-import/fixtures/photoprism/261029-sqlite.json' with { type: 'json' };
import { verifyImportedPassword } from 'src/library-import/passwords.js';
import { openPhotoprismSnapshot } from 'src/library-import/photoprism.js';
import { captureSqliteSnapshot } from 'src/library-import/sqlite.js';

const path = process.env.FRAMELEAF_PHOTOPRISM_APPLICATION_CONFIG;
describe.skipIf(!path)('native PhotoPrism application local account', () => {
  it('preserves the password and identity accepted by the pinned running application', async () => {
    const config = JSON.parse(readFileSync(path!, 'utf8'));
    const snapshot = await captureSqliteSnapshot(config.databasePath, config.stagingRoot);
    expect(snapshot.schemaSha256).toBe(fixture.schemaSha256);
    const source = openPhotoprismSnapshot(snapshot.path, fixture.source.version);
    try {
      const user = [...source.rows('users')].flat().find((row) => row.user_uid === config.sourceUserId);
      expect(user).toMatchObject({ user_name: 'admin', auth_provider: 'local', user_role: 'admin' });
      const credential = await source.password({
        operationId: randomUUID(),
        sourceUserId: config.sourceUserId,
        destinationUserId: randomUUID(),
      });
      expect(credential).toBeDefined();
      expect(await verifyImportedPassword(config.password, credential!.forImport())).toBe(true);
      expect(await verifyImportedPassword('wrong-' + config.password, credential!.forImport())).toBe(false);
      expect(JSON.stringify(credential)).not.toContain(config.password);
      expect(user).not.toHaveProperty('hash');
      expect(user).not.toHaveProperty('reset_token');
    } finally {
      source.close();
    }
  }, 30_000);
});
