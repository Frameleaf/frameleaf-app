import { afterEach, describe, expect, it, vi } from 'vitest';
import { canRevealNearby, createNearbyReveal } from './reveal-near';

type Observed = { callback: IntersectionObserverCallback; options?: IntersectionObserverInit };

const stubObserver = () => {
  const created: Observed[] = [];
  const observe = vi.fn();
  const unobserve = vi.fn();
  const disconnect = vi.fn();
  vi.stubGlobal(
    'IntersectionObserver',
    vi.fn(function (callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      created.push({ callback, options });
      return { observe, unobserve, disconnect };
    }),
  );
  return { created, observe, unobserve, disconnect };
};

const intersect = (observed: Observed, target: Element, isIntersecting: boolean) =>
  observed.callback([{ target, isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver);

describe(createNearbyReveal.name, () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shares one observer between every element, measured against the scroller', () => {
    const { created, observe } = stubObserver();
    const scroller = document.createElement('div');
    scroller.style.overflowY = 'auto';
    const first = document.createElement('div');
    const second = document.createElement('div');
    scroller.append(first, second);
    document.body.append(scroller);

    const { watch } = createNearbyReveal(vi.fn());
    watch(first, 'first');
    watch(second, 'second');

    expect(created).toHaveLength(1);
    expect(created[0].options).toEqual({ root: scroller, rootMargin: '600px 0px' });
    expect(observe).toHaveBeenCalledTimes(2);
    scroller.remove();
  });

  it('reports an element once when it nears the view, and stops watching it', () => {
    const { created, unobserve } = stubObserver();
    const element = document.createElement('div');
    const onNear = vi.fn();
    createNearbyReveal(onNear).watch(element, 'album');

    intersect(created[0], element, false);
    expect(onNear).not.toHaveBeenCalled();

    intersect(created[0], element, true);
    expect(onNear).toHaveBeenCalledExactlyOnceWith('album');
    expect(unobserve).toHaveBeenCalledWith(element);
  });

  it('says so where there is no IntersectionObserver, and watches nothing', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    expect(canRevealNearby()).toBe(false);
    expect(createNearbyReveal(vi.fn()).watch(document.createElement('div'), 'album')).toBeUndefined();

    stubObserver();
    expect(canRevealNearby()).toBe(true);
  });

  it('stops watching an element that leaves the page', () => {
    const { unobserve } = stubObserver();
    const element = document.createElement('div');
    const handle = createNearbyReveal(vi.fn()).watch(element, 'album');
    handle?.destroy?.();
    expect(unobserve).toHaveBeenCalledWith(element);
  });
});
