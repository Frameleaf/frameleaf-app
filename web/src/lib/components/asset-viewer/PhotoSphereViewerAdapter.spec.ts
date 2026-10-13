import { render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { writable } from 'svelte/store';
import type { OcrBoundingBox } from '$lib/stores/ocr.svelte';
import PhotoSphereViewerAdapter from './PhotoSphereViewerAdapter.svelte';

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, Set<(event?: unknown) => void>>();
  const markers = { clearMarkers: vi.fn(), addMarker: vi.fn(), updateMarker: vi.fn() };
  const viewer = {
    state: { textureData: { panoData: { croppedWidth: 100, croppedHeight: 50 } } },
    getPlugin: vi.fn(() => markers),
    dataHelper: {
      textureCoordsToSphericalCoords: vi.fn(({ textureX, textureY }: { textureX: number; textureY: number }) => ({
        x: textureX,
        y: textureY,
      })),
      sphericalCoordsToViewerCoords: vi.fn((point: { x: number; y: number }) => point),
    },
    animate: vi.fn(() => ({ cancel: vi.fn() })),
    getZoomLevel: vi.fn(() => 50),
    destroy: vi.fn(),
    addEventListener: vi.fn((type: string, handler: (event?: unknown) => void) => {
      if (!listeners.has(type)) {
        listeners.set(type, new Set());
      }
      listeners.get(type)!.add(handler);
    }),
    removeEventListener: vi.fn((type: string, handler: (event?: unknown) => void) =>
      listeners.get(type)?.delete(handler),
    ),
  };
  return {
    listeners,
    markers,
    viewer,
    resolution: { setResolution: vi.fn() },
    ocr: { showOverlay: true, data: [] as OcrBoundingBox[] },
    manager: { highlightedFaces: [], zoom: 1, clearHighlightedFaces: vi.fn(), hideHiddenPeople: vi.fn() },
  };
});

vi.mock('@photo-sphere-viewer/core', () => ({
  EquirectangularAdapter: class {},
  Viewer: class {
    constructor() {
      return mocks.viewer;
    }
  },
  events: Object.fromEntries(
    ['Ready', 'PositionUpdated', 'SizeUpdated', 'ZoomUpdated', 'Render'].map((name) => [
      name + 'Event',
      { type: name },
    ]),
  ),
}));
vi.mock('@photo-sphere-viewer/markers-plugin', () => ({ MarkersPlugin: class {} }));
vi.mock('@photo-sphere-viewer/resolution-plugin', () => ({ ResolutionPlugin: class {} }));
vi.mock('@photo-sphere-viewer/settings-plugin', () => ({ SettingsPlugin: class {} }));
vi.mock('$lib/stores/ocr.svelte', () => ({ ocrManager: mocks.ocr }));
vi.mock('$lib/managers/asset-viewer-manager.svelte', () => ({ assetViewerManager: mocks.manager }));
vi.mock('$lib/stores/preferences.store', () => ({ alwaysLoadOriginalFile: writable(false) }));
vi.mock('$lib/actions/shortcut', () => ({ shortcuts: () => ({ destroy: vi.fn() }) }));
vi.mock('$lib/components/AssetViewerEvents.svelte', () => ({ default: () => {} }));

const emit = (type: string, event?: unknown) => {
  for (const handler of mocks.listeners.get(type) ?? []) {
    handler(event);
  }
};
const box: OcrBoundingBox = {
  id: 'line',
  assetId: 'asset',
  x1: 0.1,
  y1: 0.1,
  x2: 0.5,
  y2: 0.1,
  x3: 0.5,
  y3: 0.4,
  x4: 0.1,
  y4: 0.4,
  boxScore: 1,
  textScore: 1,
  text: '<script>&',
};

describe('panorama OCR projection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listeners.clear();
    mocks.ocr.data = [box];
    mocks.ocr.showOverlay = true;
    mocks.viewer.state.textureData.panoData = { croppedWidth: 100, croppedHeight: 50 };
  });

  const mount = async () => {
    const component = render(PhotoSphereViewerAdapter, { panorama: 'preview' });
    await tick();
    emit('Ready');
    mocks.markers.updateMarker.mockClear();
    mocks.markers.addMarker.mockClear();
    return component;
  };

  it('coalesces pan, zoom and resize updates until the next viewer render', async () => {
    await mount();
    emit('PositionUpdated');
    emit('ZoomUpdated', { zoomLevel: 50 });
    emit('SizeUpdated');
    expect(mocks.markers.updateMarker).not.toHaveBeenCalled();
    emit('Render');
    expect(mocks.markers.updateMarker).toHaveBeenCalledTimes(1);
    emit('Render');
    expect(mocks.markers.updateMarker).toHaveBeenCalledTimes(1);
  });

  it('uses current texture dimensions and OCR data at render time', async () => {
    await mount();
    emit('PositionUpdated');
    mocks.viewer.state.textureData.panoData = { croppedWidth: 200, croppedHeight: 100 };
    mocks.ocr.data = [{ ...box, text: 'corrected<&' }];
    emit('Render');
    expect(mocks.markers.updateMarker).toHaveBeenCalledWith(
      expect.objectContaining({
        polygonPixels: [
          [20, 10],
          [100, 10],
          [100, 40],
          [20, 40],
        ],
        tooltip: { content: expect.stringContaining('corrected&lt;&amp;') },
      }),
    );
  });

  it('refreshes ready markers immediately without making idle renders update OCR', async () => {
    await mount();
    emit('Ready');
    expect(mocks.markers.addMarker).toHaveBeenCalledTimes(1);
    emit('Render');
    expect(mocks.markers.updateMarker).not.toHaveBeenCalled();
  });

  it('clears markers when the overlay is hidden before a pending render', async () => {
    await mount();
    mocks.markers.clearMarkers.mockClear();
    emit('PositionUpdated');
    mocks.ocr.showOverlay = false;
    emit('Render');
    expect(mocks.markers.clearMarkers).toHaveBeenCalledTimes(1);
    expect(mocks.markers.updateMarker).not.toHaveBeenCalled();
  });

  it('removes the render listener and destroys the viewer on unmount', async () => {
    const component = await mount();
    emit('PositionUpdated');
    component.unmount();
    emit('Render');
    expect(mocks.markers.updateMarker).not.toHaveBeenCalled();
    expect(mocks.listeners.get('Render')?.size ?? 0).toBe(0);
    expect(mocks.viewer.destroy).toHaveBeenCalledTimes(1);
    expect(mocks.manager.clearHighlightedFaces).toHaveBeenCalledTimes(1);
    expect(mocks.manager.hideHiddenPeople).toHaveBeenCalledTimes(1);
    expect(mocks.manager.zoom).toBe(1);
  });
});
