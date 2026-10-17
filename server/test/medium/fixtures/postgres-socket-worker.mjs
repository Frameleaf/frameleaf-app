// Hosted integration peer in another OS process. Uses the real pinned Socket.IO PG adapter.
import { createAdapter } from '@socket.io/postgres-adapter';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { Server } from 'socket.io';
import { io } from 'socket.io-client';

const pool = new Pool({
  connectionString: process.env.FRAMELEAF_TEST_DATABASE_URL,
  max: 3,
  connectionTimeoutMillis: 2000,
  query_timeout: 2000,
  statement_timeout: 2000,
});
pool.on('error', () => {});
const server = new Server(0, { transports: ['websocket'] });
server.adapter(
  createAdapter(pool, {
    channelPrefix: 'frameleaf-socket.io',
    tableName: 'public.socket_io_attachments',
    heartbeatInterval: 1000,
    heartbeatTimeout: 5000,
    cleanupInterval: 1000,
  }),
);
server.on('connection', async (socket) => {
  // Socket.IO room admission is a side effect, not Array.join.
  // eslint-disable-next-line unicorn/no-unused-array-method-return
  await socket.join('frameleaf-test-room');
  socket.emit('joined');
});
server.on('channel-test', (payload, ack) => ack({ pid: process.pid, size: payload.length }));
server.on('AppRestart', (state, ack) => {
  process.send({ type: 'worker-restart', state });
  ack?.('ok');
});
await new Promise((resolve) => server.httpServer.once('listening', resolve));
const client = io(`http://127.0.0.1:${server.httpServer.address().port}`, { transports: ['websocket'] });
client.on('room-test', (payload, ack) => ack({ size: payload.length, pid: process.pid }));
client.on('AppRestartV1', (state, ack) => {
  process.send({ type: 'client-restart', state });
  ack?.('ok');
});
await new Promise((resolve, reject) => {
  client.once('joined', resolve);
  client.once('connect_error', reject);
});
const deadline = Date.now() + 5000;
while ((await server.sockets.adapter.serverCount()) < 2) {
  if (Date.now() >= deadline) throw new Error('Peer discovery timed out');
  await delay(50);
}
const id = randomUUID();
const refresh = () =>
  pool.query(
    `INSERT INTO public.frameleaf_websocket_worker (id, expires_at)
  VALUES ($1, clock_timestamp() + interval '5 seconds')
  ON CONFLICT (id) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
    [id],
  );
await refresh();
const heartbeat = setInterval(() => void refresh().catch(() => {}), 1000);
process.send({ type: 'ready', pid: process.pid, id });
process.once('message', async () => {
  clearInterval(heartbeat);
  client.close();
  await new Promise((resolve) => server.close(resolve));
  await pool.query('DELETE FROM public.frameleaf_websocket_worker WHERE id = $1', [id]);
  await pool.end();
  process.disconnect();
});
