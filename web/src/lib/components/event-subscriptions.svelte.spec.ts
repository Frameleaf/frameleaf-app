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
  it('does not re-register application listeners when the event bus changes', () => {
    const callback = vi.fn();
    const registration = vi.spyOn(eventManager, 'on');
    const view = render(OnEvents, { onAppNavigate: callback });
    flushSync();
    expect(registration).toHaveBeenCalledTimes(1);
    const removeOther = eventManager.on({ AuthLogout: () => {} });
    try {
      flushSync();
      for (let index = 0; index < 20; index++) {
        eventManager.emit('AppNavigate');
        flushSync();
      }
      expect(callback).toHaveBeenCalledTimes(20);
      expect(registration).toHaveBeenCalledTimes(2);
      removeOther();
      flushSync();
      expect(registration).toHaveBeenCalledTimes(2);
    } finally {
      view.unmount();
      removeOther();
      registration.mockRestore();
    }
  });

  it('does not re-register viewer listeners when zoom or other owners change', () => {
    const callback = vi.fn();
    const registration = vi.spyOn(assetViewerManager, 'on');
    const view = render(AssetViewerEvents, { onZoomChange: callback });
    flushSync();
    expect(registration).toHaveBeenCalledTimes(1);
    const removeOther = assetViewerManager.on({ Copy: () => {} });
    try {
      flushSync();
      for (let index = 0; index < 20; index++) {
        assetViewerManager.emit('ZoomChange', { ...assetViewerManager.zoomState, currentZoom: index + 1 });
        flushSync();
      }
      expect(callback).toHaveBeenCalledTimes(20);
      expect(registration).toHaveBeenCalledTimes(2);
      removeOther();
      flushSync();
      expect(registration).toHaveBeenCalledTimes(2);
    } finally {
      view.unmount();
      removeOther();
      registration.mockRestore();
    }
  });

  it('replaces an application callback while mounted and forwards its payload unchanged', async () => {
    const old = vi.fn();
    const current = vi.fn();
    const view = render(OnEvents, { onAssetsDelete: old });
    flushSync();
    const ids = ['asset-a', 'asset-b'];
    eventManager.emit('AssetsDelete', ids);
    expect(old).toHaveBeenCalledExactlyOnceWith(ids);
    await view.rerender({ onAssetsDelete: current });
    eventManager.emit('AssetsDelete', ids);
    expect(old).toHaveBeenCalledTimes(1);
    expect(current).toHaveBeenCalledExactlyOnceWith(ids);
    expect(current.mock.calls[0][0]).toBe(ids);
    view.unmount();
    eventManager.emit('AssetsDelete', ids);
    expect(current).toHaveBeenCalledTimes(1);
  });

  it('enables and disables application callbacks without removing other owners', async () => {
    const owned = vi.fn();
    const other = vi.fn();
    const removeOther = eventManager.on({ AppNavigate: other });
    const view = render(OnEvents, { onAppNavigate: undefined });
    try {
      await view.rerender({ onAppNavigate: owned });
      eventManager.emit('AppNavigate');
      expect(owned).toHaveBeenCalledTimes(1);
      await view.rerender({ onAppNavigate: undefined });
      eventManager.emit('AppNavigate');
      expect(owned).toHaveBeenCalledTimes(1);
      await view.rerender({ onAppNavigate: owned });
      eventManager.emit('AppNavigate');
      expect(owned).toHaveBeenCalledTimes(2);
      expect(other).toHaveBeenCalledTimes(3);
    } finally {
      view.unmount();
      removeOther();
    }
  });

  it('can add an application event absent from the initial props', async () => {
    const callback = vi.fn();
    const view = render(OnEvents);
    await view.rerender({ onAppNavigate: callback });
    eventManager.emit('AppNavigate');
    expect(callback).toHaveBeenCalledExactlyOnceWith();
    view.unmount();
  });

  it('replaces a viewer callback and forwards its state object unchanged', async () => {
    const old = vi.fn();
    const current = vi.fn();
    const view = render(AssetViewerEvents, { onZoomChange: old });
    flushSync();
    const state = { ...assetViewerManager.zoomState, currentZoom: 2 };
    await view.rerender({ onZoomChange: current });
    assetViewerManager.emit('ZoomChange', state);
    expect(old).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledExactlyOnceWith(state);
    expect(current.mock.calls[0][0]).toBe(state);
    view.unmount();
    assetViewerManager.emit('ZoomChange', state);
    expect(current).toHaveBeenCalledTimes(1);
  });

  it('updates viewer zoom availability when callbacks are enabled and disabled', async () => {
    const zoom = vi.fn();
    assetViewerManager.resetZoomState();
    const controls = render(AssetViewerZoomControls);
    const view = render(AssetViewerEvents, { onZoom: undefined });
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeDisabled();
    await view.rerender({ onZoom: zoom });
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeEnabled();
    assetViewerManager.emit('Zoom');
    expect(zoom).toHaveBeenCalledExactlyOnceWith();
    await view.rerender({ onZoom: undefined });
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeDisabled();
    assetViewerManager.emit('Zoom');
    expect(zoom).toHaveBeenCalledTimes(1);
    await view.rerender({ onZoom: zoom });
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeEnabled();
    view.unmount();
    flushSync();
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeDisabled();
    controls.unmount();
  });

  it('can add a viewer event absent from the initial props', async () => {
    const callback = vi.fn();
    const view = render(AssetViewerEvents);
    await view.rerender({ onCopy: callback });
    assetViewerManager.emit('Copy');
    expect(callback).toHaveBeenCalledExactlyOnceWith();
    view.unmount();
  });

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
