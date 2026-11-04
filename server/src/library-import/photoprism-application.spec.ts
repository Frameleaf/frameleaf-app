import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import cases from 'src/library-import/fixtures/photoprism/261029-login-cases.json' with { type: 'json' };
import fixture from 'src/library-import/fixtures/photoprism/261029-sqlite.json' with { type: 'json' };
import { verifyImportedPassword } from 'src/library-import/passwords.js';
import { openPhotoprismSnapshot } from 'src/library-import/photoprism.js';
import { captureSqliteSnapshot } from 'src/library-import/sqlite.js';

const path = process.env.FRAMELEAF_PHOTOPRISM_APPLICATION_CONFIG;
describe.skipIf(!path)('native PhotoPrism application local account', () => {
  it('retains source account restrictions separately from the compatible password verifier', async () => {
    const directory = dirname(path!);
    if (
      basename(path!) !== 'test.json' ||
      !/^application-[A-Za-z0-9]{6}$/u.test(basename(directory)) ||
      !/^frameleaf-photoprism-\d+-\d+$/u.test(basename(dirname(directory)))
    )
      throw new Error('Native account test requires a dedicated qualification directory');
    const config = JSON.parse(readFileSync(path!, 'utf8'));
    const sourceCase = cases.cases.find((item) => item.name === config.caseName);
    if (!sourceCase) throw new Error('Native account test requires a known source login case');
    const expected = { ...cases.base, ...sourceCase.fields };
    if (config.stagingRoot !== directory || config.databasePath !== join(directory, 'storage', 'index.db'))
      throw new Error('Native account test requires its own source database');
    const snapshot = await captureSqliteSnapshot(config.databasePath, config.stagingRoot);
    expect(snapshot.schemaSha256).toBe(fixture.schemaSha256);
    const source = openPhotoprismSnapshot(snapshot.path, fixture.source.version);
    try {
      const user = [...source.rows('users')].flat().find((row) => row.user_uid === config.sourceUserId);
      expect(user).toMatchObject({
        id: 1n,
        user_name: 'admin',
        user_role: 'admin',
        auth_provider: expected.auth_provider,
        auth_method: expected.auth_method,
        super_admin: BigInt(expected.super_admin),
        can_login: BigInt(expected.can_login),
      });
      for (const name of ['expires_at', 'deleted_at'] as const) {
        if (expected[name] === null) expect(user?.[name]).toBeNull();
        else expect(Date.parse(String(user?.[name]))).toBe(Date.parse(expected[name]));
      }
      const credential = await source.password({
        operationId: randomUUID(),
        sourceUserId: config.sourceUserId,
        destinationUserId: randomUUID(),
      });
      expect(credential).toBeDefined();
      expect(await verifyImportedPassword(config.password, credential!.forImport())).toBe(true);
      expect(await verifyImportedPassword('wrong-' + config.password, credential!.forImport())).toBe(false);
      expect(JSON.stringify(credential).includes(config.password)).toBe(false);
      expect(user).not.toHaveProperty('hash');
      expect(user).not.toHaveProperty('reset_token');
    } finally {
      source.close();
    }
  }, 30_000);
});
