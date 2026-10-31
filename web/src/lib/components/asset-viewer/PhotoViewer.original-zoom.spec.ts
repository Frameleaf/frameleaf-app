import { AssetTypeEnum, DynamicRange } from '@frameleaf/sdk';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  markDevelopPlaybackUnresolved,
  resetPlaybackRevisions,
  setDevelopPlaybackRevision,
} from '$lib/frameleaf/playback-revision.svelte';
import { imageViewingPreference } from '$lib/frameleaf/viewer-preferences';
import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { ocrManager } from '$lib/stores/ocr.svelte';
import { assetFactory } from '@test-data/factories/asset-factory';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { sharedLinkFactory } from '@test-data/factories/shared-link-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import PhotoViewer from './PhotoViewer.svelte';

vi.mock('$lib/managers/cast-manager.svelte', () => ({ castManager: { isCasting: false } }));
vi.mock('$lib/stores/face.svelte', () => ({ faceManager: { data: [] } }));
const callbacks = new Map<Element, ResizeObserverCallback>();
class MeasuredResizeObserver {
  constructor(private callback: ResizeObserverCallback) {}
  observe(target: Element) {
    callbacks.set(target, this.callback);
  }
  unobserve(target: Element) {
    callbacks.delete(target);
  }
  disconnect() {}
}
afterEach(() => {
  cleanup();
  ocrManager.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  callbacks.clear();
  imageViewingPreference.set('auto');
  resetPlaybackRevisions();
  authManager.reset();
});

describe('actual photo wheel original loading', () => {
  it.each([
    'native',
    'raw',
    'unknown',
    'absent-encoding',
    'absent-edit',
    'hdr',
    'sdr',
    'edited',
    'developed',
    'unresolved',
    'shared',
    'download-denied',
    'metadata-hidden',
  ] as const)('wheel zoom keeps the correct pixels: %s', async (mode) => {
    vi.stubGlobal('ResizeObserver', MeasuredResizeObserver);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(700);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1000,
      bottom: 700,
      width: 1000,
      height: 700,
      toJSON() {},
    });
    const asset = assetFactory.build({
      id: 'wheel-image',
      type: AssetTypeEnum.Image,
      width: 800,
      height: 600,
      originalMimeType: 'image/jpeg',
      originalPath: 'example.jpg',
      imageEncoding: { dynamicRange: DynamicRange.Sdr, gainMap: 'none', reconstructionAvailable: false },
    });
    switch (mode) {
      case 'native':
      case 'shared':
      case 'download-denied':
      case 'metadata-hidden': {
        break;
      }
      case 'raw': {
        asset.originalMimeType = 'image/x-nikon-nef';
        asset.originalPath = 'glarus.nef';
        break;
      }
      case 'unknown': {
        asset.imageEncoding!.dynamicRange = DynamicRange.Unknown;
        break;
      }
      case 'absent-encoding': {
        delete asset.imageEncoding;
        break;
      }
      case 'absent-edit': {
        Reflect.deleteProperty(asset, 'isEdited');
        break;
      }
      case 'hdr': {
        asset.imageEncoding!.dynamicRange = DynamicRange.Hdr;
        break;
      }
      case 'edited': {
        asset.isEdited = true;
        break;
      }
      case 'sdr': {
        imageViewingPreference.set('sdr');
        break;
      }
      case 'developed':
      case 'unresolved': {
        authManager.setUser(userAdminFactory.build({ id: asset.ownerId }));
        authManager.setPreferences(preferencesFactory.build());
        if (mode === 'developed') {
          setDevelopPlaybackRevision(asset.id, 'current-develop');
        } else {
          markDevelopPlaybackUnresolved(asset.id);
        }
        break;
      }
    }
    const sharedLink = ['shared', 'download-denied', 'metadata-hidden'].includes(mode)
      ? sharedLinkFactory.build({ allowDownload: mode !== 'download-denied', showMetadata: mode !== 'metadata-hidden' })
      : undefined;
    const view = render(PhotoViewer, { cursor: { current: asset }, sharedLink });
    const thumbnail = await view.findByTestId('thumbnail');
    await fireEvent.load(thumbnail);
    const preview = await view.findByTestId('preview');
    await waitFor(() => expect(preview.getAttribute('src')).toBeTruthy());
    await fireEvent.load(preview);
    expect(assetViewerManager.zoom).toBe(1);
    await fireEvent.wheel(preview, { deltaY: -1, clientX: 500, clientY: 350, bubbles: true });
    await waitFor(() => expect(assetViewerManager.zoom).toBeGreaterThan(1));
    const original = await view.findByTestId('original');
    await waitFor(() => expect(original.getAttribute('src')).toBeTruthy());
    const url = new URL(original.getAttribute('src')!, 'http://x');
    expect(url.pathname).toMatch(/\/thumbnail$/);
    expect(url.searchParams.get('size')).toBe(
      mode === 'download-denied' || mode === 'metadata-hidden' ? 'preview' : 'fullsize',
    );
    expect(url.searchParams.get('dynamicRange')).toBe(mode === 'sdr' ? 'sdr' : 'auto');
    await fireEvent.load(original);
    await waitFor(() => expect(assetViewerManager.imgRef).toBe(original));
  });
});
