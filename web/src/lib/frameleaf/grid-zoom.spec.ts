import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindGridZoom, zoomKeyDirection } from '$lib/frameleaf/grid-zoom';

const key = (init: KeyboardEventInit, target: EventTarget = document.body) => {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
};

// A plain Event carrying exactly the fields the handler reads.
const wheel = (element: HTMLElement, { ctrlKey = false, metaKey = false, deltaY = 0 }: WheelEventInit) => {
  const event = Object.assign(new Event('wheel', { bubbles: true, cancelable: true }), { ctrlKey, metaKey, deltaY });
  element.dispatchEvent(event);
  return event;
};

const touch = (element: HTMLElement, type: string, pointerId: number, x: number) =>
  element.dispatchEvent(
    Object.assign(new MouseEvent(type, { bubbles: true, clientX: x, clientY: 0 }), { pointerId, pointerType: 'touch' }),
  );

describe('zoomKeyDirection', () => {
  it('reads + (and =) as larger and − as smaller', () => {
    expect(zoomKeyDirection(new KeyboardEvent('keydown', { key: '+' }))).toBe(1);
    expect(zoomKeyDirection(new KeyboardEvent('keydown', { key: '=' }))).toBe(1);
    expect(zoomKeyDirection(new KeyboardEvent('keydown', { key: '-' }))).toBe(-1);
    expect(zoomKeyDirection(new KeyboardEvent('keydown', { key: 'a' }))).toBeNull();
  });

  it('never takes ⌘/Ctrl + or −: browser zoom keeps them', () => {
    for (const modifier of ['metaKey', 'ctrlKey', 'altKey'] as const) {
      expect(zoomKeyDirection(new KeyboardEvent('keydown', { key: '+', [modifier]: true }))).toBeNull();
      expect(zoomKeyDirection(new KeyboardEvent('keydown', { key: '-', [modifier]: true }))).toBeNull();
    }
  });
});

describe('bindGridZoom', () => {
  let element: HTMLElement;
  let onZoom: ReturnType<typeof vi.fn<(direction: 1 | -1) => void>>;
  let enabled: boolean;
  let unbind: () => void;

  beforeEach(() => {
    element = document.createElement('div');
    document.body.append(element);
    onZoom = vi.fn<(direction: 1 | -1) => void>();
    enabled = true;
    unbind = bindGridZoom(element, { onZoom, enabled: () => enabled });
  });

  afterEach(() => {
    unbind();
    element.remove();
    document.body.replaceChildren();
  });

  it('steps with + and − and claims the key', () => {
    expect(key({ key: '+' }).defaultPrevented).toBe(true);
    key({ key: '-' });
    expect(onZoom.mock.calls).toEqual([[1], [-1]]);
  });

  it('leaves ⌘/Ctrl + and − to the browser', () => {
    const event = key({ key: '+', ctrlKey: true });
    key({ key: '-', metaKey: true });
    expect(event.defaultPrevented).toBe(false);
    expect(onZoom).not.toHaveBeenCalled();
  });

  it('leaves the keys alone in a field, under an open dialog, or when turned off', () => {
    const input = document.createElement('input');
    document.body.append(input);
    key({ key: '+' }, input);
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.append(dialog);
    key({ key: '+' });
    dialog.remove();
    enabled = false;
    key({ key: '+' });
    expect(onZoom).not.toHaveBeenCalled();
  });

  it('zooms with a trackpad pinch (Ctrl + wheel) once the movement adds up to a step', () => {
    wheel(element, { ctrlKey: true, deltaY: -10 });
    expect(onZoom).not.toHaveBeenCalled();
    wheel(element, { ctrlKey: true, deltaY: -25 });
    expect(onZoom).toHaveBeenCalledWith(1);
    wheel(element, { ctrlKey: true, deltaY: 40 });
    expect(onZoom).toHaveBeenLastCalledWith(-1);
  });

  it('leaves a plain wheel and ⌘ + wheel to the page', () => {
    wheel(element, { deltaY: -100 });
    wheel(element, { metaKey: true, deltaY: -100 });
    expect(onZoom).not.toHaveBeenCalled();
  });

  it('zooms with a two-finger touch pinch: spreading enlarges, pinching shrinks', () => {
    touch(element, 'pointerdown', 1, 100);
    touch(element, 'pointerdown', 2, 200);
    touch(element, 'pointermove', 2, 280);
    expect(onZoom).toHaveBeenLastCalledWith(1);
    touch(element, 'pointermove', 2, 200);
    expect(onZoom).toHaveBeenLastCalledWith(-1);
    touch(element, 'pointerup', 2, 200);
    touch(element, 'pointermove', 1, 0);
    expect(onZoom).toHaveBeenCalledTimes(2);
  });

  it('stops listening once unbound', () => {
    unbind();
    key({ key: '+' });
    wheel(element, { ctrlKey: true, deltaY: -100 });
    expect(onZoom).not.toHaveBeenCalled();
  });
});
