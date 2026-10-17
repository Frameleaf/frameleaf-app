import { longPress } from './long-press';

const pointer = (type: string, x = 0, id = 1, button = 0) => {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, button });
  Object.defineProperty(event, 'pointerId', { value: id });
  return event;
};

describe('longPress', () => {
  let element: HTMLButtonElement;
  let action: ReturnType<typeof longPress>;
  let onLongPress: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    vi.useFakeTimers();
    element = document.createElement('button');
    document.body.append(element);
    onLongPress = vi.fn<() => void>();
    action = longPress(element, { onLongPress });
  });

  afterEach(() => {
    action.destroy();
    element.remove();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not register document listeners while idle', () => {
    action.destroy();
    const listen = vi.spyOn(document, 'addEventListener');
    action = longPress(element, { onLongPress });
    expect(listen).not.toHaveBeenCalled();
    element.dispatchEvent(pointer('pointerdown'));
    expect(listen).toHaveBeenCalled();
  });

  it('keeps the 350 ms threshold and suppresses only the hold click', () => {
    element.dispatchEvent(pointer('pointerdown'));
    vi.advanceTimersByTime(349);
    expect(onLongPress).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onLongPress).toHaveBeenCalledOnce();
    document.dispatchEvent(pointer('pointerup'));
    const heldClick = new MouseEvent('click', { detail: 1, bubbles: true, cancelable: true });
    element.dispatchEvent(heldClick);
    expect(heldClick.defaultPrevented).toBe(true);
    const nextClick = new MouseEvent('click', { detail: 1, cancelable: true });
    element.dispatchEvent(nextClick);
    expect(nextClick.defaultPrevented).toBe(false);
  });

  it('preserves keyboard activation after a hold', () => {
    element.dispatchEvent(pointer('pointerdown'));
    vi.advanceTimersByTime(350);
    document.dispatchEvent(pointer('pointerup'));
    const click = new MouseEvent('click', { detail: 0, cancelable: true });
    element.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
  });

  it.each(['scroll', 'wheel', 'pointerup', 'pointercancel'])('cancels a pending hold on %s', (type) => {
    element.dispatchEvent(pointer('pointerdown'));
    document.dispatchEvent(pointer(type));
    vi.advanceTimersByTime(350);
    expect(onLongPress).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a pending hold when the window loses focus', () => {
    element.dispatchEvent(pointer('pointerdown'));
    dispatchEvent(new Event('blur'));
    vi.advanceTimersByTime(350);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it.each([9, 10])('preserves the 10 px movement threshold at %s px', (x) => {
    element.dispatchEvent(pointer('pointerdown'));
    document.dispatchEvent(pointer('pointermove', x));
    vi.advanceTimersByTime(350);
    expect(onLongPress).toHaveBeenCalledTimes(x === 9 ? 1 : 0);
  });

  it('ignores movement and release of another pointer', () => {
    element.dispatchEvent(pointer('pointerdown'));
    document.dispatchEvent(pointer('pointermove', 100, 2));
    document.dispatchEvent(pointer('pointerup', 100, 2));
    vi.advanceTimersByTime(350);
    expect(onLongPress).toHaveBeenCalledOnce();
  });

  it('restarts a hold without retaining the old timer', () => {
    element.dispatchEvent(pointer('pointerdown'));
    vi.advanceTimersByTime(300);
    element.dispatchEvent(pointer('pointerdown'));
    vi.advanceTimersByTime(349);
    expect(onLongPress).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onLongPress).toHaveBeenCalledOnce();
  });

  it('suppresses the held element context menu and then removes the suppression', () => {
    element.dispatchEvent(pointer('pointerdown'));
    vi.advanceTimersByTime(350);
    const first = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    element.dispatchEvent(first);
    expect(first.defaultPrevented).toBe(true);
    const second = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    element.dispatchEvent(second);
    expect(second.defaultPrevented).toBe(false);
  });

  it('does not turn a secondary-button hold into selection', () => {
    element.dispatchEvent(pointer('pointerdown', 0, 1, 2));
    vi.advanceTimersByTime(350);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('cleans up pending work and element listeners on destruction', () => {
    element.dispatchEvent(pointer('pointerdown'));
    action.destroy();
    vi.advanceTimersByTime(350);
    element.dispatchEvent(pointer('pointerdown'));
    vi.advanceTimersByTime(350);
    expect(onLongPress).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
