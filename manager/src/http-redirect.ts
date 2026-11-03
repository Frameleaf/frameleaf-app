import { createServer, type Server, type Socket } from 'node:net';
import type { Server as TlsServer } from 'node:tls';

// Only a plain host[:port] is echoed into Location; anything else gets a 400.
const HOST = /^host:[ \t]*([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(:\d{1,5})?[ \t]*\r?$/im;
const END_OF_HEADERS = /\r?\n\r?\n/;
/** Plain-HTTP request heads are read up to this size; a Host line is in the first few hundred bytes. */
const HEAD_LIMIT = 8192;

/**
 * One port for both protocols. Browsers turn a typed "IP:port" into http://, which a TLS-only
 * listener answers with an empty reply. TLS handshakes (first byte 0x16) go to Manager unchanged;
 * a plain HTTP request is redirected to https:// on the same host and port. The request head is
 * accumulated until its blank line (or 8 KiB), so a client whose first segment stops before the
 * Host line still gets the redirect rather than a 400 (review L10).
 */
export function sharePortWithRedirect(https: TlsServer): Server {
  const front = createServer((socket: Socket) => {
    socket.setTimeout(10_000, () => socket.destroy());
    socket.on('error', () => socket.destroy());
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      if (!head.length && chunk[0] === 0x16) {
        socket.removeListener('data', onData);
        socket.setTimeout(0);
        socket.pause();
        socket.unshift(chunk);
        https.emit('connection', socket);
        process.nextTick(() => socket.resume());
        return;
      }
      head = Buffer.concat([head, chunk]);
      const text = head.toString('latin1');
      const end = END_OF_HEADERS.exec(text);
      if (!end && head.length < HEAD_LIMIT) return; // the Host line may still be on its way
      socket.removeListener('data', onData);
      socket.setTimeout(0);
      const host = end ? HOST.exec(text.slice(0, end.index)) : null;
      socket.end(
        host
          ? `HTTP/1.1 308 Permanent Redirect\r\nLocation: https://${host[1]}${host[2] ?? ''}/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`
          : 'HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
      );
    };
    socket.on('data', onData);
  });
  https.on('close', () => front.close());
  return front;
}
