import { HttpException } from '@nestjs/common';
import { type KeyObject, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { vi } from 'vitest';
import type { Request } from 'express';
import type { HouseholdLinkAddress } from 'src/schema/tables/household-link.table.js';
import type { FrameleafKeySigner } from 'src/utils/frameleaf-dpop.js';
import { HouseholdPeerController } from 'src/controllers/household-peer.controller.js';
import { SystemMetadataKey } from 'src/enum.js';
import { FrameleafCloudRepository } from 'src/repositories/frameleaf-cloud.repository.js';
import { InstanceIdentityRepository } from 'src/repositories/instance-identity.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { HouseholdLinkService } from 'src/services/household-link.service.js';
import { HouseholdPeerService } from 'src/services/household-peer.service.js';
import { HouseholdShareService } from 'src/services/household-share.service.js';
import { ed25519Thumbprint } from 'src/utils/frameleaf-cloud.js';
import {
  type FakeCloud,
  type FakeHouseholdServer,
  addHouseholdRoutes,
  startFakeCloud,
} from 'test/fake-frameleaf-cloud.js';
import { ShareWorld } from 'test/fixtures/household-shares.js';

type AnyMock = (...args: any[]) => any;

/** A real Ed25519 signer, as `InstanceIdentityRepository.currentSigner()` returns. */
export const householdSigner = (
  privateKey: KeyObject = generateKeyPairSync('ed25519').privateKey,
): FrameleafKeySigner => {
  const { x } = privateKey.export({ format: 'jwk' }) as { x: string };
  const publicJwk = { kty: 'OKP' as const, crv: 'Ed25519' as const, x };
  return {
    kid: ed25519Thumbprint(publicJwk),
    publicJwk,
    sign: (header, payload) => {
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
      const input = `${encode(header)}.${encode(payload)}`;
      return `${input}.${sign(null, Buffer.from(input), privateKey).toString('base64url')}`;
    },
  };
};
type LinkRow = {
  id: string;
  cloudLinkId: string;
  peerInstanceId: string;
  peerName: string;
  householdName: string;
  peerPublicKey: string;
  addresses: HouseholdLinkAddress[];
  state: string;
  pausedReason: string | null;
  connectionPath: string | null;
  lastSeenAt: Date | null;
  pollRequestedAt?: Date | null;
  createdAt: Date;
  endedAt: Date | null;
};

/** `HouseholdLinkRepository` with the same rules, in memory (the medium spec covers the real one). */
export class MemoryHouseholdLinks {
  rows: LinkRow[] = [];
  admitted = new Map<string, { linkId: string; expiresAt: Date }>();

  getAll() {
    return Promise.resolve(this.rows.map((row) => ({ ...row })));
  }
  get(id: string) {
    const row = this.rows.find((row) => row.id === id);
    return Promise.resolve(row && { ...row });
  }
  getByCloudLinkId(cloudLinkId: string) {
    const row = this.rows.find((row) => row.cloudLinkId === cloudLinkId);
    return Promise.resolve(row && { ...row });
  }
  create(link: Pick<LinkRow, 'cloudLinkId' | 'peerInstanceId' | 'peerName' | 'householdName' | 'peerPublicKey'>) {
    let row = this.rows.find((row) => row.cloudLinkId === link.cloudLinkId);
    if (!row) {
      row = {
        id: randomUUID(),
        addresses: [],
        state: 'active',
        pausedReason: null,
        connectionPath: null,
        lastSeenAt: null,
        createdAt: new Date(),
        endedAt: null,
        ...link,
      };
      this.rows.push(row);
    }
    return Promise.resolve({ ...row });
  }
  update(id: string, change: Partial<LinkRow>) {
    const row = this.rows.find((row) => row.id === id && row.state !== 'ended');
    return Promise.resolve(row && { ...Object.assign(row, change) });
  }
  rename(id: string, householdName: string) {
    const row = this.rows.find((row) => row.id === id);
    return Promise.resolve(row && { ...Object.assign(row, { householdName }) });
  }
  admit(jti: string, linkId: string, expiresAt: Date) {
    for (const [key, { expiresAt }] of this.admitted) {
      if (expiresAt.getTime() <= Date.now()) {
        this.admitted.delete(key);
      }
    }
    if (this.admitted.has(jti)) {
      return Promise.resolve(false);
    }
    this.admitted.set(jti, { linkId, expiresAt });
    return Promise.resolve(true);
  }
}

export type HouseholdCloud = { cloud: FakeCloud; households: ReturnType<typeof addHouseholdRoutes> };
export const startHouseholdCloud = async (): Promise<HouseholdCloud> => {
  const cloud = await startFakeCloud();
  return { cloud, households: addHouseholdRoutes(cloud) };
};

/**
 * One Frameleaf server for the household specs: the real services, Cloud repository and identity key, linked to
 * the fake Cloud. Only the database is replaced (`MemoryHouseholdLinks`, counters in a map). The spec file must
 * mock `getConfig` of `src/utils/config.js` to answer `{ server: { name: repos.configRepo.serverName } }`.
 */
export const startHouseholdServer = async (
  { cloud, households }: HouseholdCloud,
  name: string,
  registration: Partial<FakeHouseholdServer> = {},
) => {
  const directory = await mkdtemp(join(tmpdir(), 'household-identity-'));
  const metadata = new Map<string, unknown>();
  const counts = new Map<string, number>();
  const leases = new Map<string, string>();
  const links = new MemoryHouseholdLinks();
  const logger = {
    setContext: vi.fn<AnyMock>(),
    warn: vi.fn<AnyMock>(),
    log: vi.fn<AnyMock>(),
    debug: vi.fn<AnyMock>(),
    error: vi.fn<AnyMock>(),
  };
  const rates = {
    hit: vi.fn((key: string) => {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return Promise.resolve({ count: counts.get(key)!, resetSeconds: 60 });
    }),
    claimUploadStream: vi.fn((key: string, token: string) => {
      if (leases.has(key)) {
        return Promise.resolve(false);
      }
      leases.set(key, token);
      return Promise.resolve(true);
    }),
    releaseUploadStream: vi.fn((key: string, token: string) => {
      if (leases.get(key) === token) {
        leases.delete(key);
      }
      return Promise.resolve();
    }),
  };
  const peer = new HouseholdPeerService(
    links as never,
    { serverName: name, getEnv: () => ({ frameleafCloud: { url: cloud.url, identityDir: directory } }) } as never,
    { withLock: (_lock: unknown, action: () => unknown) => action() } as never,
    {
      get: (key: string) => Promise.resolve(metadata.get(key) ?? null),
      set: (key: string, value: unknown) => Promise.resolve(void metadata.set(key, value)),
    } as never,
    new InstanceIdentityRepository(),
    new FrameleafCloudRepository(LoggingRepository.create()),
    rates as never,
    logger as never,
  );
  const identity = await peer.identity();
  const linkToCloud = () =>
    metadata.set(SystemMetadataKey.FrameleafCloudLink, {
      status: 'linked',
      instanceId: identity.instanceId,
      cloudUrl: cloud.url,
    });
  linkToCloud();
  const host = `${name.toLowerCase()}.household.test`;
  const registered: FakeHouseholdServer = {
    instanceId: identity.instanceId,
    name,
    key: identity.publicJwk,
    licensed: true,
    plan: true,
    home: null,
    remote: `https://${host}`,
    ...registration,
  };
  households.servers.set(ed25519Thumbprint(identity.publicJwk), registered);
  const service = new HouseholdLinkService(links as never, peer, logger as never);
  const world = new ShareWorld();
  const events = {
    emit: vi.fn((name: string, payload: never): Promise<unknown> =>
      name === 'HouseholdFeedComments' ? shares.onComments(payload) : Promise.resolve(),
    ),
  };
  const shares: HouseholdShareService = new HouseholdShareService(
    world as never,
    links as never,
    service,
    peer,
    world.albumUsers as never,
    world.albums as never,
    world.access as never,
    world.users as never,
    world.storage as never,
    rates as never,
    logger as never,
    world.comments as never,
    events as never,
  );
  return {
    name,
    host,
    identity,
    registered,
    metadata,
    linkToCloud,
    links,
    logger,
    rates,
    counts,
    peer,
    service,
    world,
    shares,
    events,
    leases,
    controller: new HouseholdPeerController(peer, shares, logger as never),
    close: () => rm(directory, { recursive: true, force: true }),
  };
};
export type HouseholdServer = Awaited<ReturnType<typeof startHouseholdServer>>;

/** An Express request as the peer controller sees it, for a call made to `url`. */
export const householdRequest = (
  url: string,
  headers: Record<string, string> = {},
  { method = 'GET', address = '203.0.113.10', body }: { method?: string; address?: string; body?: string } = {},
) => {
  const target = new URL(url);
  return {
    // a request is a stream of its body
    [Symbol.asyncIterator]: () => Readable.from(body === undefined ? [] : [Buffer.from(body)])[Symbol.asyncIterator](),
    headers: Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])),
    method,
    protocol: target.protocol.slice(0, -1),
    originalUrl: `${target.pathname}${target.search}`,
    get: () => target.host,
    ip: address,
    socket: {},
  } as unknown as Request;
};

/**
 * Carries peer requests between fixture servers in process: a `fetch` to `https://<host>` listed in `hosts` runs
 * that server's real peer controller (call this once per test), any other `*.test` address fails as an unreachable one does, and everything
 * else (the fake Cloud) is fetched for real. Returns every peer call made, for assertions.
 */
export const connectHouseholds = (hosts: Record<string, HouseholdServer>) => {
  // `hosts` is read at each call, so a spec changes who answers by changing the object
  const real = fetch;
  const calls: Array<{ url: string; status: number | null; redirect: unknown }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!url.hostname.endsWith('.test')) {
      return real(input, init);
    }
    const server = hosts[url.host];
    const [, linkId, route] = /^\/api\/household\/v1\/links\/([^/]+)\/(handshake|directory)$/.exec(url.pathname) ?? [];
    if (!server || !linkId) {
      calls.push({ url: url.href, status: null, redirect: init?.redirect });
      throw new TypeError('fetch failed');
    }
    const request = householdRequest(url.href, init?.headers as Record<string, string>, { method: init?.method });
    try {
      const body = await server.controller[route as 'handshake' | 'directory'](linkId, request, {
        setHeader: vi.fn<AnyMock>(),
      } as never);
      calls.push({ url: url.href, status: 200, redirect: init?.redirect });
      return Response.json(body);
    } catch (error) {
      if (!(error instanceof HttpException)) {
        throw error;
      }
      calls.push({ url: url.href, status: error.getStatus(), redirect: init?.redirect });
      return Response.json(error.getResponse(), { status: error.getStatus() });
    }
  });
  return calls;
};
