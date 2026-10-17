import { cleanup, render } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import type { OcrBox, VerticalMode } from '$lib/utils/ocr-utils';
import OcrBoundingBox from './OcrBoundingBox.svelte';

const media = vi.hoisted(() => ({ coarse: true }));
vi.mock('$lib/stores/media-query-manager.svelte', () => ({
  mediaQueryManager: {
    get pointerCoarse() {
      return media.coarse;
    },
  },
}));

let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
const select = vi.fn<(node: Node) => void>();
const selection = vi.fn<() => Selection | null>();

beforeEach(() => {
  media.coarse = true;
  frames = new Map();
  nextFrame = 0;
  select.mockReset();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextFrame++;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  selection.mockReset().mockReturnValue({ selectAllChildren: select } as unknown as Selection);
  vi.stubGlobal('getSelection', selection);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const box = (id = 'box', verticalMode: VerticalMode = 'none'): OcrBox => ({
  id,
  text: 'Literal <text> & café',
  confidence: 0.9,
  verticalMode,
  points: [
    { x: 10, y: 20 },
    { x: 110, y: 20 },
    { x: 110, y: 50 },
    { x: 10, y: 50 },
  ],
});

const mount = (ocrBox = box()) => {
  const result = render(OcrBoundingBox, { ocrBox });
  flushSync();
  const node = result.container.querySelector<HTMLElement>('[data-testid="ocr-box"]')!;
  return { ...result, node, start: () => node.dispatchEvent(new Event('selectstart', { bubbles: true })) };
};

const flushFrames = () => {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) {
    callback(0);
  }
  flushSync();
};

it('defers touch selection until the next frame and selects the original node', () => {
  const view = mount();
  view.start();
  expect(selection).not.toHaveBeenCalled();
  flushFrames();
  expect(select).toHaveBeenCalledExactlyOnceWith(view.node);
});

it('coalesces repeated selection starts into one pending selection', () => {
  const view = mount();
  view.start();
  view.start();
  view.start();
  expect(frames.size).toBe(1);
  flushFrames();
  expect(select).toHaveBeenCalledExactlyOnceWith(view.node);
});

it('cancels a pending frame, including frame zero, when unmounted', () => {
  const view = mount();
  view.start();
  expect(frames.has(0)).toBe(true);
  view.unmount();
  expect(frames.size).toBe(0);
  flushFrames();
  expect(selection).not.toHaveBeenCalled();
});

it('does not overwrite selection if its DOM node was detached before the frame', () => {
  const view = mount();
  view.start();
  view.node.remove();
  flushFrames();
  expect(selection).not.toHaveBeenCalled();
});

it('keeps pending selection owned by each mounted box', () => {
  const first = mount(box('first'));
  const second = mount(box('second'));
  first.start();
  second.start();
  first.unmount();
  flushFrames();
  expect(select).toHaveBeenCalledExactlyOnceWith(second.node);
});

it('keeps the most recent selection gesture last across different boxes', () => {
  const first = mount(box('first'));
  const second = mount(box('second'));
  first.start();
  second.start();
  first.start();
  flushFrames();
  expect(select).toHaveBeenCalledTimes(2);
  expect(select.mock.lastCall?.[0]).toBe(first.node);
});

it('allows a subsequent selection after its first frame completed', () => {
  const view = mount();
  view.start();
  flushFrames();
  view.start();
  flushFrames();
  expect(select).toHaveBeenCalledTimes(2);
  expect(select.mock.calls.every(([node]) => node === view.node)).toBe(true);
});

it('leaves fine-pointer selection to the browser', () => {
  media.coarse = false;
  const view = mount();
  view.start();
  expect(frames.size).toBe(0);
  expect(selection).not.toHaveBeenCalled();
  expect(view.node.classList.contains('select-text')).toBe(true);
});

it('tolerates an unavailable native selection', () => {
  selection.mockReturnValue(null);
  mount().start();
  expect(flushFrames).not.toThrow();
  expect(select).not.toHaveBeenCalled();
});

it.each(['none', 'cjk', 'rotated'] as const)('retains literal text, geometry and vertical mode %s', (mode) => {
  const data = box('geometry', mode);
  const { node } = mount(data);
  expect(node.textContent?.trim()).toBe(data.text);
  expect(node.querySelector('text')).toBeNull();
  expect(node.getAttribute('aria-label')).toBe(data.text);
  expect(node.getAttribute('role')).toBe('button');
  expect(node.tabIndex).toBe(0);
  expect(node.style.width).toBe('100px');
  expect(node.style.height).toBe('30px');
  expect(node.style.transform).toContain('matrix3d');
  expect(node.style.writingMode).toBe(mode === 'none' ? '' : 'vertical-rl');
  expect(node.style.textOrientation).toBe(mode === 'rotated' ? 'sideways' : '');
});
