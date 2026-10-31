import { afterEach, describe, expect, it, vi } from 'vitest';
import { beginDragSelect, DRAG_SELECT_EVENT } from '$lib/components/timeline/drag-select';

const tile = (id: string) => {
  const node = document.createElement('article');
  node.dataset.assetId = id;
  const button = document.createElement('button');
  node.append(button);
  document.body.append(node);
  return { node, button };
};

const move = (target: HTMLElement, x: number, y: number) => {
  const event = new Event('touchmove', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', { value: [{ clientX: x, clientY: y }] });
  target.dispatchEvent(event);
  return event;
};

const under = (element: Element | null) => {
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => element });
};

describe('beginDragSelect', () => {
  afterEach(() => {
    document.body.replaceChildren();
    Reflect.deleteProperty(document, 'elementFromPoint');
  });

  it('tells each tile the finger passes, once, and keeps the page from scrolling', () => {
    const first = tile('a');
    const second = tile('b');
    const heard = vi.fn();
    document.body.addEventListener(DRAG_SELECT_EVENT, (event) => heard((event as CustomEvent).detail.assetId));
    beginDragSelect(first.button, 'a');

    under(second.button);
    const event = move(first.button, 120, 40);
    expect(event.defaultPrevented).toBe(true);
    expect(heard).toHaveBeenCalledExactlyOnceWith('b');

    // Still over the same tile, and back over the one that started it: nothing new.
    move(first.button, 125, 42);
    under(first.button);
    move(first.button, 20, 40);
    expect(heard).toHaveBeenCalledOnce();
  });

  it('ignores a finger that is over no tile', () => {
    const first = tile('a');
    const heard = vi.fn();
    document.body.addEventListener(DRAG_SELECT_EVENT, heard);
    beginDragSelect(first.button, 'a');
    under(document.body);
    move(first.button, 5, 5);
    expect(heard).not.toHaveBeenCalled();
  });

  it('stops when the finger lifts', () => {
    const first = tile('a');
    const second = tile('b');
    const heard = vi.fn();
    document.body.addEventListener(DRAG_SELECT_EVENT, heard);
    beginDragSelect(first.button, 'a');
    first.button.dispatchEvent(new Event('touchend'));
    under(second.button);
    const event = move(first.button, 120, 40);
    expect(heard).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});
