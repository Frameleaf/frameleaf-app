import { render, screen } from '@testing-library/svelte';
import type { ZoomImageWheelState } from '@zoom-image/core';
import { flushSync } from 'svelte';
import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import AssetViewerZoomControls from '../../test-data/components/AssetViewerZoomControls.svelte';
import AssetViewerEvents from './AssetViewerEvents.svelte';
import OnEvents from './OnEvents.svelte';

vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: { params: {} } }));
vi.mock('$lib/utils/asset-utils', () => ({ canCopyImageToClipboard: () => false }));

describe('component event subscriptions', () => {
  it('registers OnEvents on mount and removes only its listeners on unmount', () => {
    let firstCalls = 0;
    let secondCalls = 0;
    const first = render(OnEvents, { onAppNavigate: () => firstCalls++ });
    const second = render(OnEvents, { onAppNavigate: () => secondCalls++ });
    flushSync();
    eventManager.emit('AppNavigate');
    expect([firstCalls, secondCalls]).toEqual([1, 1]);
    first.unmount();
    eventManager.emit('AppNavigate');
    expect([firstCalls, secondCalls]).toEqual([1, 2]);
    second.unmount();
    eventManager.emit('AppNavigate');
    expect([firstCalls, secondCalls]).toEqual([1, 2]);
  });

  it('enables viewer zoom through mounted listeners and cleans up ZoomChange callbacks', () => {
    const values: number[] = [];
    assetViewerManager.resetZoomState();
    const controls = render(AssetViewerZoomControls);
    expect(assetViewerManager.canZoomIn()).toBe(false);
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeDisabled();
    const view = render(AssetViewerEvents, {
      onZoom: () => {
        assetViewerManager.zoom = 2;
      },
      onZoomChange: (state: ZoomImageWheelState) => {
        values.push(state.currentZoom);
      },
    });
    flushSync();
    expect(assetViewerManager.canZoomIn()).toBe(true);
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeEnabled();
    assetViewerManager.emit('Zoom');
    flushSync();
    expect(values).toEqual([2]);
    expect(assetViewerManager.canZoomIn()).toBe(false);
    expect(assetViewerManager.canZoomOut()).toBe(true);
    expect(screen.getByRole('button', { name: 'Zoom out' })).toBeEnabled();
    view.unmount();
    flushSync();
    expect(assetViewerManager.canZoomOut()).toBe(false);
    expect(screen.getByRole('button', { name: 'Zoom out' })).toBeDisabled();
    assetViewerManager.zoom = 1;
    expect(values).toEqual([2]);
    controls.unmount();
  });
});
