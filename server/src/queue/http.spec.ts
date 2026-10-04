import { createServer } from 'node:http';
import { fetchJobText } from 'src/queue/http.js';

describe('ML response deadline', () => {
  it('aborts a response that sends headers and then hangs in the body', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"embedding":');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Missing server address');
      }
      await expect(fetchJobText(`http://127.0.0.1:${address.port}`, {}, 50)).rejects.toThrow();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
