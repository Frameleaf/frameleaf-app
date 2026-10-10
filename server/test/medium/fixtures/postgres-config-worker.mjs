// Real OS process and pinned PostgreSQL adapter; executes compiled production event dispatch.
import { Server } from 'socket.io';
import { PostgresSocketTransport } from '../../../dist/middleware/websocket.adapter.js';
import { EventRepository } from '../../../dist/repositories/event.repository.js';
import { WebsocketRepository } from '../../../dist/repositories/websocket.repository.js';

const config = {
  getEnv: () => ({ database: { config: { connectionType: 'url', url: process.env.FRAMELEAF_TEST_DATABASE_URL } } }),
};
const logger = { setContext() {}, log() {}, debug() {}, error() {} };
const events = new EventRepository({}, config, logger);
let release;
Reflect.get(events, 'addHandler').call(events, {
  event: 'ConfigUpdate',
  server: true,
  priority: 0,
  label: 'OwnedConfigFixture.reconcile',
  handler: async (update) => {
    process.send({ type: 'config-entered', pid: process.pid });
    await new Promise((resolve) => (release = resolve));
    if (update.fixtureFailure) throw new Error('Owned configuration reconciliation failure');
    process.send({ type: 'config-completed', pid: process.pid });
  },
});
const server = new Server();
const transport = new PostgresSocketTransport(config);
const websocket = new WebsocketRepository(events, logger);
Reflect.set(websocket, 'server', server);
websocket.afterInit(server);
await transport.attach(server);
process.on('message', async (message) => {
  if (message.type === 'release') {
    release?.();
    return;
  }
  if (message.type !== 'stop') return;
  release?.();
  await server.close();
  await transport.close();
  process.disconnect();
});
process.send({ type: 'ready', pid: process.pid });
