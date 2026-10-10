import { Kysely } from 'kysely';
import type { FrameleafRemoteConnection } from 'src/types.js';
import { defaults } from 'src/dtos/config.dto.js';
import { SystemMetadataKey } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { ItemShareRepository } from 'src/repositories/item-share.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { WebsocketRepository } from 'src/repositories/websocket.repository.js';
import { DB } from 'src/schema/index.js';
import { ItemShareService, SHARED_WITH_YOU_PATH } from 'src/services/item-share.service.js';
import { clearConfigCache } from 'src/utils/config.js';
import { newMediumService } from 'test/medium.factory.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

/**
 * FL-198 (FL-83 AL-30b): the link a per-item share hands out, resolved by the real service from the
 * configuration and Frameleaf Cloud state stored in PostgreSQL. The Public server URL wins, then a
 * verified custom CNAME the request arrived on (or chose with "Use my domain"), then the published
 * direct-connection address. A Host header the server does not publish is never used.
 */
const CLOUD = 'https://cloud.frameleaf.test';
const DIRECT = 'https://1-2-3-4.lbl.direct.frameleaf.test:2443';
const RELAY = 'https://r.lbl.frameleaf.test';
const CUSTOM = 'photos.family.example';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  clearConfigCache();
  await db?.destroy();
});
beforeEach(() => clearConfigCache());

const candidate = (uri: string, flags: Partial<FrameleafRemoteConnection> = {}): FrameleafRemoteConnection => {
  const url = new URL(uri);
  return {
    kind: 'wan',
    uri,
    protocol: 'https',
    address: url.hostname,
    port: Number(url.port || 443),
    local: false,
    relay: false,
    ipv6: false,
    custom: false,
    dnsRebindingProtection: false,
    httpsRequired: true,
    verified: false,
    ...flags,
  };
};

const setup = () => {
  const { sut, ctx } = newMediumService(ItemShareService, {
    database: db,
    real: [AccessRepository, AssetRepository, ItemShareRepository, SystemMetadataRepository, UserRepository],
    mock: [ConfigRepository, EventRepository, LoggingRepository, WebsocketRepository],
  });
  const env = mockEnvData({});
  ctx
    .getMock(ConfigRepository)
    .getEnv.mockReturnValue(mockEnvData({ frameleafCloud: { ...env.frameleafCloud, url: CLOUD } }));
  ctx.getMock(EventRepository).emit.mockResolvedValue();
  return { sut, ctx, metadata: ctx.get(SystemMetadataRepository) };
};

type Setup = ReturnType<typeof setup>;

/** Stores the system config, Cloud link and edge state the way the server does. */
const configure = async (
  metadata: Setup['metadata'],
  {
    publicUrl = '',
    customHostname = false,
    useCustom = false,
    linked = true,
  }: { publicUrl?: string; customHostname?: boolean; useCustom?: boolean; linked?: boolean },
) => {
  const remote = defaults.frameleafCloud.remoteAccess;
  await metadata.withConfigTransaction((bound) =>
    bound.set(SystemMetadataKey.SystemConfig, {
      server: { externalDomain: publicUrl },
      frameleafCloud: {
        remoteAccess: {
          ...remote,
          enabled: true,
          mode: 'relay-and-direct',
          publicUrl: useCustom ? 'custom' : remote.publicUrl,
          customHostname: customHostname
            ? { host: CUSTOM, status: 'verified', checkedAt: null }
            : remote.customHostname,
        },
      },
    } as never),
  );
  await (linked
    ? metadata.set(SystemMetadataKey.FrameleafCloudLink, {
        status: 'linked',
        cloudUrl: CLOUD,
        instanceId: 'instance-1',
        services: { publicUrl: RELAY },
      } as never)
    : metadata.delete(SystemMetadataKey.FrameleafCloudLink));
  await metadata.set(SystemMetadataKey.FrameleafRemoteAccess, {
    status: 'ready',
    bootId: 'item-share-medium',
    updatedAt: new Date().toISOString(),
    reason: null,
    names: { instanceId: 'instance-1', names: { relay: 'r.lbl.frameleaf.test' } },
    relay: { connected: true },
    candidates: [
      candidate('https://192-168-1-2.lbl.frameleaf.test:2283', { kind: 'local', local: true }),
      candidate(DIRECT, { verified: true }),
      candidate(`https://${CUSTOM}`, { relay: true, custom: true }),
      candidate(RELAY, { kind: 'relay', relay: true }),
    ],
  } as never);
  clearConfigCache();
};

/** The owner shares one item with a recipient, and the recipient opens "Shared with you". */
const shareOne = async ({ ctx, sut }: Setup, host?: string) => {
  const origin = host ? `https://${host}` : undefined;
  const { user: owner } = await ctx.newUser();
  const { user: recipient } = await ctx.newUser();
  const { asset } = await ctx.newAsset({ ownerId: owner.id });
  const result = await sut.share(
    factory.auth({ user: owner }),
    { assetIds: [asset.id], userIds: [recipient.id] },
    origin,
  );
  const received = await sut.getReceived(factory.auth({ user: recipient }), origin);
  return { owner, recipient, asset, result, received };
};

describe('item-share links (FL-198)', () => {
  it('uses the Public server URL for the share, the recipient view and the notification', async () => {
    const context = setup();
    await configure(context.metadata, {
      publicUrl: 'https://photos.example.com/',
      customHostname: true,
      useCustom: true,
    });

    const { owner, recipient, asset, result, received } = await shareOne(context, 'attacker.example');

    const link = `https://photos.example.com${SHARED_WITH_YOU_PATH}`;
    expect(result).toMatchObject({ added: 1, removed: 0, link });
    expect(result.shares).toEqual([expect.objectContaining({ assetId: asset.id })]);
    expect(received.link).toBe(link);
    expect(received.items.map((item) => item.asset.id)).toEqual([asset.id]);
    expect(context.ctx.getMock(EventRepository).emit).toHaveBeenCalledWith('ItemShare', {
      ownerId: owner.id,
      userId: recipient.id,
      senderName: owner.name,
      count: 1,
      link,
    });
  });

  it('otherwise uses the published direct-connection address, never the Host header', async () => {
    const context = setup();
    await configure(context.metadata, {});

    const { result, received } = await shareOne(context, 'attacker.example');

    expect(result.link).toBe(`${DIRECT}${SHARED_WITH_YOU_PATH}`);
    expect(received.link).toBe(`${DIRECT}${SHARED_WITH_YOU_PATH}`);
  });

  it('does not trust a custom CNAME until Frameleaf Cloud verified it', async () => {
    const context = setup();
    await configure(context.metadata, {});

    const { result } = await shareOne(context, CUSTOM);

    expect(result.link).toBe(`${DIRECT}${SHARED_WITH_YOU_PATH}`);
  });

  it('keeps a request that arrived on the verified custom CNAME on that name', async () => {
    const context = setup();
    await configure(context.metadata, { customHostname: true });

    const { result, received } = await shareOne(context, CUSTOM);

    expect(result.link).toBe(`https://${CUSTOM}${SHARED_WITH_YOU_PATH}`);
    expect(received.link).toBe(`https://${CUSTOM}${SHARED_WITH_YOU_PATH}`);
  });

  it('uses the verified custom CNAME when "Use my domain" is chosen', async () => {
    const context = setup();
    await configure(context.metadata, { customHostname: true, useCustom: true });

    const { result } = await shareOne(context);

    expect(result.link).toBe(`https://${CUSTOM}${SHARED_WITH_YOU_PATH}`);
  });

  it('shares without a link when the server has no address to hand out', async () => {
    const context = setup();
    await configure(context.metadata, { linked: false });

    const { owner, recipient, result, received } = await shareOne(context, 'attacker.example');

    expect(result).toMatchObject({ added: 1, link: null });
    expect(received.link).toBeNull();
    expect(received.items).toHaveLength(1);
    expect(context.ctx.getMock(EventRepository).emit).toHaveBeenCalledWith(
      'ItemShare',
      expect.objectContaining({ ownerId: owner.id, userId: recipient.id, link: null }),
    );
  });
});
