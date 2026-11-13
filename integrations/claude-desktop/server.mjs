import { message } from './messages.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { AsyncEntry } from '@napi-rs/keyring';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import open from 'open';
import lockfile from 'proper-lockfile';
import { libraryHttps } from './https.mjs';
import { ADAPTER, AdapterError, LibraryOAuth, libraryResource } from './oauth.mjs';

const limit = { type: 'integer', minimum: 1, maximum: 50, default: 20 };
const captureDate = {
  type: 'string',
  format: 'date',
  pattern: '^\\d{4}-\\d{2}-\\d{2}$',
};
const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const tools = [
  {
    name: 'search_library',
    description: message('searchDescription'),
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 500 },
        city: { type: 'string', minLength: 1, maxLength: 200 },
        takenFrom: captureDate,
        takenBefore: captureDate,
        limit,
      },
    },
    annotations,
  },
  {
    name: 'list_albums',
    description: message('listDescription'),
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { limit },
    },
    annotations,
  },
  {
    name: 'get_album',
    description: message('albumDescription'),
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { albumId: { type: 'string', format: 'uuid' }, limit },
      required: ['albumId'],
    },
    annotations,
  },
];

function credentials(resource) {
  const account = createHash('sha256').update(resource.href).digest('hex');
  const directory = join(homedir(), '.frameleaf-assistant');
  let entry;
  const withEntry = async (operation) => {
    try {
      entry ??= new AsyncEntry('Frameleaf Assistant', account, {
        linux: { store: 'secret-service' },
      });
      return await operation(entry);
    } catch {
      throw new AdapterError(message('lockedCredentials'));
    }
  };
  return {
    read: () => withEntry(async (key) => JSON.parse((await key.getPassword()) ?? 'null')),
    write: (grant) => withEntry((key) => key.setPassword(JSON.stringify(grant))),
    async lock(work) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      // Refresh-token reuse revokes the grant. Hold the same lock for every process on this computer.
      const release = await lockfile
        .lock(join(directory, account), {
          realpath: false,
          retries: {
            retries: 180,
            factor: 1,
            minTimeout: 1000,
            maxTimeout: 1000,
          },
        })
        .catch(() => {
          throw new AdapterError(message('busy'));
        });
      try {
        return await work();
      } finally {
        await release();
      }
    },
  };
}

async function main() {
  const resource = libraryResource(process.argv[2]);
  const { fetch: libraryFetch } = libraryHttps(resource);
  const oauth = new LibraryOAuth(resource, credentials(resource), libraryFetch, async (url) => {
    try {
      await open(url.href);
    } catch {
      throw new AdapterError(message('browser'));
    }
  });
  const remote = new Client(ADAPTER);
  let connected;
  const local = new Server(ADAPTER, { capabilities: { tools: {} } });
  const connect = () =>
    remote.connect(
      new StreamableHTTPClientTransport(resource, {
        fetch: async (url, options) => {
          const send = (token) => {
            const signal = AbortSignal.any([options.signal, AbortSignal.timeout(30_000)].filter(Boolean));
            const headers = new Headers(options.headers);
            headers.set('Authorization', `Bearer ${token}`);
            return libraryFetch(url, { ...options, headers, signal }).catch(() => {
              throw new AdapterError(message('tls'));
            });
          };
          const token = await oauth.token();
          const first = await send(token);
          if (first.status !== 401 || options.method === 'GET') {
            return first;
          }
          await first.body?.cancel();
          return send(await oauth.token(token));
        },
      }),
    );

  local.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
  local.setRequestHandler(CallToolRequestSchema, async ({ params }, { signal }) => {
    if (!tools.some(({ name }) => name === params.name)) {
      return {
        isError: true,
        content: [{ type: 'text', text: message('toolUnavailable') }],
      };
    }

    try {
      // Complete browser sign-in before starting the upstream MCP handshake timeout.
      await oauth.token();
      signal.throwIfAborted();
      connected ??= connect().catch((error) => {
        connected = undefined;
        throw error;
      });
      await connected;
      return await remote.callTool({ name: params.name, arguments: params.arguments }, undefined, { signal });
    } catch (error) {
      const text =
        error.code === 404
          ? message('licence')
          : error.code === 401
            ? message('unauthorized')
            : error instanceof AdapterError
              ? error.message
              : message('request');
      return { isError: true, content: [{ type: 'text', text }] };
    }
  });
  await local.connect(
    new StdioServerTransport(undefined, undefined, {
      maxBufferSize: 256 * 1024,
    }),
  );
  process.stdin.once('end', () => process.exit());
}

main().catch((error) => {
  const text = error instanceof AdapterError ? error.message : message('startup');
  process.stderr.write(`Frameleaf Assistant: ${text}\n`);
  process.exitCode = 1;
});
