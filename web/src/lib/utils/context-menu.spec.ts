import { getContextMenuPositionFromBoundingRect, getContextMenuPositionFromEvent, type Align } from './context-menu';

const alignments: [Align, { x: number; y: number }][] = [
  ['middle', { x: 25, y: 50 }],
  ['top-left', { x: 10, y: 20 }],
  ['top-right', { x: 40, y: 20 }],
  ['bottom-left', { x: 10, y: 80 }],
  ['bottom-right', { x: 40, y: 80 }],
];

const mouse = (options: MouseEventInit = {}) => {
  const event = new MouseEvent('click', options);
  // happy-dom omits the native MouseEvent x/y aliases.
  Object.defineProperties(event, {
    x: { configurable: true, get: () => event.clientX },
    y: { configurable: true, get: () => event.clientY },
  });
  return event;
};

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it.each(alignments)('anchors %s to the requested rectangle point', (align, position) => {
  expect(getContextMenuPositionFromBoundingRect(new DOMRect(10, 20, 30, 60), align)).toEqual(position);
});

it('defaults to the rectangle center without rounding fractional or negative coordinates', () => {
  expect(getContextMenuPositionFromBoundingRect(new DOMRect(-10.5, -20.25, 3.5, 8.5))).toEqual({ x: -8.75, y: -16 });
});

it.each(alignments)('anchors a dispatched event to its current element for %s', (align, position) => {
  const parent = document.createElement('button');
  const child = document.createElement('span');
  parent.append(child);
  vi.spyOn(parent, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 20, 30, 60));
  vi.spyOn(child, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 200, 300, 600));
  let received: unknown;
  parent.addEventListener('click', (event) => (received = getContextMenuPositionFromEvent(event, align)));
  child.dispatchEvent(mouse({ bubbles: true, clientX: 900, clientY: 800 }));
  expect(received).toEqual(position);
});

it('uses the target element after native dispatch has cleared currentTarget', () => {
  const target = document.createElement('button');
  vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 20, 30, 60));
  const event = new KeyboardEvent('keydown', { key: 'Enter' });
  target.dispatchEvent(event);
  expect(event.currentTarget).toBeNull();
  expect(getContextMenuPositionFromEvent(event)).toEqual({ x: 25, y: 50 });
});

it('uses pointer coordinates for an undispatched event', () => {
  expect(getContextMenuPositionFromEvent(mouse({ clientX: -12.5, clientY: 30.25 }))).toEqual({
    x: -12.5,
    y: 30.25,
  });
});

it('uses the origin for a keyboard event without an element', () => {
  expect(getContextMenuPositionFromEvent(new KeyboardEvent('keydown', { key: 'Enter' }))).toEqual({ x: 0, y: 0 });
});

it.each([globalThis, document, new EventTarget()])(
  'uses pointer coordinates when %s cannot supply a rectangle',
  (target) => {
    const event = mouse({ clientX: 17, clientY: 29 });
    target.dispatchEvent(event);
    expect(() => getContextMenuPositionFromEvent(event)).not.toThrow();
    expect(getContextMenuPositionFromEvent(event)).toEqual({ x: 17, y: 29 });
  },
);

it('uses the origin when a non-element keyboard target cannot supply a rectangle', () => {
  const event = new KeyboardEvent('keydown', { key: 'Enter' });
  document.dispatchEvent(event);
  expect(getContextMenuPositionFromEvent(event)).toEqual({ x: 0, y: 0 });
});

it('does not read cursor getters when an element supplies the position', () => {
  const target = document.createElement('button');
  vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 20, 30, 60));
  const event = mouse();
  target.dispatchEvent(event);
  const x = vi.spyOn(event, 'x', 'get');
  const y = vi.spyOn(event, 'y', 'get');
  expect(getContextMenuPositionFromEvent(event)).toEqual({ x: 25, y: 50 });
  expect(x).not.toHaveBeenCalled();
  expect(y).not.toHaveBeenCalled();
});

it('preserves errors from an element measurement instead of swallowing them', () => {
  const target = document.createElement('button');
  const failure = new Error('layout measurement failed');
  vi.spyOn(target, 'getBoundingClientRect').mockImplementation(() => {
    throw failure;
  });
  const event = mouse();
  target.dispatchEvent(event);
  expect(() => getContextMenuPositionFromEvent(event)).toThrow(failure);
});

it.each([null, undefined])('retains the cursor fallback when measurement returns %s', (box) => {
  const target = document.createElement('button');
  vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(box as unknown as DOMRect);
  const event = mouse({ clientX: 17, clientY: 29 });
  target.dispatchEvent(event);
  expect(getContextMenuPositionFromEvent(event)).toEqual({ x: 17, y: 29 });
});
