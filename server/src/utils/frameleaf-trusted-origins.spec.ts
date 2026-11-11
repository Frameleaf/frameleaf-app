import { describe, expect, it } from 'vitest';
import { SystemMetadataKey } from 'src/enum.js';
import { frameleafTrustedOrigins } from 'src/utils/frameleaf-trusted-origins.js';

const settings = { frameleafCloud: { remoteAccess: { customHostname: { host: '', status: 'pending' } } } } as never;
const deps = (cloudUrl: string, link: object) => ({
  configRepository: { getEnv: () => ({ frameleafCloud: { url: cloudUrl } }) } as never,
  systemMetadataRepository: {
    get: (key: SystemMetadataKey) => Promise.resolve(key === SystemMetadataKey.FrameleafCloudLink ? link : null),
  } as never,
});
const link = {
  status: 'linked',
  instanceId: 'instance-1',
  cloudUrl: 'https://api.frameleaf.cloud',
  services: { relayOrigin: 'https://r.abc.frameleaf.net', publicUrl: 'https://p.abc.frameleaf.net' },
};

describe('frameleafTrustedOrigins', () => {
  it('trusts the addresses Frameleaf Cloud published for the current link', async () => {
    await expect(frameleafTrustedOrigins(deps('https://api.frameleaf.cloud', link), settings)).resolves.toEqual([
      'https://p.abc.frameleaf.net',
      'https://r.abc.frameleaf.net',
    ]);
  });

  it('trusts nothing from a link to another Cloud or one that is no longer linked', async () => {
    await expect(frameleafTrustedOrigins(deps('https://other.example', link), settings)).resolves.toEqual([]);
    await expect(
      frameleafTrustedOrigins(deps('https://api.frameleaf.cloud', { ...link, status: 'unlinked' }), settings),
    ).resolves.toEqual([]);
  });
});
