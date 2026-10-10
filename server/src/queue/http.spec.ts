import { createServer } from 'node:http';
import { fetchJobText } from 'src/queue/http.js';

describe('ML response deadline', () => {
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
