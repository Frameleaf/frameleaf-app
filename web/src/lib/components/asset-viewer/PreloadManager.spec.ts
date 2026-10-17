import type { AssetResponseDto } from '@frameleaf/sdk';
import { PreloadManager } from './PreloadManager.svelte';

const instances = vi.hoisted(() => [] as { start: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }[]);
vi.mock('$lib/utils/adaptive-image-loader.svelte', () => ({
  AdaptiveImageLoader: class {
    start = vi.fn();
    destroy = vi.fn();
    constructor() {
      instances.push(this);
    }
  },
}));
vi.mock('$lib/actions/image-loader.svelte', () => ({ loadImage: vi.fn() }));
vi.mock('$lib/utils', () => ({
  getAssetUrls: () => ({ thumbnail: 'thumb', preview: 'preview', original: 'original' }),
}));
const asset = (id: string) => ({ id }) as AssetResponseDto;

it.each(['next', 'previous'] as const)('owns the reached %s preload until the viewer closes', (direction) => {
  instances.length = 0;
  const manager = new PreloadManager();
  const oldCursor = { current: asset('a'), nextAsset: asset('b'), previousAsset: asset('c') };
  manager.initializePreloads(oldCursor, undefined);
  const reached = instances[direction === 'next' ? 0 : 1];
  manager.cancelBeforeNavigation(direction);
  expect(reached.destroy).not.toHaveBeenCalled();
  manager.updateAfterNavigation(
    oldCursor,
    {
      current: asset(direction === 'next' ? 'b' : 'c'),
      nextAsset: asset('d'),
      previousAsset: asset('e'),
    },
    undefined,
  );
  expect(reached.destroy).not.toHaveBeenCalled();
  manager.destroy();
  for (const loader of instances) {
    expect(loader.destroy).toHaveBeenCalledOnce();
  }
});

it('releases a reached preload on the next navigation and owns its replacement', () => {
  instances.length = 0;
  const manager = new PreloadManager();
  const first = { current: asset('a'), nextAsset: asset('b'), previousAsset: asset('c') };
  const second = { current: asset('b'), nextAsset: asset('d'), previousAsset: asset('a') };
  manager.initializePreloads(first, undefined);
  manager.updateAfterNavigation(first, second, undefined);
  expect(instances[0].destroy).not.toHaveBeenCalled();
  manager.updateAfterNavigation(second, { current: asset('d') }, undefined);
  expect(instances[0].destroy).toHaveBeenCalledOnce();
  expect(instances[2].destroy).not.toHaveBeenCalled();
  manager.destroy();
  for (const loader of instances) {
    expect(loader.destroy).toHaveBeenCalledOnce();
  }
});

it('releases both previous preloads when initialization is repeated', () => {
  instances.length = 0;
  const manager = new PreloadManager();
  manager.initializePreloads({ current: asset('a'), nextAsset: asset('b'), previousAsset: asset('c') }, undefined);
  expect(instances).toHaveLength(2);
  manager.initializePreloads({ current: asset('d'), nextAsset: asset('e') }, undefined);
  expect(instances[0].destroy).toHaveBeenCalledOnce();
  expect(instances[1].destroy).toHaveBeenCalledOnce();
  expect(instances).toHaveLength(3);
  expect(instances[2].start).toHaveBeenCalledOnce();
  manager.destroy();
  expect(instances[2].destroy).toHaveBeenCalledOnce();
});
