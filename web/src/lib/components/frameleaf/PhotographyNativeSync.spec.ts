import { getAssetDevelop } from '@frameleaf/sdk';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import en from '$i18n/en.json';
import { syncNativeRecipes, cancelNativeSync } from '$lib/frameleaf/native-sync';
import PhotographyNativeSync from './PhotographyNativeSync.svelte';

vi.mock('@frameleaf/sdk', async (original) => ({
  ...(await original<typeof import('@frameleaf/sdk')>()),
  getAssetDevelop: vi.fn(),
}));
vi.mock('$lib/frameleaf/native-sync', async (original) => ({
  ...(await original<typeof import('$lib/frameleaf/native-sync')>()),
  syncNativeRecipes: vi.fn(),
  cancelNativeSync: vi.fn(),
}));
beforeAll(() => addMessages('dev', en));
it('keeps failures visible and cancels only admitted exact revision jobs from the selected batch', async () => {
  vi.mocked(getAssetDevelop).mockResolvedValue({
    revisions: [{ isCurrent: true, recipe: { version: 2, renderer: 'darktable/5.6.1', exposureEV: 0 } }],
  } as never);
  const admitted = { assetId: 'target', status: 'queued' as const, revisionId: 'exact-revision' };
  const failed = { assetId: 'failed', status: 'failed' as const, error: 'Unsupported camera' };
  vi.mocked(syncNativeRecipes).mockImplementation(async (_ids, _source, _fields, options) => {
    options?.onUpdate?.(admitted);
    options?.onUpdate?.(failed);
    return [admitted, failed];
  });
  vi.mocked(cancelNativeSync).mockResolvedValue([{ ...admitted, status: 'cancelled' }]);
  render(PhotographyNativeSync, {
    photos: ['source', 'target', 'failed'].map((id) => ({
      id,
      fileName: id + '.CR3',
      rating: 4,
      canRate: true,
      stackCount: 1,
      currentRevisionId: null,
    })),
    assetIds: ['source', 'target', 'failed'],
  });
  await fireEvent.change(screen.getByRole('combobox', { name: 'Source photograph' }), { target: { value: 'source' } });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Queue selected photos' })).toBeEnabled());
  await fireEvent.click(screen.getByRole('button', { name: 'Queue selected photos' }));
  await screen.findByText('Unsupported camera');
  expect(vi.mocked(syncNativeRecipes).mock.calls[0][0]).toEqual(['target', 'failed']);
  expect(vi.mocked(syncNativeRecipes).mock.calls[0][2]).not.toContain('masks');
  await fireEvent.click(screen.getByRole('button', { name: 'Cancel batch' }));
  await waitFor(() => expect(cancelNativeSync).toHaveBeenCalledWith([admitted]));
  expect(screen.getByRole('alert')).toHaveTextContent('Unsupported camera');
});
