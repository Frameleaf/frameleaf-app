import { checkVersionNow, getVersionCheck, ReleaseType } from '@immich/sdk';
import { render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { userAdminFactory } from '@test-data/factories/user-factory';
import en from '../../../../../i18n/en.json';
import AboutDialog from './AboutDialog.svelte';

vi.mock('@immich/sdk', async (original) => ({
  ...(await original<object>()),
  checkVersionNow: vi.fn(),
  getVersionCheck: vi.fn(),
}));

const info = { version: 'v3.2.0', versionUrl: '', licensed: false };

describe('AboutDialog (S-4)', () => {
  beforeAll(() => {
    addMessages('dev', en);
  });

  beforeEach(() => {
    vi.mocked(checkVersionNow).mockReset();
    vi.mocked(getVersionCheck).mockReset();
    HTMLDialogElement.prototype.showModal ??= vi.fn(function (this: HTMLDialogElement) {
      this.open = true;
    });
    HTMLDialogElement.prototype.close ??= vi.fn(function (this: HTMLDialogElement) {
      this.open = false;
    });
  });

  it('shows the prototype facts, attribution and version history, and closes with Done', async () => {
    const onClose = vi.fn();
    render(AboutDialog, {
      onClose,
      info: {
        version: 'v3.2.0',
        versionUrl: '',
        licensed: false,
        build: '1234',
        nodejs: 'v24.21.0',
        libvips: '8.17',
        ffmpeg: '7.1',
        repository: 'frameleaf/frameleaf',
        repositoryUrl: 'https://example.test/repo',
      },
      versions: [{ id: 'a', version: 'v3.2.0', createdAt: '2026-09-01T00:00:00Z' }],
    });

    expect(screen.getByRole('heading', { name: 'About Frameleaf' })).toBeInTheDocument();
    expect(screen.getByText('Node.js v24.21.0')).toBeInTheDocument();
    expect(screen.getByText('libvips 8.17 · FFmpeg 7.1')).toBeInTheDocument();
    expect(screen.getAllByText('AGPL-3.0', { selector: 'a' })).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'Immich' })).toHaveAttribute(
      'href',
      'https://github.com/immich-app/immich',
    );
    expect(screen.getByRole('heading', { name: 'Version History' })).toBeInTheDocument();
    // The upstream grid's "Immich" version row is gone.
    expect(screen.queryByText('Immich', { selector: 'dt' })).not.toBeInTheDocument();

    screen.getByRole('button', { name: 'Done' }).click();
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('checks for updates now for an administrator and links the release notes', async () => {
    authManager.setUser(userAdminFactory.build({ isAdmin: true }));
    vi.mocked(checkVersionNow).mockResolvedValue({
      isAvailable: true,
      checkedAt: new Date().toISOString(),
      serverVersion: { major: 3, minor: 2, patch: 0, prerelease: null },
      releaseVersion: { major: 3, minor: 3, patch: 0, prerelease: null },
      type: ReleaseType.Minor,
    });
    render(AboutDialog, { onClose: vi.fn(), info, versions: [] });

    screen.getByRole('button', { name: 'Check for updates' }).click();

    expect(await screen.findByText(/Frameleaf v3\.3\.0 is available/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Release notes' })).toHaveAttribute(
      'href',
      'https://github.com/Frameleaf/frameleaf-app/releases?q=frameleaf-v3.3.0&expanded=true',
    );
  });

  it("shows another account the server's last check, and a failure plainly", async () => {
    authManager.setUser(userAdminFactory.build({ isAdmin: false }));
    vi.mocked(getVersionCheck).mockResolvedValue({ checkedAt: new Date().toISOString(), releaseVersion: 'v3.2.0' });
    render(AboutDialog, { onClose: vi.fn(), info, versions: [] });

    screen.getByRole('button', { name: 'Check for updates' }).click();
    expect(await screen.findByText(/You're running the latest version/)).toBeInTheDocument();
    expect(checkVersionNow).not.toHaveBeenCalled();

    vi.mocked(getVersionCheck).mockRejectedValue(new Error('offline'));
    screen.getByRole('button', { name: 'Check for updates' }).click();
    expect(await screen.findByText('Update information is unavailable. Try again later.')).toBeInTheDocument();
  });
});
