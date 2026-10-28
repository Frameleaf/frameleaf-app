import { render, screen, waitFor } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import AssetSources from './AssetSources.svelte';

const access = vi.hoisted(() => ({ changed: undefined as (() => void) | undefined }));
vi.mock('$lib/frameleaf/library-access', () => ({
  onLibraryAccessChange: (callback: () => void) => {
    access.changed = callback;
    return () => {};
  },
}));
const source = {
  id: 'source',
  assetId: 'asset',
  captureId: 'capture',
  pageUrl: 'https://example.org/reference',
  title: 'Packaging reference',
  creator: 'A studio',
  licenseUrl: 'https://example.org/license',
  capturedAt: '2026-10-28T10:00:00Z',
  createdAt: '2026-10-28T10:00:00Z',
  note: '<script>private</script>',
};

describe('private asset sources', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });
  beforeEach(() => {
    vi.resetAllMocks();
    access.changed = undefined;
  });
  it('shows saved attribution as text and safe links without fetching the original site', async () => {
    sdkMock.getAssetSources.mockResolvedValue([source]);
    const view = render(AssetSources, { assetId: 'asset', canRead: true });
    expect(await screen.findByText('<script>private</script>')).toBeInTheDocument();
    expect(view.container.querySelector('script')).toBeNull();
    expect(screen.getByRole('link', { name: 'Packaging reference' })).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText('A studio')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'License' })).toHaveAttribute('href', source.licenseUrl);
  });
  it('does not request or reveal private source metadata for other viewers', () => {
    render(AssetSources, { assetId: 'asset', canRead: false });
    expect(sdkMock.getAssetSources).not.toHaveBeenCalled();
    expect(screen.queryByRole('heading', { name: 'Sources' })).not.toBeInTheDocument();
  });
  it('clears private notes when access changes, including an in-flight response', async () => {
    let resolve!: (value: (typeof source)[]) => void;
    sdkMock.getAssetSources.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    sdkMock.getAssetSources.mockRejectedValue(new Error('revoked'));
    render(AssetSources, { assetId: 'asset', canRead: true });
    await waitFor(() => expect(sdkMock.getAssetSources).toHaveBeenCalledOnce());
    access.changed?.();
    resolve([source]);
    expect(await screen.findByText('Sources are unavailable.')).toBeInTheDocument();
    expect(screen.queryByText('<script>private</script>')).not.toBeInTheDocument();
  });
});
