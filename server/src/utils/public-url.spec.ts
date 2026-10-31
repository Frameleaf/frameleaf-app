import type { FrameleafRemoteConnection } from 'src/types.js';
import { defaults } from 'src/dtos/config.dto.js';
import { SystemMetadataKey } from 'src/enum.js';
import { resolveShareBaseUrl } from 'src/utils/public-url.js';

/**
 * FL-83 (AL-30b): the address a per-item share hands out. The Public server URL wins; otherwise a
 * known address the request arrived on (the verified custom CNAME), then the custom hostname when
 * "Use my domain" is chosen, then the direct-connection address. The Host header alone is never used.
 */
const CLOUD = 'https://cloud.frameleaf.test';
const DIRECT = 'https://1-2-3-4.lbl.direct.frameleaf.test:2443';
const RELAY = 'https://r.lbl.frameleaf.test';
const CUSTOM = 'photos.example.org';

const candidate = (
  kind: FrameleafRemoteConnection['kind'],
  uri: string,
  flags: Partial<FrameleafRemoteConnection> = {},
): FrameleafRemoteConnection => {
  const url = new URL(uri);
  return {
    kind,
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

const deps = ({ linked = true, candidates = [] as FrameleafRemoteConnection[], relayConnected = true } = {}) => {
  const metadata: Record<string, unknown> = {
    [SystemMetadataKey.FrameleafCloudLink]: linked
      ? { status: 'linked', instanceId: 'instance-1', cloudUrl: CLOUD, services: { publicUrl: RELAY } }
      : null,
    [SystemMetadataKey.FrameleafRemoteAccess]: {
      status: 'ready',
      updatedAt: new Date().toISOString(),
      names: { instanceId: 'instance-1', names: { relay: 'r.lbl.frameleaf.test' } },
      relay: { connected: relayConnected },
      candidates,
    },
  };
  return {
    configRepository: { getEnv: () => ({ frameleafCloud: { url: CLOUD } }) },
    systemMetadataRepository: { get: (key: string) => Promise.resolve(metadata[key] ?? null) },
  } as never;
};

const remote = (overrides: Partial<(typeof defaults)['frameleafCloud']['remoteAccess']> = {}) => ({
  ...defaults.frameleafCloud.remoteAccess,
  enabled: true,
  mode: 'relay-and-direct' as const,
  ...overrides,
});

const published = [
  candidate('local', 'https://192-168-1-2.lbl.frameleaf.test:2283', { local: true }),
  candidate('wan', DIRECT, { verified: true }),
  candidate('wan', `https://${CUSTOM}`, { relay: true, custom: true }),
  candidate('relay', RELAY, { relay: true }),
];
const verifiedCustom = { customHostname: { host: CUSTOM, status: 'verified' as const, checkedAt: null } };

describe('resolveShareBaseUrl (FL-83 AL-30b)', () => {
  it('always uses the Public server URL when the administrator set one', async () => {
    await expect(
      resolveShareBaseUrl(
        { externalDomain: 'https://photos.family.example/' },
        deps({ candidates: published }),
        remote(verifiedCustom),
        `https://${CUSTOM}`,
      ),
    ).resolves.toBe('https://photos.family.example');
  });

  it('otherwise uses the direct-connection address', async () => {
    await expect(
      resolveShareBaseUrl({ externalDomain: '' }, deps({ candidates: published }), remote(verifiedCustom)),
    ).resolves.toBe(DIRECT);
  });

  it('uses a published IPv6 direct address when no WAN mapping or relay is available', async () => {
    const ipv6 = 'https://2001-db8--1.lbl.frameleaf.test:2443';
    await expect(
      resolveShareBaseUrl(
        { externalDomain: '' },
        deps({ candidates: [candidate('ipv6', ipv6, { ipv6: true })], relayConnected: false }),
        remote(),
        'https://attacker.example',
      ),
    ).resolves.toBe(ipv6);
  });

  it('uses the verified custom hostname when "Use my domain" is chosen', async () => {
    await expect(
      resolveShareBaseUrl(
        { externalDomain: '' },
        deps({ candidates: published }),
        remote({ ...verifiedCustom, publicUrl: 'custom' }),
      ),
    ).resolves.toBe(`https://${CUSTOM}`);
  });

  it('keeps a request that arrived through the custom CNAME on that name', async () => {
    await expect(
      resolveShareBaseUrl(
        { externalDomain: '' },
        deps({ candidates: published }),
        remote(verifiedCustom),
        `https://${CUSTOM}`,
      ),
    ).resolves.toBe(`https://${CUSTOM}`);
  });

  it('never builds a link from an unknown Host header', async () => {
    await expect(
      resolveShareBaseUrl(
        { externalDomain: '' },
        deps({ candidates: published }),
        remote(verifiedCustom),
        'https://attacker.example',
      ),
    ).resolves.toBe(DIRECT);
    // an unverified custom hostname is not a known address either
    await expect(
      resolveShareBaseUrl(
        { externalDomain: '' },
        deps({ candidates: published.filter((entry) => !entry.custom) }),
        remote({ customHostname: { host: CUSTOM, status: 'pending', checkedAt: null } }),
        `https://${CUSTOM}`,
      ),
    ).resolves.toBe(DIRECT);
  });

  it('does not accept a custom Host after its relay stops publishing that address', async () => {
    await expect(
      resolveShareBaseUrl(
        { externalDomain: '' },
        deps({ candidates: published.filter((entry) => !entry.custom) }),
        remote(verifiedCustom),
        `https://${CUSTOM}`,
      ),
    ).resolves.toBe(DIRECT);
  });

  it('gives no link when the server has neither a Public server URL nor a Frameleaf Cloud link', async () => {
    await expect(
      resolveShareBaseUrl({ externalDomain: '' }, deps({ linked: false }), remote(), `https://${CUSTOM}`),
    ).resolves.toBeUndefined();
  });
});
