import { once } from 'node:events';
import { IncomingMessage, Server, ServerResponse, createServer } from 'node:http';
import { AddressInfo } from 'node:net';

/**
 * A scriptable fake Frameleaf Cloud for specs (FL-154..FL-158): discovery is served by default and
 * every other path answers from `routes` (`"POST /id/token"`), else 404. Every request is recorded,
 * so specs can assert what was (and was not) sent. Fork tests never need the real hosted service.
 */
export type FakeCloudRequest = {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: string;
  json: () => any;
  form: () => URLSearchParams;
};

export type FakeCloudAnswer = { status: number; body?: unknown };

export type FakeCloud = {
  url: string;
  requests: FakeCloudRequest[];
  routes: Map<string, (request: FakeCloudRequest) => FakeCloudAnswer | Promise<FakeCloudAnswer>>;
  on: (route: string, handler: (request: FakeCloudRequest) => FakeCloudAnswer | Promise<FakeCloudAnswer>) => void;
  discovery: () => Record<string, unknown>;
  close: () => Promise<void>;
};

const readBody = async (request: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
};

export const startFakeCloud = async (): Promise<FakeCloud> => {
  const fake = { requests: [], routes: new Map() } as unknown as FakeCloud;
  fake.on = (route, handler) => fake.routes.set(route, handler);
  fake.discovery = () => ({
    version: 1,
    validFor: 3600,
    issuer: `${fake.url}/id`,
    api: `${fake.url}/api`,
    ml: { eu: `${fake.url}/ml-eu` },
  });

  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  const server: Server = createServer(async (incoming: IncomingMessage, response: ServerResponse) => {
    const body = await readBody(incoming);
    const path = (incoming.url ?? '/').split('?', 1)[0];
    const request: FakeCloudRequest = {
      method: incoming.method ?? 'GET',
      path,
      headers: incoming.headers,
      body,
      json: () => JSON.parse(body),
      form: () => new URLSearchParams(body),
    };
    fake.requests.push(request);
    const send = ({ status, body: payload }: FakeCloudAnswer) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(payload === undefined ? '' : JSON.stringify(payload));
    };

    const handler = fake.routes.get(`${request.method} ${path}`);
    if (handler) {
      return send(await handler(request));
    }
    if (path === '/.well-known/frameleaf-services') {
      return send({ status: 200, body: fake.discovery() });
    }
    return send({ status: 404, body: { code: 'not-found', message: 'not found' } });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () => new Promise((resolve) => server.close(() => resolve()));
  return fake;
};
