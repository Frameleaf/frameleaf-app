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
    expect(screen.getByRole('link', { name: 'example.org/license' })).toHaveAttribute('href', source.licenseUrl);
  });
  it('lists how it was saved, the page, creator, licence, the owner-only image address and when it was added', async () => {
    sdkMock.getAssetSources.mockResolvedValue([{ ...source, note: null, mediaUrl: 'https://cdn.example.org/a.jpg' }]);
    render(AssetSources, { assetId: 'asset', canRead: true, added: '2026-10-27T10:00:00Z' });
    expect(await screen.findByRole('heading', { name: 'Source' })).toBeInTheDocument();
    const facts = Object.fromEntries(
      screen
        .getAllByRole('term')
        .map((term) => [term.textContent?.trim(), term.nextElementSibling?.textContent?.trim()]),
    );
    expect(facts['Saved with']).toBe('Browser extension');
    expect(facts.Page).toContain('Packaging reference');
    expect(facts.Page).toContain('example.org');
    expect(facts.Creator).toBe('A studio');
    expect(facts.Licence).toBe('example.org/license');
    expect(facts.Image).toContain('Only you can see where you saved things from.');
    expect(facts.Added).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Original image address' })).toHaveAttribute(
      'href',
      'https://cdn.example.org/a.jpg',
    );
  });
  it('says an item without a saved source was uploaded', async () => {
    sdkMock.getAssetSources.mockResolvedValue([]);
    render(AssetSources, { assetId: 'asset', canRead: true, added: '2026-10-27T10:00:00Z' });
    expect(await screen.findByText('Upload')).toBeInTheDocument();
    expect(screen.getByText('Added')).toBeInTheDocument();
  });
  it('does not request or reveal private source metadata for other viewers', () => {
    render(AssetSources, { assetId: 'asset', canRead: false, added: '2026-10-27T10:00:00Z' });
    expect(sdkMock.getAssetSources).not.toHaveBeenCalled();
    expect(screen.queryByText('Saved with')).not.toBeInTheDocument();
    expect(screen.getByText('Added')).toBeInTheDocument();
  });
  it('shows nothing to other viewers when the added date is not given', () => {
    render(AssetSources, { assetId: 'asset', canRead: false });
    expect(screen.queryByRole('heading', { name: 'Source' })).not.toBeInTheDocument();
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
