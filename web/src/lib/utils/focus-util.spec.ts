import { focusable, isTabbable, tabbable } from 'tabbable';
import { getTabbable, moveFocus, setDefaultTabbleOptions } from './focus-util';

vi.mock('tabbable', () => ({ focusable: vi.fn(), isTabbable: vi.fn(), tabbable: vi.fn() }));

function buttons(...ids: string[]) {
  const elements = ids.map((id) => {
    const button = document.createElement('button');
    button.id = id;
    document.body.append(button);
    return button;
  });
  vi.mocked(focusable).mockReturnValue(elements);
  return elements;
}

beforeEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
  vi.mocked(focusable).mockReturnValue([]);
  vi.mocked(isTabbable).mockImplementation((element) => (element as HTMLElement).tabIndex >= 0);
  setDefaultTabbleOptions({ includeContainer: false });
});

afterEach(() => document.body.replaceChildren());

describe('focus movement', () => {
  it('ignores an empty document', () => {
    const selector = vi.fn(() => true);
    moveFocus(selector, 'next');
    expect(selector).not.toHaveBeenCalled();
    expect(isTabbable).not.toHaveBeenCalled();
  });

  it.each(['next', 'previous'] as const)('starts at the first matching element for %s', (direction) => {
    const [, matching] = buttons('other', 'matching', 'last');
    moveFocus((element) => element.id === 'matching', direction);
    expect(document.activeElement).toBe(matching);
    expect(isTabbable).not.toHaveBeenCalled();
  });

  it('falls back to the first focusable element when nothing matches on initial focus', () => {
    const [first] = buttons('first', 'second');
    moveFocus(() => false, 'next');
    expect(document.activeElement).toBe(first);
  });

  it('retains programmatic initial focus on a matching negative tabindex', () => {
    const [, matching] = buttons('first', 'matching');
    matching.tabIndex = -1;
    moveFocus((element) => element.id === 'matching', 'next');
    expect(document.activeElement).toBe(matching);
  });

  it.each([
    ['next', 0, 1],
    ['previous', 1, 0],
    ['next', 2, 0],
    ['previous', 0, 2],
  ] as const)('moves %s from %i to %i in DOM order with wraparound', (direction, from, to) => {
    const elements = buttons('first', 'middle', 'last');
    elements[from].focus();
    moveFocus(() => true, direction);
    expect(document.activeElement).toBe(elements[to]);
  });

  it('skips matching candidates that are no longer tabbable', () => {
    const [first, negative, last] = buttons('first', 'negative', 'last');
    negative.tabIndex = -1;
    first.focus();
    moveFocus(() => true, 'next');
    expect(document.activeElement).toBe(last);
  });

  it('retains current focus when no cyclic candidate matches', () => {
    const [first] = buttons('first', 'second');
    first.focus();
    moveFocus(() => false, 'next');
    expect(document.activeElement).toBe(first);
  });

  it('still considers the current element at the end of a full cycle', () => {
    const [first] = buttons('first', 'second');
    const focus = vi.spyOn(first, 'focus');
    first.focus();
    focus.mockClear();
    moveFocus((element) => element.id === 'first', 'next');
    expect(focus).toHaveBeenCalledExactlyOnceWith();
  });

  it('passes only the candidate to the selector in both initial and cyclic searches', () => {
    const [first, second] = buttons('first', 'second');
    const selector = vi.fn(() => true);
    moveFocus(selector, 'next');
    expect(selector).toHaveBeenCalledExactlyOnceWith(first);
    selector.mockClear();
    moveFocus(selector, 'next');
    expect(selector).toHaveBeenCalledExactlyOnceWith(second);
  });

  it('rechecks tabbability only for candidates matching the viewer Escape predicate', () => {
    const elements = buttons('current', ...Array.from({ length: 100 }, (_, index) => `thumb-${index}`), 'exit');
    for (const thumbnail of elements.slice(0, -1)) {
      thumbnail.dataset.thumbnailFocusContainer = '';
    }
    elements[0].focus();
    moveFocus((element) => element.dataset.thumbnailFocusContainer === undefined, 'next');
    expect(document.activeElement).toBe(elements.at(-1));
    expect(isTabbable).toHaveBeenCalledExactlyOnceWith(elements.at(-1));
  });
});

describe('tabbable options', () => {
  it('keeps configured options and overrides includeContainer for each request', () => {
    const container = document.createElement('div');
    const expected = buttons('result');
    vi.mocked(tabbable).mockReturnValue(expected);
    setDefaultTabbleOptions({ displayCheck: 'none', includeContainer: true });
    expect(getTabbable(container)).toBe(expected);
    expect(tabbable).toHaveBeenLastCalledWith(container, { displayCheck: 'none', includeContainer: false });
    expect(getTabbable(container, true)).toBe(expected);
    expect(tabbable).toHaveBeenLastCalledWith(container, { displayCheck: 'none', includeContainer: true });
  });
});
