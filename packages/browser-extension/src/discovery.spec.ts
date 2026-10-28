import { beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverActivePage, parseDiscovery } from './discovery';
const page = 'https://example.com/page?private=1#part';
const candidate = {
  url: 'https://images.example.com/photo.jpg',
  width: 1200,
  kind: 'image',
  id: 'forged',
  pageUrl: 'https://forged.example',
  title: 'forged',
};
const raw = { documentUrl: page, title: 'Page title', candidates: [candidate] };
let executeScript: ReturnType<typeof vi.fn>;
let query: ReturnType<typeof vi.fn>;
beforeEach(() => {
  executeScript = vi
    .fn()
    .mockResolvedValueOnce([{ frameId: 0, documentId: 'document-one' }])
    .mockResolvedValueOnce([
      { frameId: 0, documentId: 'document-one', result: raw },
    ]);
  query = vi.fn().mockResolvedValue([{ id: 42, url: page }]);
  vi.stubGlobal('chrome', { tabs: { query }, scripting: { executeScript } });
});
describe('invoked discovery boundary', () => {
  it('pins the second injection to the first document and projects untrusted results', async () => {
    const discovery = await discoverActivePage();
    expect(executeScript.mock.calls[0][0]).toEqual({
      target: { tabId: 42 },
      files: ['content.js'],
      world: 'ISOLATED',
    });
    expect(executeScript.mock.calls[1][0].target).toEqual({
      tabId: 42,
      documentIds: ['document-one'],
    });
    expect(discovery).toMatchObject({
      tabId: 42,
      documentId: 'document-one',
      pageUrl: 'https://example.com/page',
      title: 'Page title',
      candidates: [
        {
          ...candidate,
          id: 'candidate-1',
          pageUrl: 'https://example.com/page',
          title: 'Page title',
        },
      ],
    });
  });
  it('rejects document navigation and unexpected frames', async () => {
    expect(() =>
      parseDiscovery({ ...raw, documentUrl: 'https://other.example/' }, page),
    ).toThrow();
    executeScript
      .mockReset()
      .mockResolvedValue([{ frameId: 2, documentId: 'subframe' }]);
    await expect(discoverActivePage()).rejects.toThrow('page');
  });
  it.each([
    'chrome://settings',
    'file:///private/file',
    'about:blank',
    'https://user:password@example.com/',
  ])(
    'refuses restricted or credential-bearing pages before injection: %s',
    async (url) => {
      query.mockResolvedValue([{ id: 42, url }] as chrome.tabs.Tab[]);
      await expect(discoverActivePage()).rejects.toThrow();
      expect(executeScript).not.toHaveBeenCalled();
    },
  );
  it('rejects malformed, oversized and unsafe content results', () => {
    for (const value of [
      null,
      { ...raw, candidates: Array(1001).fill(candidate) },
      { ...raw, title: 'x'.repeat(4097) },
      { ...raw, candidates: [{ ...candidate, url: 'file:///private/a.jpg' }] },
      {
        ...raw,
        candidates: [
          { ...candidate, url: 'https://user:secret@example.com/a.jpg' },
        ],
      },
    ])
      expect(() => parseDiscovery(value, page)).toThrow();
  });
  it('deduplicates URLs and discards unproven or invalid dimension hints', () => {
    expect(
      parseDiscovery(
        {
          ...raw,
          candidates: [
            { ...candidate, width: Infinity, height: -1 },
            candidate,
          ],
        },
        page,
      ).candidates,
    ).toEqual([
      {
        ...candidate,
        id: 'candidate-1',
        width: undefined,
        height: undefined,
        pageUrl: 'https://example.com/page',
        title: 'Page title',
      },
    ]);
  });
});
