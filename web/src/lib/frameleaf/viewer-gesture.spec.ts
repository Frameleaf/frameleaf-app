import {
  DISMISS_DISTANCE,
  isGestureExempt,
  TAP_DURATION_MS,
  ViewerGesture,
  type ViewerGestureHandlers,
} from '$lib/frameleaf/viewer-gesture';

const setup = () => {
  let now = 0;
  const handlers: ViewerGestureHandlers = {
    onDrag: vi.fn(),
    onRelease: vi.fn(),
    onDismiss: vi.fn(),
    onTap: vi.fn(),
  };
  const gesture = new ViewerGesture(handlers, () => now);
  return { gesture, handlers, advance: (ms: number) => (now += ms) };
};

describe('ViewerGesture (MediaViewer.jsx:524-578)', () => {
  it('treats a short, still press as a tap that toggles the chrome', () => {
    const { gesture, handlers, advance } = setup();
    gesture.start(1, 100, 100);
    advance(120);
    gesture.end(1, 102, 101);
    expect(handlers.onTap).toHaveBeenCalledOnce();
    expect(handlers.onDismiss).not.toHaveBeenCalled();
  });

  it('is not a tap when the press is held too long or moves too far', () => {
    const { gesture, handlers, advance } = setup();
    gesture.start(1, 100, 100);
    advance(TAP_DURATION_MS + 1);
    gesture.end(1, 100, 100);
    gesture.start(1, 100, 100);
    gesture.end(1, 120, 100);
    expect(handlers.onTap).not.toHaveBeenCalled();
  });

  it('follows a downward drag, shrinking with progress, and closes past the distance', () => {
    const { gesture, handlers } = setup();
    gesture.start(1, 100, 100);
    expect(gesture.move(1, 110, 300)).toBe(true);
    expect(handlers.onDrag).toHaveBeenLastCalledWith({ x: 5, y: 200, progress: 0.5 });
    gesture.end(1, 110, 100 + DISMISS_DISTANCE + 1);
    expect(handlers.onDismiss).toHaveBeenCalledOnce();
    expect(handlers.onTap).not.toHaveBeenCalled();
  });

  it('springs back from a short drag', () => {
    const { gesture, handlers } = setup();
    gesture.start(1, 100, 100);
    gesture.move(1, 100, 160);
    gesture.end(1, 100, 160);
    expect(handlers.onRelease).toHaveBeenCalledOnce();
    expect(handlers.onDismiss).not.toHaveBeenCalled();
  });

  it('never starts closing on a sideways swipe or an upward drag', () => {
    const { gesture, handlers } = setup();
    gesture.start(1, 100, 100);
    gesture.move(1, 200, 130);
    gesture.move(1, 100, 20);
    gesture.end(1, 300, 140);
    expect(handlers.onDrag).not.toHaveBeenCalled();
    expect(handlers.onDismiss).not.toHaveBeenCalled();
  });

  it('puts the photo back when the gesture is cancelled mid-drag', () => {
    const { gesture, handlers } = setup();
    gesture.start(1, 0, 0);
    gesture.move(1, 0, 50);
    gesture.cancel();
    expect(handlers.onRelease).toHaveBeenCalledOnce();
    expect(gesture.active).toBe(false);
  });

  // B1: a pinch at normal zoom must never close the viewer.
  it('ends at once when a second finger goes down, and ignores both fingers afterwards', () => {
    const { gesture, handlers } = setup();
    gesture.start(1, 100, 100);
    gesture.move(1, 100, 130);
    gesture.start(2, 200, 200);
    expect(gesture.active).toBe(false);
    expect(handlers.onRelease).toHaveBeenCalledOnce();
    expect(gesture.move(1, 100, 400)).toBe(false);
    expect(gesture.move(2, 200, 500)).toBe(false);
    gesture.end(1, 100, 400);
    gesture.end(2, 200, 500);
    expect(handlers.onDismiss).not.toHaveBeenCalled();
    expect(handlers.onTap).not.toHaveBeenCalled();
  });

  it('ignores the moves and releases of any pointer it is not following', () => {
    const { gesture, handlers } = setup();
    gesture.start(1, 100, 100);
    expect(gesture.move(7, 100, 400)).toBe(false);
    gesture.end(7, 100, 400);
    expect(gesture.active).toBe(true);
    expect(gesture.pointerId).toBe(1);
    expect(handlers.onDrag).not.toHaveBeenCalled();
    expect(handlers.onDismiss).not.toHaveBeenCalled();
  });

  it('leaves controls, fields and video players to themselves', () => {
    const button = document.createElement('button');
    const icon = document.createElement('span');
    button.append(icon);
    expect(isGestureExempt(icon)).toBe(true);
    expect(isGestureExempt(document.createElement('video'))).toBe(true);
    expect(isGestureExempt(document.createElement('img'))).toBe(false);
    expect(isGestureExempt(null)).toBe(false);
  });
});
