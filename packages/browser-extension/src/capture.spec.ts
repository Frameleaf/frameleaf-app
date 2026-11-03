import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cropRectangle, takeScreenshot, cropCapture } from './capture';
const page = 'https://page.example/work?private=1#part';
const frame = {
  frameId: 0,
  documentId: 'doc',
  result: {
    url: page,
    title: 'Page',
    width: 1000,
    height: 800,
    scrollX: 0,
    scrollY: 200,
    scale: 1,
    left: 0,
    top: 0,
    overlay: false,
  },
};
let getWindow: ReturnType<typeof vi.fn>, query: ReturnType<typeof vi.fn>;
let capture: ReturnType<typeof vi.fn>, execute: ReturnType<typeof vi.fn>;
let activated: {
  addListener: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
};
beforeEach(() => {
  const event = () => ({ addListener: vi.fn(), removeListener: vi.fn() });
  activated = event();
  capture = vi.fn().mockResolvedValue('data:image/png;base64,Ynl0ZXM=');
  execute = vi.fn().mockResolvedValue([frame]);
  getWindow = vi.fn().mockResolvedValue({ focused: true });
  query = vi
    .fn()
    .mockResolvedValue([{ id: 42, windowId: 7, url: page, active: true }]);
  vi.stubGlobal('chrome', {
    tabs: {
      query,
      captureVisibleTab: capture,
      onActivated: activated,
      onUpdated: event(),
    },
    windows: {
      get: getWindow,
      onFocusChanged: event(),
    },
    scripting: { executeScript: execute },
  });
});
describe('screenshot capture and pixel geometry', () => {
  it.each([1, 1.25, 2, 3])(
    'maps CSS bounds against actual pixel dimensions at scale %s',
    (scale) => {
      expect(
        cropRectangle(
          { width: 1000 * scale, height: 800 * scale },
          { width: 1000, height: 800 },
          { x: 100, y: 80, width: 200, height: 160 },
        ),
      ).toEqual({
        x: 100 * scale,
        y: 80 * scale,
        width: 200 * scale,
        height: 160 * scale,
      });
    },
  );
  it('rounds fractional bounds outward and rejects empty, nonfinite or out-of-viewport rectangles', () => {
    expect(
      cropRectangle(
        { width: 1250, height: 1000 },
        { width: 1000, height: 800 },
        { x: 1, y: 1, width: 2, height: 2 },
      ),
    ).toEqual({ x: 1, y: 1, width: 3, height: 3 });
    for (const rect of [
      { x: -1, y: 0, width: 10, height: 10 },
      { x: 0, y: 0, width: 0, height: 10 },
      { x: 999, y: 0, width: 2, height: 10 },
      { x: 0, y: 0, width: Infinity, height: 10 },
    ])
      expect(() =>
        cropRectangle(
          { width: 1250, height: 1000 },
          { width: 1000, height: 800 },
          rect,
        ),
      ).toThrow();
  });
  it('rejects an aspect mismatch instead of cropping unrelated viewport pixels', () => {
    expect(() =>
      cropRectangle(
        { width: 1280, height: 641 },
        { width: 1280, height: 720 },
        { x: 100, y: 100, width: 100, height: 100 },
      ),
    ).toThrow();
  });
  it('rejects malformed or oversized PNG dimensions before decoding pixels', async () => {
    const decode = vi
      .fn()
      .mockRejectedValue(new Error('unexpected decoder allocation'));
    vi.stubGlobal('createImageBitmap', decode);
    const header = new Uint8Array(24);
    header.set([137, 80, 78, 71, 13, 10, 26, 10]);
    header.set([73, 72, 68, 82], 12);
    const view = new DataView(header.buffer);
    view.setUint32(8, 13);
    view.setUint32(16, 60000);
    view.setUint32(20, 60000);
    for (const blob of [
      new Blob([], { type: 'image/png' }),
      new Blob(['not png'], { type: 'image/png' }),
      new Blob([header], { type: 'image/png' }),
    ])
      await expect(
        cropCapture(blob, { width: 100, height: 100 }),
      ).rejects.toThrow('Screenshot');
    expect(decode).not.toHaveBeenCalled();
  });
  it('pins the focused tab/window/document and retains only sanitized source metadata', async () => {
    const result = await takeScreenshot(
      'visible',
      new AbortController().signal,
    );
    expect(capture).toHaveBeenCalledWith(7, { format: 'png' });
    expect(result).toMatchObject({
      discovery: {
        tabId: 42,
        documentId: 'doc',
        pageUrl: 'https://page.example/work',
        title: 'Page',
        candidates: [],
      },
      screenshot: {
        mode: 'visible',
        viewport: { width: 1000, height: 800 },
        dataUrl: 'data:image/png;base64,Ynl0ZXM=',
      },
    });
    expect(activated.removeListener).toHaveBeenCalledOnce();
  });
  it('rejects a tab switch even when the original tab becomes active again before the API returns', async () => {
    capture.mockImplementation(async () => {
      const listener = activated.addListener.mock.calls[0][0];
      listener({ windowId: 7, tabId: 99 });
      listener({ windowId: 7, tabId: 42 });
      return 'data:image/png;base64,Ynl0ZXM=';
    });
    await expect(
      takeScreenshot('visible', new AbortController().signal),
    ).rejects.toThrow('Screenshot');
  });
  it('rejects navigation, viewport change, hidden windows and restricted pages without retaining pixels', async () => {
    execute
      .mockResolvedValueOnce([frame])
      .mockResolvedValue([{ ...frame, documentId: 'new-doc' }]);
    await expect(
      takeScreenshot('visible', new AbortController().signal),
    ).rejects.toThrow();
    execute
      .mockReset()
      .mockResolvedValueOnce([frame])
      .mockResolvedValue([
        { ...frame, result: { ...frame.result, width: 800 } },
      ]);
    await expect(
      takeScreenshot('visible', new AbortController().signal),
    ).rejects.toThrow();
    getWindow.mockResolvedValue({
      focused: false,
    } as chrome.windows.Window);
    await expect(
      takeScreenshot('visible', new AbortController().signal),
    ).rejects.toThrow();
    query.mockResolvedValue([
      { id: 42, windowId: 7, url: 'chrome://settings' },
    ] as chrome.tabs.Tab[]);
    await expect(
      takeScreenshot('visible', new AbortController().signal),
    ).rejects.toThrow();
  });
  it('rejects an area cancelled by a tab switch without taking pixels', async () => {
    execute.mockResolvedValueOnce([frame]).mockImplementationOnce(async () => {
      activated.addListener.mock.calls[0][0]({ windowId: 7, tabId: 99 });
      return [{ frameId: 0, documentId: 'doc', result: null }];
    });
    await expect(
      takeScreenshot('area', new AbortController().signal),
    ).rejects.toThrow();
    expect(capture).not.toHaveBeenCalled();
  });
  it('settles cancellation while the native capture call is still pending', async () => {
    capture.mockReturnValue(new Promise(() => {}));
    const controller = new AbortController();
    const pending = takeScreenshot('visible', controller.signal);
    await vi.waitFor(() => expect(capture).toHaveBeenCalled());
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(activated.removeListener).toHaveBeenCalledOnce();
  }, 500);
  it('does not capture cancelled area selections or already aborted invocations', async () => {
    execute
      .mockResolvedValueOnce([frame])
      .mockResolvedValueOnce([{ frameId: 0, documentId: 'doc', result: null }]);
    expect(
      await takeScreenshot('area', new AbortController().signal),
    ).toBeNull();
    expect(capture).not.toHaveBeenCalled();
    const controller = new AbortController();
    controller.abort();
    await expect(
      takeScreenshot('visible', controller.signal),
    ).rejects.toThrow();
    expect(capture).not.toHaveBeenCalled();
  });
});
