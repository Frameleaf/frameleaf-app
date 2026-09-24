import { render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '../../../../../i18n/en.json';
import AboutDialog from './AboutDialog.svelte';

describe('AboutDialog (S-4)', () => {
  beforeAll(() => {
    addMessages('dev', en);
  });

  beforeEach(() => {
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
});
