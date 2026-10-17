import { describe, expect, it, vi } from 'vitest';
import type { FrameleafLicense, FrameleafLicenseClaims } from 'src/types.js';
import { getSupporters } from 'src/utils/supporter.js';

const now = Math.floor(Date.now() / 1000);

/** A stored licence certificate; only the claims matter to its state. */
const license = (claims: Partial<FrameleafLicenseClaims>): FrameleafLicense => ({
  certificate: 'x.y.z',
  kind: claims.lic ? 'server' : 'plan',
  source: 'account',
  kid: 'kid-1',
  claims: {
    iss: 'https://id.cloud.test',
    aud: 'frameleaf-server',
    sub: 'account-1',
    iid: 'instance-1',
    ent: [],
    lic_exp: null,
    iat: now,
    exp: now + 7 * 86_400,
    ...claims,
  },
  verifiedAt: new Date(now * 1000).toISOString(),
});

const repositories = (
  store: { key: FrameleafLicense | null; plan: FrameleafLicense | null } | null,
  keys: string[],
) => ({
  systemMetadataRepository: { get: vi.fn().mockResolvedValue(store) },
  frameleafUserLicenseRepository: { getUserIds: vi.fn().mockResolvedValue(keys) },
});

describe(getSupporters.name, () => {
  it('marks only the people who hold their own Individual licence on an unlicensed server', async () => {
    const repos = repositories(null, ['user-a']);

    const isSupporter = await getSupporters(repos, ['user-a', 'user-b', 'user-a']);

    expect(isSupporter('user-a')).toBe(true);
    expect(isSupporter('user-b')).toBe(false);
    expect(repos.frameleafUserLicenseRepository.getUserIds).toHaveBeenCalledWith(['user-a', 'user-b']);
  });

  it('marks everyone while the server holds an active Server licence', async () => {
    const repos = repositories(
      { key: license({ lic: { kind: 'server' }, ent: ['SUPPORTER_SERVER'] }), plan: null },
      [],
    );

    const isSupporter = await getSupporters(repos, ['user-b']);

    expect(isSupporter('user-b')).toBe(true);
    expect(repos.frameleafUserLicenseRepository.getUserIds).not.toHaveBeenCalled();
  });

  it('does not count an expired Server licence', async () => {
    const expired = license({
      lic: { kind: 'server' },
      ent: ['SUPPORTER_SERVER'],
      lic_exp: now - 30 * 86_400,
      grace_days: 7,
      iat: now - 31 * 86_400,
      exp: now - 24 * 86_400,
    });

    const isSupporter = await getSupporters(repositories({ key: expired, plan: null }, []), ['user-b']);

    expect(isSupporter('user-b')).toBe(false);
  });
});
