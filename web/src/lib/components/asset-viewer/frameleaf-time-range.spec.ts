import { MediaUIEvents } from 'media-chrome/constants';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import './frameleaf-time-range';

vi.mock('media-chrome/media-time-range', () => ({
  default: class extends HTMLElement {
    keysUsed = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
    connectedCallback() {}
    disconnectedCallback() {}
  },
}));

describe('media scrub lifecycle', () => {
  let range: HTMLElement;
  let received: Array<{ detail: number; bubbles: boolean; composed: boolean }>;
  const seek = (value: number) =>
    range.dispatchEvent(
      new CustomEvent(MediaUIEvents.MEDIA_SEEK_REQUEST, {
        detail: value,
        bubbles: true,
        composed: true,
      }),
    );
  const key = (value = 'ArrowRight') => range.dispatchEvent(new KeyboardEvent('keydown', { key: value }));

  beforeEach(() => {
    vi.useFakeTimers();
    range = document.createElement('frameleaf-time-range');
    received = [];
    range.addEventListener(MediaUIEvents.MEDIA_SEEK_REQUEST, (event) => {
      received.push({
        detail: (event as CustomEvent<number>).detail,
        bubbles: event.bubbles,
        composed: event.composed,
      });
    });
    document.body.append(range);
  });
  afterEach(() => {
    range.remove();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('forwards an idle seek unchanged', () => {
    seek(7);
    expect(received).toEqual([{ detail: 7, bubbles: true, composed: true }]);
  });
  it.each(['pointerup', 'pointercancel'])('coalesces a drag to the latest seek on %s', (event) => {
    range.dispatchEvent(new Event('pointerdown'));
    seek(1);
    seek(2);
    seek(0);
    expect(received).toEqual([]);
    range.dispatchEvent(new Event(event));
    expect(received).toEqual([{ detail: 0, bubbles: true, composed: true }]);
    range.dispatchEvent(new Event(event));
    expect(received).toHaveLength(1);
  });
  it('commits keyboard input after 750 ms with the element as receiver', () => {
    key();
    seek(5);
    vi.advanceTimersByTime(749);
    expect(received).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(received).toEqual([{ detail: 5, bubbles: true, composed: true }]);
    seek(6);
    expect(received.at(-1)?.detail).toBe(6);
  });
  it('resets the keyboard deadline on repeat input', () => {
    key();
    seek(3);
    vi.advanceTimersByTime(500);
    key();
    seek(9);
    vi.advanceTimersByTime(749);
    expect(received).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(received.map((event) => event.detail)).toEqual([9]);
  });
  it('ignores keys not handled by the range', () => {
    key('Tab');
    seek(4);
    expect(received.map((event) => event.detail)).toEqual([4]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels keyboard work on disconnect and starts fresh on reconnect', () => {
    key();
    seek(8);
    range.remove();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(received).toEqual([]);
    document.body.append(range);
    seek(2);
    expect(received.map((event) => event.detail)).toEqual([2]);
  });
  it('drops a pending pointer seek on disconnect', () => {
    range.dispatchEvent(new Event('pointerdown'));
    seek(11);
    range.remove();
    document.body.append(range);
    range.dispatchEvent(new Event('pointerup'));
    expect(received).toEqual([]);
    seek(12);
    expect(received.map((event) => event.detail)).toEqual([12]);
  });

  it('commits when a pointer is released outside the element', () => {
    range.dispatchEvent(new Event('pointerdown'));
    seek(13);
    dispatchEvent(new Event('pointerup'));
    expect(received.map((event) => event.detail)).toEqual([13]);
  });

  it('keeps a pointer drag active when it follows keyboard input', () => {
    key();
    seek(1);
    range.dispatchEvent(new Event('pointerdown'));
    seek(2);
    vi.advanceTimersByTime(1000);
    expect(received).toEqual([]);
    dispatchEvent(new Event('pointercancel'));
    expect(received.map((event) => event.detail)).toEqual([2]);
  });

  it.each(['pointerup', 'pointercancel'])(
    'ignores another pointer %s without losing the active release listener',
    (type) => {
      range.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1 }));
      seek(9);
      dispatchEvent(new PointerEvent(type, { pointerId: 2 }));
      expect(received).toEqual([]);
      dispatchEvent(new PointerEvent(type, { pointerId: 1 }));
      expect(received.map((event) => event.detail)).toEqual([9]);
    },
  );

  it('keeps the initiating pointer when another pointer presses the range', () => {
    range.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1 }));
    seek(9);
    range.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 2 }));
    dispatchEvent(new PointerEvent('pointerup', { pointerId: 2 }));
    expect(received).toEqual([]);
    dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }));
    expect(received.map((event) => event.detail)).toEqual([9]);
  });
});
