import { createServer } from 'node:http';
import { fetchJobText } from 'src/queue/http.js';

describe('ML response deadline', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('aborts a response that sends headers and then hangs in the body', async () => {
    let responsesStarted = 0;
    let responsesClosed = 0;
    const server = createServer((_request, response) => {
      response.on('close', () => responsesClosed++);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"embedding":');
      responsesStarted++;
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Missing server address');
      }
      await expect(fetchJobText(`http://127.0.0.1:${address.port}`, {}, 1000)).rejects.toMatchObject({
        name: expect.stringMatching(/^(AbortError|TimeoutError)$/u),
      });
      // A connect timeout is not evidence that a hung body was cancelled. The remote
      // close must also precede cleanup, which would otherwise hide a leaked request.
      expect(responsesStarted).toBe(1);
      await vi.waitFor(() => expect(responsesClosed).toBe(1), { timeout: 2000, interval: 10 });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('ML response size', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('refuses an oversized declared body before reading and cancels it', async () => {
    const cancelled = vi.fn();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(1));
        },
        pull(controller) {
          controller.close();
        },
        cancel: cancelled,
      }),
      { headers: { 'content-length': '9' } },
    );
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    await expect(fetchJobText('https://worker.invalid', {}, 1000, 8)).rejects.toThrow('too large');
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it('bounds chunked response bytes and cancels on overflow', async () => {
    let reads = 0;
    const cancelled = vi.fn();
    const response = new Response(
      new ReadableStream({
        pull(controller) {
          reads++;
          if (reads <= 3) controller.enqueue(new Uint8Array(5));
          else controller.close();
        },
        cancel: cancelled,
      }),
    );
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    await expect(fetchJobText('https://worker.invalid', {}, 1000, 8)).rejects.toThrow('too large');
    expect(cancelled).toHaveBeenCalledOnce();
    expect(reads).toBeLessThanOrEqual(3);
  });

  it('accepts the exact byte limit with UTF8 split across chunks', async () => {
    const data = new TextEncoder().encode('éééé');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(data.subarray(0, 3));
              controller.enqueue(data.subarray(3));
              controller.close();
            },
          }),
        ),
      ),
    );
    expect((await fetchJobText('https://worker.invalid', {}, 1000, 8)).body).toBe('éééé');
  });
});
