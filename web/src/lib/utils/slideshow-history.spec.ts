import { SlideshowHistory } from '$lib/utils/slideshow-history';

describe('SlideshowHistory', () => {
  it('refuses both directions until an asset is queued', () => {
    const seen: { id: string }[] = [];
    const history = new SlideshowHistory((asset) => {
      seen.push(asset);
    });
    expect(history.next()).toBe(false);
    expect(history.next()).toBe(false);
    expect(history.previous()).toBe(false);
    expect(seen).toEqual([]);
    history.queue({ id: 'first' });
    expect(history.next()).toBe(false);
    expect(history.previous()).toBe(false);
  });

  it('does not navigate stale assets after reset', () => {
    const seen: { id: string }[] = [];
    const history = new SlideshowHistory((asset) => {
      seen.push(asset);
    });
    history.queue({ id: 'old-first' });
    history.queue({ id: 'old-last' });
    history.reset();
    expect(history.next()).toBe(false);
    expect(history.previous()).toBe(false);
    history.queue({ id: 'new-first' });
    expect(history.previous()).toBe(false);
    expect(history.next()).toBe(false);
    expect(seen).toEqual([]);
  });

  it('keeps queue order and original objects when queuing while viewing an earlier asset', () => {
    const seen: { id: string }[] = [];
    const history = new SlideshowHistory((asset) => {
      seen.push(asset);
    });
    const first = Object.freeze({ id: 'first' });
    const second = Object.freeze({ id: 'second' });
    const third = Object.freeze({ id: 'third' });
    history.queue(first);
    history.queue(second);
    expect(history.next()).toBe(false);
    expect(history.previous()).toBe(true);
    history.queue(third);
    expect(history.previous()).toBe(false);
    expect(history.next()).toBe(true);
    expect(history.next()).toBe(true);
    expect(history.next()).toBe(false);
    expect(history.previous()).toBe(true);
    expect(seen).toEqual([first, second, third, second]);
    expect(seen[0]).toBe(first);
    expect(seen[1]).toBe(second);
    expect(seen[2]).toBe(third);
  });

  it('retains its new position when the navigation callback throws', () => {
    const seen: { id: string }[] = [];
    let fail = true;
    const history = new SlideshowHistory((asset) => {
      seen.push(asset);
      if (fail) {
        fail = false;
        throw new Error('navigation failed');
      }
    });
    const first = { id: 'first' };
    const second = { id: 'second' };
    history.queue(first);
    history.queue(second);
    expect(() => history.previous()).toThrow('navigation failed');
    expect(history.previous()).toBe(false);
    expect(history.next()).toBe(true);
    expect(seen).toEqual([first, second]);
  });
});
