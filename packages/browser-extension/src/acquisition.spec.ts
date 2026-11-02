import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acquireCandidate,
  mediaOrigin,
  MAX_CAPTURE_BYTES,
} from './acquisition';
const candidate = {
  id: 'one',
  kind: 'image' as const,
  url: 'https://images.example.com:8443/photo.jpg?signature=private',
  pageUrl: 'https://page.example.com/work',
  title: 'Reference',
};
let fetcher: ReturnType<typeof vi.fn>;
let contains: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetcher = vi.fn().mockResolvedValue(
    new Response(new Uint8Array([1, 2, 3]), {
      headers: { 'content-type': 'image/jpeg' },
    }),
  );
  contains = vi.fn().mockResolvedValue(true);
  vi.stubGlobal('fetch', fetcher);
  vi.stubGlobal('chrome', { permissions: { contains } });
});
afterEach(() => vi.useRealTimers());
describe('anonymous, explicitly authorized acquisition', () => {
  it('preserves the signed acquisition URL but omits all browser and Frameleaf credentials', async () => {
    const blob = await acquireCandidate(
      candidate,
      new Set(['https://images.example.com:8443']),
    );
    expect(blob.size).toBe(3);
    expect(blob.type).toBe('image/jpeg');
    expect(fetcher).toHaveBeenCalledWith(
      candidate.url,
      expect.objectContaining({
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        redirect: 'error',
        cache: 'no-store',
      }),
    );
    const options = fetcher.mock.calls[0][1];
    expect(options.headers).toBeUndefined();
    expect(contains).toHaveBeenCalledWith({
      origins: ['https://images.example.com/*'],
    });
  });
  it('requires the exact approved origin including port even when Chromium grants span ports', async () => {
    await expect(
      acquireCandidate(candidate, new Set(['https://images.example.com'])),
    ).rejects.toThrow('Allow');
    expect(fetcher).not.toHaveBeenCalled();
    contains.mockResolvedValue(false);
    await expect(
      acquireCandidate(candidate, new Set(['https://images.example.com:8443'])),
    ).rejects.toThrow('Allow');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    'file:///private/a.jpg',
    'javascript:alert(1)',
    'https://user:secret@images.example.com/a.jpg',
    'blob:https://other.example.com/file',
  ])('refuses unsafe acquisition URLs before fetching: %s', async (url) => {
    await expect(
      acquireCandidate({ ...candidate, url }, new Set()),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects redirects, protected responses, HTML and empty bodies', async () => {
    for (const response of [
      new Response('', {
        status: 302,
        headers: { location: 'https://other.example.com/a.jpg' },
      }),
      new Response('', { status: 403 }),
      new Response('<html>Sign in</html>', {
        headers: { 'content-type': 'text/html' },
      }),
      new Response(''),
    ]) {
      fetcher.mockResolvedValueOnce(response);
      await expect(
        acquireCandidate(
          candidate,
          new Set(['https://images.example.com:8443']),
        ),
      ).rejects.toThrow();
    }
  });
  it('enforces actual streamed bytes when Content-Length is missing or false and cancels the reader', async () => {
    for (const headers of [
      new Headers(),
      new Headers({ 'content-length': '1' }),
    ]) {
      const cancel = vi.fn();
      let sent = 0;
      const block = new Uint8Array(1024 * 1024);
      const stream = new ReadableStream({
        pull(controller) {
          controller.enqueue(block);
          if (++sent > MAX_CAPTURE_BYTES / block.length + 1) controller.close();
        },
        cancel,
      });
      fetcher.mockResolvedValueOnce(new Response(stream, { headers }));
      await expect(
        acquireCandidate(
          candidate,
          new Set(['https://images.example.com:8443']),
        ),
      ).rejects.toThrow('100 MB');
      expect(cancel).toHaveBeenCalled();
    }
  });
  it('refuses declared oversize before consuming bytes and never exposes server text', async () => {
    fetcher.mockResolvedValueOnce(
      new Response('secret server response', {
        status: 200,
        headers: { 'content-length': String(MAX_CAPTURE_BYTES + 1) },
      }),
    );
    await expect(
      acquireCandidate(candidate, new Set(['https://images.example.com:8443'])),
    ).rejects.toThrow('100 MB');
    fetcher.mockRejectedValueOnce(
      new Error('private signed URL or server response'),
    );
    await expect(
      acquireCandidate(candidate, new Set(['https://images.example.com:8443'])),
    ).rejects.not.toThrow('private');
  });
  it('cancels a stalled response body at its deadline', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    fetcher.mockResolvedValueOnce(new Response(new ReadableStream({ cancel })));
    const stopped = expect(
      acquireCandidate(candidate, new Set(['https://images.example.com:8443'])),
    ).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(30001);
    await stopped;
    expect(cancel).toHaveBeenCalled();
  });
  it('cancels a pending reader when the chooser cancels or loses access', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const controller = new AbortController();
    fetcher.mockResolvedValueOnce(new Response(new ReadableStream({ cancel })));
    const stopped = expect(
      acquireCandidate(
        candidate,
        new Set(['https://images.example.com:8443']),
        controller.signal,
      ),
    ).rejects.toThrow('stopped');
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await stopped;
    expect(cancel).toHaveBeenCalled();
  });
  it('allows bounded inline images without granting a website and supports cancellation', async () => {
    expect(mediaOrigin('data:image/png;base64,YQ==')).toBeNull();
    await acquireCandidate(
      { ...candidate, url: 'data:image/png;base64,YQ==' },
      new Set(),
    );
    expect(contains).not.toHaveBeenCalled();
    const controller = new AbortController();
    controller.abort();
    fetcher.mockClear();
    await expect(
      acquireCandidate(
        candidate,
        new Set(['https://images.example.com:8443']),
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
