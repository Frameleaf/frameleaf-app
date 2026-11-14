const { isIP } = require('node:net');

// Every Connect scope this app uses. The Library returns exactly the requested set, so a token with
// any other set (narrower or broader) is refused before it is stored.
const SCOPES = [
  'library:read',
  'library:download',
  'albums:write',
  'tags:write',
  'photos:upload',
  'boards:upload',
  'events:read',
];
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sameScopes = (value) =>
  typeof value === 'string' &&
  [...new Set(value.split(' '))].sort().join(' ') ===
    [...SCOPES].sort().join(' ') &&
  value.split(' ').length === SCOPES.length;
const validToken = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 8192 &&
  !/[\r\n]/.test(value);

module.exports = function createConnect(text) {
  function serverOrigin(value) {
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new Error(text.invalidServer);
    }
    if (
      url.protocol !== 'https:' ||
      url.origin !== value ||
      url.username ||
      url.password ||
      isIP(url.hostname.replace(/^\[|\]$/g, '')) ||
      !url.hostname.includes('.') ||
      url.hostname.endsWith('.') ||
      /(?:^|\.)(?:localhost|local|internal|home\.arpa)$/.test(url.hostname)
    )
      throw new Error(text.invalidServer);
    return url.origin;
  }
  function clientId(value) {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9._~-]{1,200}$/.test(value))
      throw new Error(text.invalidClient);
    return value;
  }
  function configuration(bundle, stored = false) {
    const data = stored
      ? bundle.authData
      : { ...bundle.authData, ...bundle.inputData };
    const origin = serverOrigin(data?.serverUrl);
    const client = clientId(data?.frameleafClientId);
    const resource = origin + '/api/connect';
    if (
      stored &&
      (data.frameleafResource !== resource ||
        data.frameleafBoundClientId !== client)
    )
      throw new Error(text.reconnect);
    return { origin, client, resource };
  }
  function callback(value) {
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new Error(text.invalidCallback);
    }
    if (
      url.protocol !== 'https:' ||
      url.host !== 'zapier.com' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.pathname.startsWith('/dashboard/auth/oauth/return/')
    )
      throw new Error(text.invalidCallback);
    return value;
  }
  async function request(z, options, tokenRequest = false) {
    let response;
    try {
      response = await z.request({
        ...options,
        redirect: 'error',
        timeout: 10000,
        size: 65536,
        skipThrowForStatus: true,
        headers: { Accept: 'application/json', ...options.headers },
      });
    } catch (error) {
      if (
        !tokenRequest &&
        (error instanceof z.errors.RefreshAuthError ||
          error instanceof z.errors.ThrottledError)
      )
        throw error;
      throw new z.errors.ExpiredAuthError(text.reconnect);
    }
    if (response.status === 401 && !tokenRequest)
      throw new z.errors.RefreshAuthError();
    if (response.status < 200 || response.status >= 300)
      throw new z.errors.ExpiredAuthError(text.reconnect);
    try {
      const data =
        typeof response.content === 'string'
          ? JSON.parse(response.content)
          : response.data;
      if (!data || typeof data !== 'object' || Array.isArray(data))
        throw new Error();
      return data;
    } catch {
      throw new z.errors.ExpiredAuthError(text.reconnect);
    }
  }
  function uuid(z, value) {
    if (typeof value !== 'string' || !UUID.test(value))
      throw new z.errors.Error(text.invalidId, 'InvalidId', 400);
    return value.toLowerCase();
  }
  // Signed request to a fixed Connect path. Status codes map to distinct, translated errors so a
  // revoked grant, narrowed consent, expired cursor and unavailable rendition stay distinguishable.
  async function api(z, bundle, method, path, options = {}) {
    const config = configuration(bundle, true);
    const access = bundle.authData.access_token;
    if (!validToken(access)) throw new z.errors.ExpiredAuthError(text.reconnect);
    let response;
    try {
      response = await z.request({
        url: config.resource + '/' + path,
        method,
        params: options.params,
        body: options.json ? JSON.stringify(options.json) : options.body,
        raw: options.raw,
        redirect: 'error',
        timeout: options.timeout ?? 30000,
        ...(!options.raw && { size: 1048576 }),
        skipThrowForStatus: true,
        headers: {
          Accept: options.raw ? '*/*' : 'application/json',
          ...(options.json && { 'Content-Type': 'application/json' }),
          ...options.headers,
          Authorization: 'Bearer ' + access,
        },
      });
    } catch (error) {
      if (
        error instanceof z.errors.RefreshAuthError ||
        error instanceof z.errors.ThrottledError
      )
        throw error;
      throw new z.errors.Error(text.unreachable, 'Unreachable', 502);
    }
    const status = response.status;
    if (status === 401) throw new z.errors.RefreshAuthError();
    if (status === 409) {
      if (options.conflict) return undefined;
      // A changed payload under a reused request ID is permanent; anything else is a short-lived
      // hierarchy/consent change that Connect asks clients to retry unchanged.
      const message = String(response.content ?? '');
      if (/payload changed/i.test(message))
        throw new z.errors.Error(text.sourceReused, 'SourceIdReused', 409);
      // Only "access is changing; retry" is transient. An expired, cancelled or rejected upload,
      // or a destination that stopped accepting writes, will not recover by replaying.
      if (/retry/i.test(message))
        throw new z.errors.ThrottledError(text.busy, 15);
      throw new z.errors.Error(text.unavailable, 'Unavailable', 409);
    }
    if (status === 404 && options.missing) return undefined;
    const errors = {
      403: ['forbidden', 'Forbidden'],
      404: ['notFound', 'NotFound'],
      410: ['cursorExpired', 'CursorExpired'],
      413: ['tooLarge', 'TooLarge'],
    };
    if (errors[status])
      throw new z.errors.Error(
        text[errors[status][0]],
        errors[status][1],
        status,
      );
    if (status < 200 || status >= 300)
      throw new z.errors.Error(text.failed, 'Failed', status);
    if (options.raw) return response;
    let data;
    try {
      data =
        typeof response.content === 'string'
          ? JSON.parse(response.content)
          : response.data;
    } catch {
      data = undefined;
    }
    if (!data || typeof data !== 'object')
      throw new z.errors.Error(text.failed, 'Failed', 502);
    return data;
  }
  return {
    SCOPES,
    sameScopes,
    validToken,
    serverOrigin,
    clientId,
    configuration,
    callback,
    request,
    uuid,
    api,
  };
};
