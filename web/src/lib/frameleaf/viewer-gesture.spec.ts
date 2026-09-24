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
    gesture.start(100, 100);
    advance(120);
    gesture.end(102, 101);
    expect(handlers.onTap).toHaveBeenCalledOnce();
    expect(handlers.onDismiss).not.toHaveBeenCalled();
  });

  it('is not a tap when the press is held too long or moves too far', () => {
    const { gesture, handlers, advance } = setup();
    gesture.start(100, 100);
    advance(TAP_DURATION_MS + 1);
    gesture.end(100, 100);
    gesture.start(100, 100);
    gesture.end(120, 100);
    expect(handlers.onTap).not.toHaveBeenCalled();
  });

  it('follows a downward drag, shrinking with progress, and closes past the distance', () => {
    const { gesture, handlers } = setup();
    gesture.start(100, 100);
    expect(gesture.move(110, 300)).toBe(true);
    expect(handlers.onDrag).toHaveBeenLastCalledWith({ x: 5, y: 200, progress: 0.5 });
    gesture.end(110, 100 + DISMISS_DISTANCE + 1);
    expect(handlers.onDismiss).toHaveBeenCalledOnce();
    expect(handlers.onTap).not.toHaveBeenCalled();
  });

  it('springs back from a short drag', () => {
    const { gesture, handlers } = setup();
    gesture.start(100, 100);
    gesture.move(100, 160);
    gesture.end(100, 160);
    expect(handlers.onRelease).toHaveBeenCalledOnce();
    expect(handlers.onDismiss).not.toHaveBeenCalled();
  });

  it('never starts closing on a sideways swipe or an upward drag', () => {
    const { gesture, handlers } = setup();
    gesture.start(100, 100);
    gesture.move(200, 130);
    gesture.move(100, 20);
    gesture.end(300, 140);
    expect(handlers.onDrag).not.toHaveBeenCalled();
    expect(handlers.onDismiss).not.toHaveBeenCalled();
  });

  it('puts the photo back when the gesture is cancelled mid-drag', () => {
    const { gesture, handlers } = setup();
    gesture.start(0, 0);
    gesture.move(0, 50);
    gesture.cancel();
    expect(handlers.onRelease).toHaveBeenCalledOnce();
    expect(gesture.active).toBe(false);
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
