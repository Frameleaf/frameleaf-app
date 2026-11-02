import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  initializeCaptureMenus,
  registerCaptureMenus,
  discoverMenuPage,
} from './context-menus';
const page = 'https://page.example/work?private=1#part';
const tab = { id: 42, url: page } as chrome.tabs.Tab;
const image = {
  menuItemId: 'frameleaf-save-image',
  pageUrl: page,
  frameId: 0,
  mediaType: 'image',
  srcUrl: 'https://images.example/one.png?signature=private',
} as chrome.contextMenus.OnClickData;
let get: ReturnType<typeof vi.fn>,
  executeScript: ReturnType<typeof vi.fn>,
  addListener: ReturnType<typeof vi.fn>,
  create: ReturnType<typeof vi.fn>,
  removeAll: ReturnType<typeof vi.fn>;
beforeEach(() => {
  get = vi.fn().mockResolvedValue(tab);
  executeScript = vi.fn().mockResolvedValue([
    {
      frameId: 0,
      documentId: 'doc',
      result: { documentUrl: page, title: 'Selected page', candidates: [] },
    },
  ]);
  addListener = vi.fn();
  removeAll = vi.fn().mockResolvedValue(undefined);
  create = vi.fn((_properties, callback) => {
    callback();
    return 'id';
  });
  vi.stubGlobal('chrome', {
    runtime: {},
    tabs: { get },
    scripting: { executeScript },
    contextMenus: { removeAll, create, onClicked: { addListener } },
  });
});
describe('invoked context menus', () => {
  it('registers one synchronous listener and creates only page/image web menus', async () => {
    const clicked = vi.fn().mockResolvedValue(undefined);
    registerCaptureMenus(clicked);
    expect(addListener).toHaveBeenCalledOnce();
    addListener.mock.calls[0][0](image, tab);
    expect(clicked).toHaveBeenCalledWith(image, tab);
    let finishRemoval: (() => void) | undefined;
    removeAll.mockImplementation((callback) => {
      finishRemoval = callback;
    });
    const initialization = initializeCaptureMenus();
    await Promise.resolve();
    expect(create).not.toHaveBeenCalled();
    finishRemoval?.();
    await initialization;
    expect(removeAll).toHaveBeenCalledOnce();
    expect(create.mock.calls.map((call) => call[0])).toEqual([
      {
        id: 'frameleaf-save-image',
        title: 'Save image to Frameleaf',
        contexts: ['image'],
        documentUrlPatterns: ['https://*/*', 'http://*/*'],
      },
      {
        id: 'frameleaf-save-page',
        title: 'Save page bookmark to Frameleaf',
        contexts: ['page'],
        documentUrlPatterns: ['https://*/*', 'http://*/*'],
      },
    ]);
  });
  it('targets the clicked tab instead of the current foreground tab, with only the clicked image', async () => {
    expect(await discoverMenuPage(image, tab)).toEqual({
      tabId: 42,
      documentId: 'doc',
      pageUrl: 'https://page.example/work',
      title: 'Selected page',
      candidates: [
        {
          id: 'candidate-1',
          kind: 'image',
          url: image.srcUrl,
          pageUrl: 'https://page.example/work',
          title: 'Selected page',
          width: undefined,
          height: undefined,
        },
      ],
    });
    expect(get).toHaveBeenCalledWith(42);
    expect(executeScript).toHaveBeenCalledOnce();
    expect(executeScript.mock.calls[0][0]).toMatchObject({
      target: { tabId: 42 },
      world: 'ISOLATED',
    });
    expect(executeScript.mock.calls[0][0]).not.toHaveProperty('files');
  });
  it('keeps a page bookmark target only for explicit confirmation and downloads nothing', async () => {
    const result = await discoverMenuPage(
      {
        ...image,
        menuItemId: 'frameleaf-save-page',
        srcUrl: undefined,
        mediaType: undefined,
      },
      tab,
    );
    expect(result.bookmarkUrl).toBe(page);
    expect(result.pageUrl).toBe('https://page.example/work');
    expect(result.candidates).toEqual([]);
  });
  it('rejects stale, foreign-frame, restricted, oversized and unsafe menu payloads before injection', async () => {
    for (const info of [
      { ...image, menuItemId: 'unknown' },
      { ...image, pageUrl: 'https://other.example/' },
      { ...image, frameId: 1 },
      {
        ...image,
        frameId: undefined,
        frameUrl: 'https://foreign-frame.example/',
      },
      { ...image, srcUrl: 'javascript:alert(1)' },
      { ...image, srcUrl: 'https://user:secret@images.example/a' },
      { ...image, srcUrl: 'file:///private/file' },
      { ...image, srcUrl: 'blob:https://other.example/blob' },
      { ...image, srcUrl: 'data:image/png,' + 'x'.repeat(256 * 1024) },
    ])
      await expect(discoverMenuPage(info, tab)).rejects.toThrow(
        'Could not inspect',
      );
    expect(executeScript).not.toHaveBeenCalled();
    get.mockResolvedValue({ ...tab, url: 'https://navigated.example/' });
    await expect(discoverMenuPage(image, tab)).rejects.toThrow();
    expect(executeScript).not.toHaveBeenCalled();
  });
  it('rejects navigation during metadata read and unexpected frame or document results', async () => {
    for (const result of [
      {
        frameId: 0,
        documentId: 'doc',
        result: {
          documentUrl: 'https://other.example/',
          title: 'Wrong',
          candidates: [],
        },
      },
      {
        frameId: 1,
        documentId: 'frame',
        result: { documentUrl: page, title: 'Wrong', candidates: [] },
      },
      {
        frameId: 0,
        result: {
          documentUrl: page,
          title: 'Missing identity',
          candidates: [],
        },
      },
    ]) {
      executeScript.mockResolvedValue([result]);
      await expect(discoverMenuPage(image, tab)).rejects.toThrow();
    }
  });
});
