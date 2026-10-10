import { once } from 'node:events';
import { type Socket, createServer } from 'node:net';
import type { ConfigRepository } from 'src/repositories/config.repository.js';
import { WorkerStopProofRecorder } from 'src/queue/worker-stop-proof.js';

it('bounds a real silent PostgreSQL handshake and retains its proof for a later retry', async () => {
  const sockets = new Set<Socket>();
  let connections = 0;
  let peak = 0;
  const server = createServer((socket) => {
    connections++;
    sockets.add(socket);
    peak = Math.max(peak, sockets.size);
    socket.on('data', () => {}); // Accept the TCP connection but never answer PostgreSQL startup.
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('TCP fixture did not bind');
  const config = {
    getEnv: () => ({
      database: {
        config: {
          connectionType: 'url',
          url: `postgres://test:test@127.0.0.1:${address.port}/frameleaf`,
        },
      },
    }),
  } as unknown as ConfigRepository;
  const diagnostic = vi.fn();
  const recorder = new WorkerStopProofRecorder(config, { timeoutMs: 50, retryMs: 100, diagnostic });
  try {
    const startedAt = performance.now();
    await recorder.record({ workerId: '9278736b-d61f-4b66-8de9-41d17a5e59ca', stoppedAt: 12_345 });
    expect(performance.now() - startedAt).toBeLessThan(1000);
    expect(diagnostic).toHaveBeenCalled();
    await vi.waitFor(() => expect(connections).toBeGreaterThan(1), { timeout: 2000 });
    expect(peak).toBe(1);
  } finally {
    await recorder.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 5000);

it('destroys a timed-out query connection and retries the same proof after protocol recovery', async () => {
  const sockets = new Set<Socket>();
  const submitted: unknown[] = [];
  let healthy = false;
  const frame = (type: string, body: Buffer) => {
    const header = Buffer.alloc(5);
    header.write(type);
    header.writeInt32BE(body.length + 4, 1);
    return Buffer.concat([header, body]);
  };
  // A small PostgreSQL wire fixture: startup succeeds, then the first INSERT gets no response.
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let startup = true;
    let pending = Buffer.alloc(0);
    socket.on('data', (bytes) => {
      pending = Buffer.concat([pending, bytes]);
      if (startup) {
        if (pending.length < 4 || pending.length < pending.readInt32BE(0)) return;
        pending = pending.subarray(pending.readInt32BE(0));
        startup = false;
        socket.write(Buffer.concat([frame('R', Buffer.alloc(4)), frame('Z', Buffer.from('I'))]));
      }
      while (pending.length >= 5) {
        const length = pending.readInt32BE(1) + 1;
        if (pending.length < length) return;
        const packet = pending.subarray(0, length);
        pending = pending.subarray(length);
        const type = String.fromCodePoint(packet[0]);
        if (type === 'B') submitted.push(packet.toString('base64'));
        if (!healthy) continue;
        switch (type) {
          case 'P': {
            socket.write(frame('1', Buffer.alloc(0)));
            break;
          }
          case 'B': {
            socket.write(frame('2', Buffer.alloc(0)));
            break;
          }
          case 'D': {
            socket.write(frame('n', Buffer.alloc(0)));
            break;
          }
          case 'E': {
            socket.write(frame('C', Buffer.from('INSERT 0 1\0')));
            break;
          }
          case 'S': {
            socket.write(frame('Z', Buffer.from('I')));
            // No default
            break;
          }
        }
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('TCP fixture did not bind');
  const config = {
    getEnv: () => ({
      database: {
        config: {
          connectionType: 'url',
          url: `postgres://test:test@127.0.0.1:${address.port}/frameleaf`,
        },
      },
    }),
  } as unknown as ConfigRepository;
  const diagnostic = vi.fn();
  const recorder = new WorkerStopProofRecorder(config, { timeoutMs: 50, retryMs: 100, diagnostic });
  try {
    const startedAt = performance.now();
    await recorder.record({ workerId: '9278736b-d61f-4b66-8de9-41d17a5e59ca', stoppedAt: 12_345 });
    expect(performance.now() - startedAt).toBeLessThan(1000);
    expect(diagnostic).toHaveBeenCalled();
    await vi.waitFor(() => expect(sockets.size).toBe(0));
    healthy = true;
    await vi.waitFor(() => expect(submitted).toHaveLength(2), { timeout: 2000 });
    expect(submitted[1]).toEqual(submitted[0]);
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    expect(submitted).toHaveLength(2);
  } finally {
    await recorder.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 5000);
