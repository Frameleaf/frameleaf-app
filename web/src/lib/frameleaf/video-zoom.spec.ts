import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
import { clampVideoView, videoTransform, videoZoomAction, wheelVideoZoom, zoomVideoAt } from './video-zoom';

describe('video zoom (FL-801)', () => {
  describe('clampVideoView', () => {
    it('keeps the picture over the whole frame', () => {
      expect(clampVideoView({ zoom: 2, x: 50, y: 20 }, 400, 200)).toEqual({ zoom: 2, x: 0, y: 0 });
      expect(clampVideoView({ zoom: 2, x: -900, y: -900 }, 400, 200)).toEqual({ zoom: 2, x: -400, y: -200 });
      expect(clampVideoView({ zoom: 2, x: -100, y: -50 }, 400, 200)).toEqual({ zoom: 2, x: -100, y: -50 });
    });

    it('holds the zoom between fit and the ceiling, and centres at fit', () => {
      expect(clampVideoView({ zoom: 0.5, x: -10, y: -10 }, 400, 200)).toEqual({ zoom: 1, x: 0, y: 0 });
      expect(clampVideoView({ zoom: 40, x: 0, y: 0 }, 400, 200).zoom).toBe(10);
      expect(clampVideoView({ zoom: Number.NaN, x: 3, y: 3 }, 400, 200)).toEqual({ zoom: 1, x: 0, y: 0 });
    });
  });

  it('zooms toward a point and keeps that point in place', () => {
    const view = zoomVideoAt({ zoom: 1, x: 0, y: 0 }, 2, 100, 50, 400, 200);
    expect(view).toEqual({ zoom: 2, x: -100, y: -50 });
    // The point under the pointer is the same spot of the video before and after.
    expect((100 - view.x) / view.zoom).toBe(100);
    expect(zoomVideoAt(view, 1, 100, 50, 400, 200)).toEqual({ zoom: 1, x: 0, y: 0 });
  });

  it('takes a bounded step from each wheel event', () => {
    expect(wheelVideoZoom(1, -100)).toBeCloseTo(1.05);
    expect(wheelVideoZoom(2, 100)).toBeCloseTo(1.9);
    expect(wheelVideoZoom(1, -0.2)).toBeCloseTo(1.02);
  });

  it('writes no transform at fit', () => {
    expect(videoTransform({ zoom: 1, x: 0, y: 0 })).toBe('');
    expect(videoTransform({ zoom: 2, x: -5, y: -6 })).toBe('translate(-5px, -6px) scale(2)');
  });

  describe('videoZoomAction', () => {
    let frame: HTMLElement;
    let video: HTMLVideoElement;
    let controls: HTMLElement;
    let action: ReturnType<typeof videoZoomAction>;

    beforeEach(() => {
      frame = document.createElement('div');
      video = document.createElement('video');
      controls = document.createElement('div');
      frame.append(video, controls);
      document.body.append(frame);
      Object.defineProperty(frame, 'clientWidth', { value: 400 });
      Object.defineProperty(frame, 'clientHeight', { value: 200 });
      frame.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 200 }) as DOMRect;
      assetViewerManager.resetZoomState();
      action = videoZoomAction(frame, { target: video, enabled: true });
    });

    afterEach(() => {
      action.destroy();
      frame.remove();
      assetViewerManager.resetZoomState();
    });

    const pointer = (type: string, target: EventTarget, x: number, y: number, pointerId = 1) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
      Object.assign(event, { pointerId, pointerType: 'mouse' });
      target.dispatchEvent(event);
      return event;
    };

    it('pans a zoomed picture by dragging, clamped to the video', () => {
      assetViewerManager.zoom = 2;
      expect(video.style.transform).toBe('translate(-200px, -100px) scale(2)');

      pointer('pointerdown', frame, 200, 100);
      pointer('pointermove', window, 260, 130);
      expect(video.style.transform).toBe('translate(-140px, -70px) scale(2)');
      pointer('pointermove', window, 900, 900);
      expect(video.style.transform).toBe('translate(0px, 0px) scale(2)');
      pointer('pointerup', window, 900, 900);

      // A drag is not a click: the player does not play or pause.
      const click = new MouseEvent('click', { bubbles: true, cancelable: true });
      const played = vi.fn();
      frame.addEventListener('click', played);
      frame.dispatchEvent(click);
      expect(played).not.toHaveBeenCalled();
      expect(assetViewerManager.zoomState.currentPositionX).toBe(0);
    });

    it('leaves presses on the controls to the controls', () => {
      assetViewerManager.zoom = 2;
      pointer('pointerdown', controls, 200, 100);
      pointer('pointermove', window, 260, 130);
      expect(video.style.transform).toBe('translate(-200px, -100px) scale(2)');
    });

    it('pinches about the fingers', () => {
      const down = (x: number, id: number) => {
        const event = new MouseEvent('pointerdown', { bubbles: true, clientX: x, clientY: 100 });
        Object.assign(event, { pointerId: id, pointerType: 'touch' });
        frame.dispatchEvent(event);
      };
      down(150, 1);
      down(250, 2);
      const move = new MouseEvent('pointermove', { bubbles: true, cancelable: true, clientX: 300, clientY: 100 });
      Object.assign(move, { pointerId: 2, pointerType: 'touch' });
      window.dispatchEvent(move);
      // The fingers moved from 100px apart to 150px: 1.5x about their middle.
      expect(assetViewerManager.zoom).toBeCloseTo(1.5);
    });

    it('returns to fit and stops listening when zoom is turned off', () => {
      assetViewerManager.zoom = 3;
      action.update({ target: video, enabled: false });
      expect(assetViewerManager.zoom).toBe(1);
      expect(video.style.transform).toBe('');
      frame.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }));
      expect(assetViewerManager.zoom).toBe(1);
    });
  });
});
