import { wheelDeltasForZoom, zoomImageAction } from '$lib/actions/zoom-image';

// The zoom library multiplies the zoom by (1 - deltaY * 0.1) for each wheel event, and takes at
// most half a unit from one event.
const play = (from: number, deltas: number[]) => deltas.reduce((zoom, deltaY) => zoom * (1 - deltaY * 0.1), from);

describe('wheelDeltasForZoom', () => {
  it('lands exactly on the target when zooming in', () => {
    const deltas = wheelDeltasForZoom(1, 2);
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.every((deltaY) => deltaY < 0 && deltaY >= -0.5)).toBe(true);
    expect(play(1, deltas)).toBeCloseTo(2, 6);
  });

  it('lands exactly on the target when zooming out', () => {
    const deltas = wheelDeltasForZoom(3.4, 1);
    expect(deltas.every((deltaY) => deltaY > 0 && deltaY <= 0.5)).toBe(true);
    expect(play(3.4, deltas)).toBeCloseTo(1, 6);
  });

  it('takes one step for a small change', () => {
    const deltas = wheelDeltasForZoom(1, 1.02);
    expect(deltas).toHaveLength(1);
    expect(play(1, deltas)).toBeCloseTo(1.02, 6);
  });

  it('asks for nothing when the zoom is already there or the input is not a zoom', () => {
    expect(wheelDeltasForZoom(2, 2)).toEqual([]);
    expect(wheelDeltasForZoom(0, 2)).toEqual([]);
    expect(wheelDeltasForZoom(1, NaN)).toEqual([]);
  });
});

it('allows the next touch gesture after an intercepted gesture is cancelled', () => {
  const node = document.createElement('div');
  const image = document.createElement('img');
  node.append(image);
  document.body.append(node);
  const originalHitTest = Object.getOwnPropertyDescriptor(document, 'elementFromPoint');
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => image });
  const action = zoomImageAction(node);
  const move = vi.fn();
  node.addEventListener('touchmove', move);
  const touch = (type: string, count: number, targetCount = count) => {
    const points = Array.from({ length: count }, (_, identifier) => ({ clientX: 10, clientY: 10, identifier }));
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      touches: { value: points },
      targetTouches: { value: points.slice(0, targetCount) },
    });
    node.dispatchEvent(event);
  };
  try {
    touch('touchstart', 2, 1);
    touch('touchcancel', 0);
    touch('touchmove', 1);
    expect(move).toHaveBeenCalledOnce();
  } finally {
    action.destroy();
    node.remove();
    if (originalHitTest) {
      Object.defineProperty(document, 'elementFromPoint', originalHitTest);
    } else {
      Reflect.deleteProperty(document, 'elementFromPoint');
    }
  }
});
