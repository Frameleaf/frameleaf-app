import { createServer, type Server, type Socket } from 'node:net';
import type { Server as TlsServer } from 'node:tls';

// Only a plain host[:port] is echoed into Location; anything else gets a 400.
const HOST = /^host:[ \t]*([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(:\d{1,5})?[ \t]*\r?$/im;

/**
 * One port for both protocols. Browsers turn a typed "IP:port" into http://, which a TLS-only
 * listener answers with an empty reply. TLS handshakes (first byte 0x16) go to Manager unchanged;
 * a plain HTTP request is redirected to https:// on the same host and port.
 */
export function sharePortWithRedirect(https: TlsServer): Server {
  const front = createServer((socket: Socket) => {
    socket.setTimeout(10_000, () => socket.destroy());
    socket.on('error', () => socket.destroy());
    socket.once('data', (chunk: Buffer) => {
      socket.setTimeout(0);
      if (chunk[0] === 0x16) {
        socket.pause();
        socket.unshift(chunk);
        https.emit('connection', socket);
        process.nextTick(() => socket.resume());
        return;
      }
      const host = HOST.exec(chunk.toString('latin1'));
      socket.end(
        host
          ? `HTTP/1.1 308 Permanent Redirect\r\nLocation: https://${host[1]}${host[2] ?? ''}/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`
          : 'HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
      );
    });
  });
  https.on('close', () => front.close());
  return front;
}
