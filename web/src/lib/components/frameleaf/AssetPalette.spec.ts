import {
  ColorTolerance,
  PaletteAlgorithmVersion,
  PaletteRepresentative,
  PaletteStatus,
  type AssetPaletteDto,
} from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import AssetPalette from './AssetPalette.svelte';

const access = vi.hoisted(() => ({ changed: undefined as (() => void) | undefined }));
vi.mock('$lib/frameleaf/library-access', () => ({
  onLibraryAccessChange: (callback: () => void) => {
    access.changed = callback;
    return () => {};
  },
}));
const ready: AssetPaletteDto = {
  version: PaletteAlgorithmVersion.$1,
  sourceRevision: 'revision',
  status: PaletteStatus.Ready,
  representative: PaletteRepresentative.Frame,
  hasTransparency: true,
  swatches: [{ hex: '#609060', weight: 0.8, oklab: [0.6, 0.1, 0.05] }],
};

describe('asset palette inspection', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });
  beforeEach(() => {
    vi.resetAllMocks();
    access.changed = undefined;
  });
  it('labels representative frames and lets a swatch become the shared color filter', async () => {
    sdkMock.getAssetPalette.mockResolvedValue(ready);
    const onChoose = vi.fn();
    render(AssetPalette, { assetId: 'asset', onChoose });
    expect(await screen.findByText('Colors from a representative frame')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: /#609060/ }));
    expect(onChoose).toHaveBeenCalledWith({ hex: '#609060', tolerance: ColorTolerance.Normal, minWeight: 0.05 });
  });
  it('keeps pending indexing distinct from unavailable colors and only offers an authorized retry', async () => {
    sdkMock.getAssetPalette.mockResolvedValue({ ...ready, status: PaletteStatus.Pending, swatches: [] });
    const view = render(AssetPalette, { assetId: 'asset' });
    expect(await screen.findByText('Colors are being indexed.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry color indexing' })).not.toBeInTheDocument();
    sdkMock.getAssetPalette.mockResolvedValue({ ...ready, status: PaletteStatus.Failed, swatches: [] });
    await view.rerender({ assetId: 'other', canRetry: true });
    expect(await screen.findByText('Colors could not be indexed.')).toBeInTheDocument();
    sdkMock.retryAssetPalette.mockResolvedValue(undefined as never);
    sdkMock.getAssetPalette.mockResolvedValue({ ...ready, status: PaletteStatus.Pending, swatches: [] });
    await fireEvent.click(screen.getByRole('button', { name: 'Retry color indexing' }));
    expect(sdkMock.retryAssetPalette).toHaveBeenCalledWith({ id: 'other' });
  });
  it('refreshes a pending palette while visible and stops when closed', async () => {
    vi.useFakeTimers();
    try {
      sdkMock.getAssetPalette
        .mockResolvedValueOnce({ ...ready, status: PaletteStatus.Pending, swatches: [] })
        .mockResolvedValue(ready);
      const view = render(AssetPalette, { assetId: 'asset', onChoose: vi.fn() });
      await tick();
      await Promise.resolve();
      await tick();
      expect(sdkMock.getAssetPalette).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(3000);
      await tick();
      expect(sdkMock.getAssetPalette).toHaveBeenCalledTimes(2);
      expect(screen.getByText('#609060')).toBeInTheDocument();
      view.unmount();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(sdkMock.getAssetPalette).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it('clears swatches on access changes and rejects a response prepared before revocation', async () => {
    let resolve!: (value: AssetPaletteDto) => void;
    sdkMock.getAssetPalette.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    sdkMock.getAssetPalette.mockRejectedValue(new Error('revoked'));
    render(AssetPalette, { assetId: 'asset', onChoose: vi.fn() });
    await waitFor(() => expect(sdkMock.getAssetPalette).toHaveBeenCalledOnce());
    access.changed?.();
    resolve(ready);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Colors are unavailable.'));
    expect(screen.queryByRole('button', { name: /#609060/ })).not.toBeInTheDocument();
  });
});
