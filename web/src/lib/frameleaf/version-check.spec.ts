import { checkVersionNow, getVersionCheck, ReleaseType } from '@immich/sdk';
import { checkForUpdates, isNewerVersion, releaseNotesUrl } from '$lib/frameleaf/version-check';

vi.mock('@immich/sdk', async (original) => ({
  ...(await original<object>()),
  checkVersionNow: vi.fn(),
  getVersionCheck: vi.fn(),
}));

describe('version check (FL-80 S-4 / O-8)', () => {
  beforeEach(() => {
    vi.mocked(checkVersionNow).mockReset();
    vi.mocked(getVersionCheck).mockReset();
  });

  it("links a version to Frameleaf's GitHub release notes, never Immich's", () => {
    expect(releaseNotesUrl('v3.2.1')).toBe(
      'https://github.com/Frameleaf/frameleaf-app/releases?q=frameleaf-v3.2.1&expanded=true',
    );
    expect(releaseNotesUrl('3.3.0-rc.1')).toBe(
      'https://github.com/Frameleaf/frameleaf-app/releases?q=frameleaf-v3.3.0-rc.1&expanded=true',
    );
    expect(releaseNotesUrl('v3.2.1')).not.toMatch(/immich/i);
  });

  it.each([
    ['v3.2.1', 'v3.2.0', true],
    ['v3.2.0', 'v3.2.0', false],
    ['v3.1.9', 'v3.2.0', false],
    ['v3.2.0', 'v3.2.0-rc.1', true],
    ['v3.2.0-rc.2', 'v3.2.0-rc.1', true],
    ['v3.2.0-rc.10', 'v3.2.0-rc.9', true],
    ['not a version', 'v3.2.0', undefined],
  ])('isNewerVersion(%s, %s) is %s', (release, running, expected) => {
    expect(isNewerVersion(release, running)).toBe(expected);
  });

  it('asks the server to check now for an administrator', async () => {
    vi.mocked(checkVersionNow).mockResolvedValue({
      isAvailable: true,
      checkedAt: '2026-09-25T12:00:00Z',
      serverVersion: { major: 3, minor: 2, patch: 0, prerelease: null },
      releaseVersion: { major: 3, minor: 3, patch: 0, prerelease: null },
      type: ReleaseType.Minor,
    });

    await expect(checkForUpdates(true, 'v3.2.0')).resolves.toEqual({
      status: 'available',
      version: 'v3.3.0',
      checkedAt: '2026-09-25T12:00:00Z',
    });
    expect(getVersionCheck).not.toHaveBeenCalled();
  });

  it("shows any other account the server's last check", async () => {
    vi.mocked(getVersionCheck).mockResolvedValue({ checkedAt: '2026-09-25T12:00:00Z', releaseVersion: 'v3.2.0' });
    await expect(checkForUpdates(false, 'v3.2.0')).resolves.toEqual({
      status: 'current',
      version: 'v3.2.0',
      checkedAt: '2026-09-25T12:00:00Z',
    });
    expect(checkVersionNow).not.toHaveBeenCalled();

    vi.mocked(getVersionCheck).mockResolvedValue({ checkedAt: null, releaseVersion: null });
    await expect(checkForUpdates(false, 'v3.2.0')).resolves.toEqual({ status: 'unknown' });
  });
});
