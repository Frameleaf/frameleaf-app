import { fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import Image from '$lib/components/Image.svelte';

vi.mock('$lib/utils/asset-utils', () => ({ isFirefox: true }));
vi.mock('$lib/utils/sw-messaging', () => ({ cancelImageUrl: vi.fn() }));

afterEach(() => vi.restoreAllMocks());

describe('Image Firefox decoding ownership', () => {
  it.each(['resolve', 'reject'] as const)('ignores a replaced image when its decode promise %ss', async (outcome) => {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    vi.spyOn(HTMLImageElement.prototype, 'decode').mockReturnValue(pending);
    const onLoad = vi.fn();
    const { baseElement, rerender } = render(Image, { src: '/first.jpg', onLoad });
    const first = baseElement.querySelector('img')!;
    await fireEvent.load(first);
    await rerender({ src: '/second.jpg' });
    if (outcome === 'resolve') {
      resolve();
    } else {
      reject(new Error('old decode failed'));
    }
    await Promise.resolve();
    await tick();
    expect(onLoad).not.toHaveBeenCalled();
    expect(baseElement.querySelector('img')!.style.visibility).toBe('hidden');
  });

  it('does not accept an old decode when the same URL is used by a new image', async () => {
    let resolve!: () => void;
    vi.spyOn(HTMLImageElement.prototype, 'decode').mockReturnValue(
      new Promise<void>((yes) => {
        resolve = yes;
      }),
    );
    const onLoad = vi.fn();
    const { baseElement, rerender } = render(Image, { src: '/same.jpg', onLoad });
    const first = baseElement.querySelector('img')!;
    await fireEvent.load(first);
    await rerender({ src: '/other.jpg' });
    await rerender({ src: '/same.jpg' });
    resolve();
    await tick();
    expect(baseElement.querySelector('img')).not.toBe(first);
    expect(onLoad).not.toHaveBeenCalled();
  });

  it('retains the current-image decode rejection workaround', async () => {
    vi.spyOn(HTMLImageElement.prototype, 'decode').mockRejectedValue(new Error('decode unavailable'));
    const onLoad = vi.fn();
    const { baseElement } = render(Image, { src: '/current.jpg', onLoad });
    const image = baseElement.querySelector('img')!;
    await fireEvent.load(image);
    await tick();
    expect(onLoad).toHaveBeenCalledOnce();
    expect(image.style.visibility).toBe('');
  });

  it('ignores decoding completed after unmount', async () => {
    let resolve!: () => void;
    vi.spyOn(HTMLImageElement.prototype, 'decode').mockReturnValue(
      new Promise<void>((yes) => {
        resolve = yes;
      }),
    );
    const onLoad = vi.fn();
    const { baseElement, unmount } = render(Image, { src: '/current.jpg', onLoad });
    await fireEvent.load(baseElement.querySelector('img')!);
    unmount();
    resolve();
    await tick();
    expect(onLoad).not.toHaveBeenCalled();
  });
});
