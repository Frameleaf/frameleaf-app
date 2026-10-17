import { afterEach, describe, expect, it, vi } from 'vitest';
import { clickOutside } from '$lib/actions/click-outside';
import { focusOutside } from '$lib/actions/focus-outside';

const cleanups: (() => void)[] = [];
const container = () => {
  const node = document.createElement('div');
  node.innerHTML = '<button>Inside</button>';
  document.body.append(node);
  cleanups.push(() => node.remove());
  return node;
};
const click = (node: EventTarget) => node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
const press = (node: HTMLElement, options: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, ...options });
  node.dispatchEvent(event);
  return event;
};
const leave = (node: HTMLElement, relatedTarget: EventTarget | null) => {
  const event = new FocusEvent('focusout', { bubbles: true, relatedTarget });
  node.dispatchEvent(event);
  return event;
};

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    cleanup();
  }
  vi.restoreAllMocks();
});

describe('outside click callbacks', () => {
  it('ignores descendants and invokes the callback for an outside mousedown', () => {
    const node = container();
    const outside = vi.fn();
    const action = clickOutside(node, { onOutclick: outside });
    cleanups.push(() => action.destroy?.());
    click(node.firstChild!);
    expect(outside).not.toHaveBeenCalled();
    click(document.body);
    expect(outside).toHaveBeenCalledExactlyOnceWith();
  });

  it('consumes plain Escape while preserving other keys and modifiers', () => {
    const node = container();
    const escape = vi.fn();
    const parent = vi.fn();
    document.body.addEventListener('keydown', parent);
    cleanups.push(() => document.body.removeEventListener('keydown', parent));
    const action = clickOutside(node, { onEscape: escape });
    cleanups.push(() => action.destroy?.());
    for (const options of [
      { key: 'Enter' },
      { shiftKey: true },
      { ctrlKey: true },
      { altKey: true },
      { metaKey: true },
    ]) {
      press(node, options);
    }
    expect(escape).not.toHaveBeenCalled();
    expect(parent).toHaveBeenCalledTimes(5);
    press(node);
    expect(escape).toHaveBeenCalledExactlyOnceWith();
    expect(parent).toHaveBeenCalledTimes(5);
  });

  it('leaves Escape propagation intact when no callback is supplied', () => {
    const node = container();
    const parent = vi.fn();
    document.body.addEventListener('keydown', parent);
    cleanups.push(() => document.body.removeEventListener('keydown', parent));
    const action = clickOutside(node);
    cleanups.push(() => action.destroy?.());
    press(node);
    expect(parent).toHaveBeenCalledOnce();
  });

  it('retains same-node listeners after another listener stops bubbling', () => {
    const node = container();
    const callback = vi.fn();
    node.addEventListener('keydown', (event) => event.stopPropagation());
    const action = clickOutside(node, { onEscape: callback });
    cleanups.push(() => action.destroy?.());
    press(node);
    expect(callback).toHaveBeenCalledExactlyOnceWith();
  });

  it('uses replacement callbacks without registering more listeners', () => {
    const node = container();
    const old = vi.fn();
    const current = vi.fn();
    const addDocument = vi.spyOn(document, 'addEventListener');
    const addNode = vi.spyOn(node, 'addEventListener');
    const action = clickOutside(node, { onOutclick: old, onEscape: old });
    cleanups.push(() => action.destroy?.());
    const installed = [addDocument.mock.calls.length, addNode.mock.calls.length];
    action.update?.({ onOutclick: current, onEscape: current });
    click(document.body);
    press(node);
    expect(old).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledTimes(2);
    expect([addDocument.mock.calls.length, addNode.mock.calls.length]).toEqual(installed);
  });

  it('enables callbacks on an initially empty action and later disables them', () => {
    const node = container();
    const callback = vi.fn();
    const action = clickOutside(node);
    cleanups.push(() => action.destroy?.());
    action.update?.({ onOutclick: callback, onEscape: callback });
    click(document.body);
    press(node);
    expect(callback).toHaveBeenCalledTimes(2);
    action.update?.({});
    click(document.body);
    press(node);
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it('destroys only its own document and key listeners', () => {
    const first = container();
    const second = container();
    const stopped = vi.fn();
    const active = vi.fn();
    const old = clickOutside(first, { onOutclick: stopped, onEscape: stopped });
    const current = clickOutside(second, { onOutclick: active });
    cleanups.push(() => current.destroy?.());
    old.destroy?.();
    old.destroy?.();
    click(document.body);
    press(first);
    expect(stopped).not.toHaveBeenCalled();
    expect(active).toHaveBeenCalledExactlyOnceWith();
  });
});

describe('outside focus callbacks', () => {
  it('ignores focus moves within the container', () => {
    const node = container();
    const callback = vi.fn();
    const action = focusOutside(node, { onFocusOut: callback });
    cleanups.push(action.destroy);
    leave(node, node.firstChild);
    expect(callback).not.toHaveBeenCalled();
  });

  it('forwards the original event for an outside or unknown destination', () => {
    const node = container();
    const callback = vi.fn();
    const action = focusOutside(node, { onFocusOut: callback });
    cleanups.push(action.destroy);
    const outside = leave(node, document.body);
    const unknown = leave(node, null);
    expect(callback.mock.calls).toEqual([[outside], [unknown]]);
  });

  it('retains the guard for a non-node focus destination', () => {
    const node = container();
    const callback = vi.fn();
    const action = focusOutside(node, { onFocusOut: callback });
    cleanups.push(action.destroy);
    leave(node, new EventTarget());
    expect(callback).not.toHaveBeenCalled();
  });

  it('updates the callback without replacing its listener', () => {
    const node = container();
    const old = vi.fn();
    const current = vi.fn();
    const add = vi.spyOn(node, 'addEventListener');
    const action = focusOutside(node, { onFocusOut: old });
    cleanups.push(action.destroy);
    const installed = add.mock.calls.length;
    action.update?.({ onFocusOut: current });
    const event = leave(node, document.body);
    expect(old).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledExactlyOnceWith(event);
    expect(add).toHaveBeenCalledTimes(installed);
  });

  it('enables and disables callbacks without changing the action owner', () => {
    const node = container();
    const callback = vi.fn();
    const action = focusOutside(node);
    cleanups.push(action.destroy);
    action.update?.({ onFocusOut: callback });
    leave(node, null);
    expect(callback).toHaveBeenCalledOnce();
    action.update?.({});
    leave(node, document.body);
    expect(callback).toHaveBeenCalledOnce();
  });

  it('stops callbacks after repeated destruction', () => {
    const node = container();
    const callback = vi.fn();
    const action = focusOutside(node, { onFocusOut: callback });
    action.destroy();
    action.destroy();
    leave(node, document.body);
    expect(callback).not.toHaveBeenCalled();
  });
});
