import {
  captureHoldover,
  fadeAway,
  SWIPE_RUBBER_BAND,
  ViewerSwipe,
  type SwipeOrder,
} from '$lib/components/asset-viewer/viewer-motion';

const setup = (neighbours: SwipeOrder[] = ['previous', 'next']) => {
  let time = 0;
  const handlers = {
    canGo: vi.fn((order: SwipeOrder) => neighbours.includes(order)),
    onEngage: vi.fn(),
    onDrag: vi.fn(),
    onRelease: vi.fn(),
    onCommit: vi.fn(),
  };
  const swipe = new ViewerSwipe(handlers, () => time);
  return { swipe, handlers, tick: (ms: number) => (time += ms) };
};

describe('ViewerSwipe', () => {
  it('follows a sideways drag and moves on past a quarter of the width', () => {
    const { swipe, handlers, tick } = setup();
    swipe.start(1, 300, 200, 400);
    tick(100);
    expect(swipe.move(1, 296, 200)).toBe(false);
    expect(handlers.onDrag).not.toHaveBeenCalled();
    tick(100);
    expect(swipe.move(1, 180, 204)).toBe(true);
    expect(handlers.onEngage).toHaveBeenCalledOnce();
    expect(handlers.onDrag).toHaveBeenLastCalledWith(-120);
    tick(400);
    swipe.end(1, 180);
    expect(handlers.onCommit).toHaveBeenCalledExactlyOnceWith('next');
    expect(handlers.onRelease).not.toHaveBeenCalled();
  });

  it('springs back from a short, slow drag', () => {
    const { swipe, handlers, tick } = setup();
    swipe.start(1, 100, 100, 400);
    tick(500);
    swipe.move(1, 140, 100);
    tick(500);
    swipe.end(1, 140);
    expect(handlers.onCommit).not.toHaveBeenCalled();
    expect(handlers.onRelease).toHaveBeenCalledOnce();
  });

  it('moves on from a short flick', () => {
    const { swipe, handlers, tick } = setup();
    swipe.start(1, 100, 100, 400);
    tick(16);
    swipe.move(1, 120, 100);
    tick(16);
    swipe.move(1, 150, 100);
    swipe.end(1, 150);
    expect(handlers.onCommit).toHaveBeenCalledExactlyOnceWith('previous');
  });

  it('rubber-bands and never moves on where there is no neighbour', () => {
    const { swipe, handlers, tick } = setup(['previous']);
    swipe.start(1, 300, 100, 400);
    tick(100);
    swipe.move(1, 100, 100);
    expect(handlers.onDrag).toHaveBeenLastCalledWith(-200 * SWIPE_RUBBER_BAND);
    swipe.end(1, 100);
    expect(handlers.onCommit).not.toHaveBeenCalled();
    expect(handlers.onRelease).toHaveBeenCalledOnce();
  });

  it('leaves a mostly vertical drag to the drag-to-close gesture', () => {
    const { swipe, handlers } = setup();
    swipe.start(1, 100, 100, 400);
    expect(swipe.move(1, 112, 160)).toBe(false);
    swipe.end(1, 112);
    expect(handlers.onEngage).not.toHaveBeenCalled();
    expect(handlers.onRelease).not.toHaveBeenCalled();
  });

  it('ignores other pointers, and a second pointer down ends it', () => {
    const { swipe, handlers } = setup();
    swipe.start(1, 100, 100, 400);
    expect(swipe.move(2, 300, 100)).toBe(false);
    swipe.move(1, 160, 100);
    swipe.start(2, 10, 10, 400);
    expect(swipe.active).toBe(false);
    expect(handlers.onRelease).toHaveBeenCalledOnce();
  });
});

describe('the holdover', () => {
  it('captures nothing from an image that has not painted', () => {
    const frame = document.createElement('div');
    const image = document.createElement('img');
    frame.append(image);
    document.body.append(frame);
    expect(captureHoldover(image, frame)).toBeNull();
    expect(captureHoldover(undefined, frame)).toBeNull();
    frame.remove();
  });

  it('measures a painted image inside its frame', () => {
    const frame = document.createElement('div');
    const image = document.createElement('img');
    frame.append(image);
    document.body.append(frame);
    Object.defineProperties(image, {
      complete: { value: true },
      naturalWidth: { value: 800 },
      currentSrc: { value: 'http://x/photo.jpg' },
    });
    image.getBoundingClientRect = () => ({ left: 60, top: 40, width: 300, height: 200 }) as DOMRect;
    frame.getBoundingClientRect = () => ({ left: 10, top: 10, width: 400, height: 300 }) as DOMRect;
    expect(captureHoldover(image, frame)).toEqual({
      src: 'http://x/photo.jpg',
      left: 50,
      top: 30,
      width: 300,
      height: 200,
    });
    frame.remove();
  });

  it('finishes at once where nothing can animate', () => {
    const done = vi.fn();
    fadeAway(document.createElement('div'), done);
    expect(done).toHaveBeenCalledOnce();
  });
});
