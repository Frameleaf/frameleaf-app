import {
  CaptureAlbumScope,
  createCaptureAlbum,
  getCaptureCapabilities,
  getCaptureCatalog,
  type CaptureCapabilitiesDto,
  type CaptureCatalogDto,
} from '@frameleaf/sdk';

export type ServerBinding = {
  serverId: string;
  userId: string;
  origin: string;
  credentialId: string;
};
const messages = {
  address:
    'Use an HTTPS server address without credentials, a query, or a fragment.',
  connection:
    'Could not connect. Check the server address, certificate, and site access. Redirects are not followed.',
  authorization:
    'This key cannot capture. Create a Browser capture key on your server and reconnect.',
  unsupported:
    'This server does not support this version of Save to Frameleaf. Update the server before connecting.',
  identity:
    'This address now belongs to a different server or account. Reconnect before saving.',
  large:
    'The server response is too large for the extension. Check your server and try again.',
  credential: 'Reconnect to the original server and account before continuing.',
  permission:
    'Site access was not granted. Allow access to your Frameleaf server to connect.',
};
export class CaptureFailure extends Error {
  constructor(readonly code: keyof typeof messages) {
    super(messages[code]);
  }
}
const uuid =
  /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;

export function normalizeServerAddress(
  raw: string,
  allowLocalhost = false,
): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new CaptureFailure('address');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    raw.length > 8192 ||
    raw.includes('\\') ||
    /%2[ef]|%5c/i.test(url.pathname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(
      url.protocol === 'https:' ||
      (allowLocalhost && loopback && url.protocol === 'http:')
    )
  )
    throw new CaptureFailure('address');
  const path = url.pathname.replace(/\/+$/, '').replace(/\/api$/, '');
  return url.origin + path;
}
export function serverPermissionPattern(origin: string): string {
  const url = new URL(normalizeServerAddress(origin, true));
  // Chromium host grants cover the host's ports; requests below still pin the exact port and path.
  return `${url.protocol}//${url.hostname}/*`;
}
export const sameBinding = (a: ServerBinding, b: ServerBinding) =>
  a.serverId === b.serverId &&
  a.userId === b.userId &&
  a.origin === b.origin &&
  a.credentialId === b.credentialId;

async function boundedResponse(response: Response): Promise<Response> {
  const maxBytes = 8 * 1024 * 1024;
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await reader?.cancel();
    throw new CaptureFailure('large');
  }
  try {
    if (reader)
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        bytes += result.value.byteLength;
        if (bytes > maxBytes) {
          await reader.cancel();
          throw new CaptureFailure('large');
        }
        chunks.push(result.value);
      }
  } finally {
    reader?.releaseLock();
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(body, {
    status: response.status,
    headers: response.headers,
  });
}
function requestOptions(
  origin: string,
  token: string,
  transport: typeof fetch,
) {
  if (!token.trim() || token.length > 4096 || /\s/.test(token))
    throw new CaptureFailure('authorization');
  const baseUrl = normalizeServerAddress(origin, true) + '/api';
  const safeFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (
      url.origin !== new URL(baseUrl).origin ||
      !url.pathname.startsWith(new URL(baseUrl).pathname + '/')
    )
      throw new CaptureFailure('connection');
    try {
      const headers = new Headers(init?.headers);
      headers.delete('authorization');
      headers.delete('cookie');
      headers.set('x-api-key', token);
      const response = await transport(url.href, {
        ...init,
        headers,
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
        signal: AbortSignal.timeout(15000),
      });
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();
        throw new CaptureFailure('authorization');
      }
      if (
        response.redirected ||
        response.type === 'opaqueredirect' ||
        response.status < 200 ||
        response.status >= 300
      ) {
        await response.body?.cancel();
        throw new CaptureFailure('connection');
      }
      return await boundedResponse(response);
    } catch (error) {
      throw error instanceof CaptureFailure
        ? error
        : new CaptureFailure('connection');
    }
  };
  return { baseUrl, headers: { 'x-api-key': token }, fetch: safeFetch };
}
function checkedCapabilities(
  value: CaptureCapabilitiesDto,
): CaptureCapabilitiesDto {
  if (
    !value ||
    value.version !== 1 ||
    value.captureSupported !== true ||
    typeof value.serverId !== 'string' ||
    !value.serverId ||
    value.serverId.length > 256 ||
    typeof value.userId !== 'string' ||
    !uuid.test(value.userId) ||
    !Number.isSafeInteger(value.maxFileBytes) ||
    value.maxFileBytes < 0
  )
    throw new CaptureFailure('unsupported');
  return value;
}
async function capabilities(
  origin: string,
  token: string,
  fetch: typeof globalThis.fetch,
) {
  try {
    return checkedCapabilities(
      await getCaptureCapabilities(requestOptions(origin, token, fetch)),
    );
  } catch (error) {
    throw error instanceof CaptureFailure
      ? error
      : new CaptureFailure('unsupported');
  }
}
export async function connectServer(
  origin: string,
  token: string,
  options: { allowLocalhost?: boolean; fetch?: typeof fetch } = {},
): Promise<ServerBinding> {
  origin = normalizeServerAddress(origin, options.allowLocalhost);
  const found = await capabilities(
    origin,
    token,
    options.fetch ?? globalThis.fetch.bind(globalThis),
  );
  return {
    serverId: found.serverId,
    userId: found.userId,
    origin,
    credentialId: crypto.randomUUID(),
  };
}
async function boundOptions(
  binding: ServerBinding,
  token: string,
  fetch: typeof globalThis.fetch,
) {
  const found = await capabilities(binding.origin, token, fetch);
  if (found.serverId !== binding.serverId || found.userId !== binding.userId)
    throw new CaptureFailure('identity');
  return requestOptions(binding.origin, token, fetch);
}
export async function getCatalog(
  binding: ServerBinding,
  token: string,
  fetch = globalThis.fetch.bind(globalThis),
): Promise<CaptureCatalogDto> {
  try {
    const result = await getCaptureCatalog(
      await boundOptions(binding, token, fetch),
    );
    if (
      !result ||
      !Array.isArray(result.albums) ||
      !Array.isArray(result.tags) ||
      !result.albums.every(
        (album) =>
          uuid.test(album.id) &&
          typeof album.albumName === 'string' &&
          (album.parentId === null || uuid.test(album.parentId)),
      ) ||
      !result.tags.every(
        (tag) =>
          uuid.test(tag.id) &&
          typeof tag.name === 'string' &&
          typeof tag.value === 'string' &&
          typeof tag.createdAt === 'string' &&
          typeof tag.updatedAt === 'string' &&
          (tag.parentId === undefined || uuid.test(tag.parentId)) &&
          (tag.color === undefined || typeof tag.color === 'string'),
      )
    )
      throw new CaptureFailure('unsupported');
    return {
      albums: result.albums.map(({ id, albumName, parentId }) => ({
        id,
        albumName,
        parentId,
      })),
      tags: result.tags.map(
        ({ id, name, value, createdAt, updatedAt, parentId, color }) => ({
          id,
          name,
          value,
          createdAt,
          updatedAt,
          parentId,
          color,
        }),
      ),
    };
  } catch (error) {
    throw error instanceof CaptureFailure
      ? error
      : new CaptureFailure('unsupported');
  }
}
export async function createAlbum(
  binding: ServerBinding,
  token: string,
  name: string,
  parentId?: string,
) {
  return createCaptureAlbum(
    {
      captureAlbumCreateDto: {
        name,
        parentId,
        libraryScope: CaptureAlbumScope.Design,
      },
    },
    await boundOptions(binding, token, globalThis.fetch.bind(globalThis)),
  );
}
