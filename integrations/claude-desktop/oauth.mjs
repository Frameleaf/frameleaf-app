import { message } from './messages.mjs';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';

export const ADAPTER = { name: 'Frameleaf Assistant', version: '1.0.0' };
const SCOPE = 'library:read';

export class AdapterError extends Error {}
const RESOURCE_PATH = '/api/mcp/assistant';
const CALLBACK_PATH = '/assistant/callback';
const LOOPBACK = '127.0.0.1';

export function libraryResource(address) {
  const url = URL.canParse(address?.trim()) ? new URL(address.trim()) : undefined;
  if (
    url?.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.href.includes('?') ||
    url.href.includes('#') ||
    !['/', RESOURCE_PATH].includes(url.pathname)
  ) {
    throw new AdapterError(message('invalidAddress'));
  }
  return new URL(RESOURCE_PATH, url.origin);
}

function endpoint(issuer, value) {
  const url = typeof value === 'string' && URL.canParse(value) ? new URL(value) : undefined;
  if (url?.origin !== issuer || url.username || url.password || url.hash) {
    throw new AdapterError(message('metadata'));
  }
  return url;
}

async function authorizationCode(issuer, authorize, openBrowser) {
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const callback = createServer();
  callback.requestTimeout = 10_000;
  callback.listen(0, LOOPBACK);

  try {
    await once(callback, 'listening');
    const origin = `http://${LOOPBACK}:${callback.address().port}`;
    const redirectUri = origin + CALLBACK_PATH;
    const timeout = AbortSignal.timeout(180_000);
    const codePromise = new Promise((resolve, reject) => {
      timeout.addEventListener('abort', () => reject(new AdapterError(message('timeout'))), {
        once: true,
      });
      callback.on('request', (request, response) => {
        response.setHeader('Content-Type', 'text/plain; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Referrer-Policy', 'no-referrer');
        response.setHeader('Connection', 'close');

        const url = URL.canParse(request.url, origin) ? new URL(request.url, origin) : undefined;
        if (
          request.method !== 'GET' ||
          request.headers.host !== new URL(origin).host ||
          url?.origin !== origin ||
          url.pathname !== CALLBACK_PATH
        ) {
          response.writeHead(404).end(message('unavailable'));
          return;
        }

        const [code] = url.searchParams.getAll('code');
        const [error] = url.searchParams.getAll('error');
        const isOneCode = url.searchParams.getAll('code').length === 1 && !!code && !error;
        const isOneError = url.searchParams.getAll('error').length === 1 && !!error && !code;
        if (
          url.searchParams.getAll('state').length !== 1 ||
          url.searchParams.get('state') !== state ||
          url.searchParams.getAll('iss').length !== 1 ||
          url.searchParams.get('iss') !== issuer ||
          !(isOneCode || isOneError)
        ) {
          response.writeHead(400).end(message('invalidCallback'));
          return;
        }

        response.writeHead(200).end(message('completeCallback'));
        if (isOneError) {
          reject(new AdapterError(message('declined')));
        } else {
          resolve(code);
        }
      });
    });

    const url = authorize({
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: SCOPE,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const [code] = await Promise.all([codePromise, openBrowser(url)]);
    return { code, redirect_uri: redirectUri, code_verifier: verifier };
  } finally {
    callback.close();
    callback.closeIdleConnections();
  }
}

export class LibraryOAuth {
  #pending;
  #metadata;

  constructor(resource, store, fetch, openBrowser) {
    this.resource = resource;
    this.store = store;
    this.fetch = fetch;
    this.openBrowser = openBrowser;
  }

  async #request(url, options = {}) {
    let response;
    try {
      response = await this.fetch(url, {
        ...options,
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new AdapterError(message('tls'));
    }
    const data = await response.json().catch(() => undefined);
    if (!response.ok || !data || typeof data !== 'object') {
      if (response.status === 400 && ['invalid_grant', 'invalid_client'].includes(data?.error)) {
        return { error: data.error };
      }
      throw new AdapterError(message('oauth', response.status));
    }
    return data;
  }

  async #discover() {
    if (this.#metadata) {
      return this.#metadata;
    }
    const issuer = this.resource.origin;
    const metadata = await this.#request(
      new URL('/.well-known/oauth-protected-resource' + this.resource.pathname, issuer),
    );
    if (
      metadata.resource !== this.resource.href ||
      !Array.isArray(metadata.authorization_servers) ||
      metadata.authorization_servers.length !== 1 ||
      metadata.authorization_servers[0] !== issuer ||
      !Array.isArray(metadata.scopes_supported) ||
      !metadata.scopes_supported.includes(SCOPE)
    ) {
      throw new AdapterError(message('metadata'));
    }

    const authorization = await this.#request(new URL('/.well-known/oauth-authorization-server', issuer));
    if (
      authorization.issuer !== issuer ||
      !Array.isArray(authorization.code_challenge_methods_supported) ||
      !authorization.code_challenge_methods_supported.includes('S256') ||
      authorization.authorization_response_iss_parameter_supported !== true
    ) {
      throw new AdapterError(message('metadata'));
    }
    this.#metadata = {
      authorize: endpoint(issuer, authorization.authorization_endpoint),
      token: endpoint(issuer, authorization.token_endpoint),
      register:
        authorization.registration_endpoint === undefined
          ? undefined
          : endpoint(issuer, authorization.registration_endpoint),
    };
    return this.#metadata;
  }

  async #register(metadata) {
    if (!metadata.register) {
      throw new AdapterError(message('registration'));
    }
    const data = await this.#request(metadata.register, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: ADAPTER.name,
        redirect_uris: [`http://${LOOPBACK}${CALLBACK_PATH}`],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: SCOPE,
      }),
    });
    if (typeof data.client_id !== 'string' || !data.client_id) {
      throw new AdapterError(message('invalidClient'));
    }
    await this.store.write({ clientId: data.client_id });
    return data.client_id;
  }

  async #exchange(metadata, clientId, params) {
    const data = await this.#request(metadata.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        ...params,
        client_id: clientId,
        resource: this.resource.href,
      }),
    });
    if (data.error) {
      return data;
    }
    if (
      data.token_type?.toLowerCase?.() !== 'bearer' ||
      typeof data.access_token !== 'string' ||
      !data.access_token ||
      typeof data.refresh_token !== 'string' ||
      !data.refresh_token ||
      !Number.isFinite(data.expires_in) ||
      data.expires_in <= 0 ||
      data.scope !== SCOPE
    ) {
      throw new AdapterError(message('invalidGrant'));
    }
    const entry = {
      clientId,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
    await this.store.write(entry);
    return entry;
  }

  async #loadOrConnect(rejectedToken) {
    const saved = await this.store.read();
    if (saved?.accessToken && saved.accessToken !== rejectedToken && saved.expiresAt > Date.now() + 30_000) {
      return saved;
    }

    const metadata = await this.#discover();
    let clientId = saved?.clientId;
    if (saved?.refreshToken) {
      // A network failure can hide a successful rotation. Never send the old token again.
      await this.store.write({ clientId });
      const refreshed = await this.#exchange(metadata, clientId, {
        grant_type: 'refresh_token',
        refresh_token: saved.refreshToken,
      });
      if (!refreshed.error) {
        return refreshed;
      }
      clientId = undefined;
      await this.store.write({});
    }

    clientId ??= await this.#register(metadata);
    const code = await authorizationCode(
      this.resource.origin,
      (params) => {
        const url = new URL(metadata.authorize);
        for (const [name, value] of Object.entries({
          ...params,
          client_id: clientId,
          resource: this.resource.href,
        })) {
          url.searchParams.set(name, value);
        }
        return url;
      },
      this.openBrowser,
    );
    const entry = await this.#exchange(metadata, clientId, {
      ...code,
      grant_type: 'authorization_code',
    });
    if (entry.error) {
      throw new AdapterError(message('incomplete'));
    }
    return entry;
  }

  async token(rejectedToken) {
    const previous = this.#pending;
    if (!previous) {
      this.#pending = this.store
        .lock(() => this.#loadOrConnect(rejectedToken))
        .finally(() => {
          this.#pending = undefined;
        });
    }
    const entry = await this.#pending;
    if (entry.accessToken === rejectedToken) {
      if (previous) {
        return this.token(rejectedToken);
      }
      throw new AdapterError(message('unauthorized'));
    }
    return entry.accessToken;
  }
}
