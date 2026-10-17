import { Kysely } from 'kysely';
import type { FrameleafCloudLink } from 'src/types.js';
import { DatabaseLock, SystemMetadataKey } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { FrameleafCloudService } from 'src/services/frameleaf-cloud.service.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { newMediumService } from 'test/medium.factory.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db.destroy();
});
afterEach(() => vi.restoreAllMocks());

const url = 'https://cloud.test';
const pending = (): FrameleafCloudLink => ({
  status: 'pending',
  cloudUrl: url,
  permissions: { allowRemoteEnable: false, allowBackupTrigger: false, allowEntitlementRefresh: true },
  pending: {
    deviceCode: 'device-1',
    userCode: 'ABCD-EFGH',
    verificationUri: 'https://id.cloud.test/device',
    verificationUriComplete: 'https://id.cloud.test/device?user_code=ABCD-EFGH',
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    intervalSeconds: 5,
    nextPollAt: new Date(0).toISOString(),
  },
});

it.each(['start', 'poll', 'cancel', 'approval', 'held-region', 'headless'] as const)(
  'rejects stale %s publication after a separate PostgreSQL authority writer commits',
  async (phase) => {
    const h = await setup();
    const initial =
      phase === 'start'
        ? null
        : phase === 'held-region'
          ? {
              status: 'unlinked' as const,
              cloudUrl: url,
              heldLink: { linkToken: 'synthetic-held-token', accountRegion: 'eu' },
            }
          : phase === 'headless'
            ? { status: 'unlinked' as const, cloudUrl: url, usedLinkTokens: ['synthetic-token-hash'] }
            : pending();
    if (initial) await h.metadata.set(SystemMetadataKey.FrameleafCloudLink, initial);
    else await h.metadata.delete(SystemMetadataKey.FrameleafCloudLink);
    const candidate: FrameleafCloudLink =
      phase === 'cancel'
        ? { status: 'unlinked', cloudUrl: url }
        : phase === 'approval'
          ? {
              status: 'linked',
              cloudUrl: url,
              instanceId: 'old-instance',
              accountId: 'old-owner',
              linkedAt: 'old-generation',
            }
          : phase === 'held-region' || phase === 'headless'
            ? { ...initial!, lastError: 'old attempt failed' }
            : pending();
    const replacement: FrameleafCloudLink = {
      status: 'linked',
      cloudUrl: url,
      instanceId: 'new-instance',
      accountId: 'new-owner',
      linkedAt: 'new-generation',
    };
    const entered = Promise.withResolvers<void>(),
      resume = Promise.withResolvers<void>();
    const writer = h.writer.ctx.get(DatabaseRepository).withLock(DatabaseLock.FrameleafLinkAuthority, async () => {
      entered.resolve();
      await resume.promise;
      await h.metadata.set(SystemMetadataKey.FrameleafCloudLink, replacement);
    });
    await entered.promise;
    const publication = h.save(candidate, { expected: initial, replaceAuthority: phase === 'approval' });
    try {
      resume.resolve();
      await writer;
      await expect(publication).resolves.toBe(false);
      expect(await h.metadata.get(SystemMetadataKey.FrameleafCloudLink)).toEqual(replacement);
    } finally {
      resume.resolve();
      await Promise.allSettled([writer, publication]);
      await h.restore();
    }
  },
);

it('retains a committed permission change while publishing progress for the same pending attempt', async () => {
  const h = await setup(),
    initial = pending();
  try {
    await h.metadata.set(SystemMetadataKey.FrameleafCloudLink, initial);
    await h.writer.sut.updatePermissions(authStub.admin, { allowRemoteEnable: true });
    const nextPollAt = new Date(Date.now() + 5000).toISOString();
    await expect(
      h.save({ ...initial, pending: { ...initial.pending!, nextPollAt } }, { expected: initial }),
    ).resolves.toBe(true);
    expect(await h.metadata.get(SystemMetadataKey.FrameleafCloudLink)).toMatchObject({
      permissions: { allowRemoteEnable: true },
      pending: { nextPollAt },
    });
  } finally {
    await h.restore();
  }
});

const setup = async () => {
  const env = mockEnvData({});
  const options = {
    database: db,
    real: [DatabaseRepository, SystemMetadataRepository],
    mock: [ConfigRepository, LoggingRepository, UserRepository],
  };
  const publisher = newMediumService(FrameleafCloudService, options),
    writer = newMediumService(FrameleafCloudService, options);
  for (const { sut, ctx } of [publisher, writer]) {
    ctx.getMock(ConfigRepository).getEnv.mockReturnValue({ ...env, frameleafCloud: { ...env.frameleafCloud, url } });
    ctx.getMock(UserRepository).getAdmins.mockResolvedValue([]);
    vi.spyOn(sut, 'getStatus').mockResolvedValue({} as never);
  }
  const metadata = publisher.ctx.get(SystemMetadataRepository),
    previous = await metadata.get(SystemMetadataKey.FrameleafCloudLink);
  const internal = publisher.sut as unknown as {
    saveLink: (
      link: FrameleafCloudLink,
      topic: null,
      options: { expected: FrameleafCloudLink | null; replaceAuthority?: boolean },
    ) => Promise<boolean>;
  };
  const restore = async () => {
    if (previous) await metadata.set(SystemMetadataKey.FrameleafCloudLink, previous);
    else await metadata.delete(SystemMetadataKey.FrameleafCloudLink);
  };
  return {
    writer,
    metadata,
    save: (link: FrameleafCloudLink, options: { expected: FrameleafCloudLink | null; replaceAuthority?: boolean }) =>
      internal.saveLink(link, null, options),
    restore,
  };
};
