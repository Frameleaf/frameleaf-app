import { Kysely } from 'kysely';
import { SystemMetadataKey } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { DB } from 'src/schema/index.js';
import { CliService } from 'src/services/cli.service.js';
import { ConfigHistory } from 'src/utils/config-history.js';
import { clearConfigCache } from 'src/utils/config.js';
import { newMediumService } from 'test/medium.factory.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';
import { getKyselyDB } from 'test/utils.js';

/**
 * FL-146 (FL-66, owner decision 2026-09-29): a settings change made from the server command line is
 * listed in the settings history, labelled with its source, in the same store administrators' saves use.
 */
let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  clearConfigCache();
  await db?.destroy();
});

const setup = () => {
  const services = newMediumService(CliService, {
    database: db,
    real: [CryptoRepository, DatabaseRepository, SystemMetadataRepository],
    mock: [ConfigRepository, LoggingRepository],
  });
  services.ctx.getMock(ConfigRepository).getEnv.mockReturnValue(mockEnvData({}));
  return services;
};

describe('settings history from the server command line (FL-146)', () => {
  it('lists password and OAuth sign-in changes as "server-cli", newest first', async () => {
    const { sut, ctx } = setup();
    const metadata = ctx.get(SystemMetadataRepository);
    await metadata.delete(SystemMetadataKey.SystemConfigHistory);
    clearConfigCache();

    await sut.disablePasswordLogin();
    await sut.enableOAuthLogin();
    // no change, no entry
    await sut.enableOAuthLogin();

    const history = (await metadata.get(SystemMetadataKey.SystemConfigHistory)) as ConfigHistory;
    expect(history.entries).toHaveLength(2);
    expect(history.entries[0]).toMatchObject({
      source: 'server-cli',
      actorId: null,
      actorName: null,
      kind: 'settings',
      changes: [expect.objectContaining({ path: 'oauth.enabled', before: 'false', after: 'true' })],
    });
    expect(history.entries[1]).toMatchObject({
      source: 'server-cli',
      changes: [expect.objectContaining({ path: 'passwordLogin.enabled', before: 'true', after: 'false' })],
    });
  });
});
