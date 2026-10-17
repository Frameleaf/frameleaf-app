import policy from './resource-policy.json' with { type: 'json' };

export class ResourceBlockedError extends Error {
  constructor(id) {
    super(`FRAMELEAF_RESOURCE_BLOCKED: ${id}`);
    this.name = 'ResourceBlockedError';
    this.code = 'FRAMELEAF_RESOURCE_BLOCKED';
  }
}

const APPROVAL = /^[a-f0-9]{64}$/;
const HUGGING_FACE = 'https://huggingface.co/';

const admitted = (resource) => resource?.localRuntime === 'allowed' && APPROVAL.test(resource.approvalSha256 ?? '');

/**
 * The policy entry a URL belongs to, or undefined. A URL is never an identity of its own: it is
 * admitted only inside a reviewed locator. A Hugging Face repository is reached only through the
 * exact revision the owner approved (`/resolve/<revision>/`), never a branch such as `main`, and
 * any other locator only by itself or a path beneath it. The URL is parsed first, so dot segments,
 * encoded separators, credentials, another host or a lookalike prefix cannot borrow an approval.
 * When several rows cover the URL (a voice file inside its model repository), the most specific
 * locator decides, and a blocked row among them blocks the URL.
 */
function entryForUrl(id) {
  let url;
  try {
    url = new URL(id);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.href !== id) return undefined;
  if (/%2f|%5c/i.test(url.pathname)) return undefined;
  const matches = [];
  for (const resource of Object.values(policy)) {
    const { locator, revision } = resource ?? {};
    if (typeof locator !== 'string' || !locator) continue;
    if (/^https:\/\//.test(locator)) {
      const base = locator.endsWith('/') ? locator : `${locator}/`;
      if (id === locator || (!locator.includes('?') && id.startsWith(base))) matches.push([locator.length, resource]);
    } else if (typeof revision === 'string' && /^[a-f0-9]{40}$/.test(revision)) {
      const base = `${HUGGING_FACE}${locator}/resolve/${revision}/`;
      if (id.startsWith(base)) matches.push([base.length, resource]);
    }
  }
  if (matches.length === 0 || matches.some(([, resource]) => !admitted(resource))) return undefined;
  return matches.sort((a, b) => b[0] - a[0])[0][1];
}

/**
 * The approved revision of a Hugging Face repository, or undefined when the policy pins none.
 * Only a `model:<repository>` row with a commit revision pins a repository.
 */
function pinnedRevision(repository) {
  const resource = Object.hasOwn(policy, `model:${repository}`) ? policy[`model:${repository}`] : undefined;
  return admitted(resource) && /^[a-f0-9]{40}$/.test(resource.revision ?? '') ? resource.revision : undefined;
}

/**
 * Loaders inside third-party bundles (transformers.js pre-flight metadata, kokoro-js) ask Hugging
 * Face for a branch no option of ours reaches. Every request this scope makes for a repository the
 * owner approved at a commit is sent to that commit instead: `/{repo}/resolve/{ref}/...` and the
 * `/api/models/{repo}/tree/{ref}` listing. Nothing else is touched. Installed once per global
 * scope (window or worker) by importing this module.
 */
function rewriteHuggingFace(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    return input;
  }
  if (url.origin !== 'https://huggingface.co') return input;
  const segments = url.pathname.split('/');
  // /{owner}/{repo}/resolve/{ref}/...  or  /api/models/{owner}/{repo}/tree/{ref}
  const api = segments[1] === 'api' && segments[2] === 'models';
  const offset = api ? 3 : 1;
  const repository = `${segments[offset]}/${segments[offset + 1]}`;
  const kind = segments[offset + 2];
  if ((api ? kind !== 'tree' : kind !== 'resolve') || !segments[offset + 3]) return input;
  const revision = pinnedRevision(repository);
  if (!revision || segments[offset + 3] === revision) return input;
  segments[offset + 3] = revision;
  url.pathname = segments.join('/');
  return url.href;
}

const PINNED = Symbol.for('frameleaf.resource-admission.fetch-pinned');
const STORES = new Set(['transformers-cache', 'kokoro-voices']);
// Native Request subclasses (including jsdom's compatibility wrapper) inherit
// this getter. Retain its brand check instead of reading user-controlled .url.
let requestPrototype = globalThis.Request?.prototype;
let nativeRequestUrl;
while (requestPrototype && !nativeRequestUrl) {
  nativeRequestUrl = Object.getOwnPropertyDescriptor(requestPrototype, 'url')?.get;
  requestPrototype = Object.getPrototypeOf(requestPrototype);
}

function fileRequest(input, init) {
  // Non-native test realms may import policy consumers, but cannot admit model transport.
  if (!nativeRequestUrl) throw new ResourceBlockedError('Native Request unavailable');
  let url;
  let native = false;
  try { url = nativeRequestUrl.call(input); native = true; } catch { url = String(input); }
  const parsed = new URL(url);
  if (parsed.href !== url || parsed.origin !== 'https://huggingface.co' || parsed.username
    || parsed.password || parsed.search || parsed.hash || /%2f|%5c/i.test(parsed.pathname)) throw new ResourceBlockedError(url);
  const parts = parsed.pathname.split('/');
  const repository = `${parts[1]}/${parts[2]}`;
  const revision = pinnedRevision(repository);
  if (parts[3] !== 'resolve' || !revision || !['main', revision].includes(parts[4])) throw new ResourceBlockedError(url);
  const request = new Request(native ? input : url, init);
  if (!['GET', 'HEAD'].includes(request.method) || request.body !== null) throw new ResourceBlockedError(url);
  const target = rewriteHuggingFace(request.url);
  approvedFile(target); // Admit identity before transport or reading a body.
  return { original: request, request: target === request.url ? request : new Request(target, request) };
}

function approvedFile(id) {
  const resource = requireResource(id);
  const file = typeof id === 'string' && Object.hasOwn(resource.files ?? {}, id) ? resource.files[id] : undefined;
  if (!file || file.url !== id || file.approvalSha256 !== resource.approvalSha256
    || file.revision !== resource.revision || !/^[a-f0-9]{40}$/.test(file.revision ?? '')
    || !APPROVAL.test(file.sha256 ?? '')) throw new ResourceBlockedError(id);
  return file;
}

async function verifiedResponse(request, response) {
  request.signal.throwIfAborted();
  if (!response.ok || response.status === 206 || ['opaque', 'opaqueredirect'].includes(response.type)) throw new ResourceBlockedError(request.url);
  const bytes = await response.arrayBuffer();
  request.signal.throwIfAborted();
  const verified = await verifyResourceBytes(request.url, bytes);
  request.signal.throwIfAborted();
  // Both installed Transformers versions and Kokoro consume headers/status/body, never url/type.
  // Return the immutable bytes we hashed, rather than releasing the original body's stream.
  return new Response(verified, { status: response.status, statusText: response.statusText, headers: response.headers });
}

if (typeof globalThis.fetch === 'function' && !globalThis[PINNED]) {
  const original = globalThis.fetch;
  globalThis.fetch = async function pinnedFetch(input, init) {
    if (!nativeRequestUrl) throw new ResourceBlockedError('Native Request unavailable');
    let requestUrl;
    try { requestUrl = nativeRequestUrl.call(input); } catch { /* Native string form across realms. */ }
    const normalized = requestUrl ?? String(input);
    let destination;
    try { destination = new URL(normalized, globalThis.location?.href); } catch { /* Native rejection below. */ }
    if (destination?.hostname.replace(/\.$/, '') === 'huggingface.co') {
      let checked;
      try { checked = fileRequest(requestUrl === undefined ? normalized : input, init); }
      catch { throw new ResourceBlockedError(destination.origin + destination.pathname); }
      const { request } = checked;
      request.signal.throwIfAborted();
      const response = await original.call(globalThis, request);
      request.signal.throwIfAborted();
      if (request.method === 'HEAD') return response;
      if (!response.ok) {
        await response.body?.cancel();
        request.signal.throwIfAborted();
        // Transformers checks status for optional files; Kokoro reads bodies regardless of status.
        // Preserve HTTP failure metadata, but no failed body may reach a voice/model or its Map.
        const body = new ReadableStream({ start(controller) { controller.error(new ResourceBlockedError(request.url)); } });
        return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
      }
      return verifiedResponse(request, response);
    }
    return original.call(globalThis, requestUrl === undefined ? normalized : input, init);
  };
  globalThis[PINNED] = true;
}

const CACHE_PINNED = Symbol.for('frameleaf.resource-admission.cache-pinned');
if (globalThis.caches && !globalThis[CACHE_PINNED]) {
  const storage = globalThis.caches;
  const open = storage.open.bind(storage);
  const storageMatch = storage.match.bind(storage);
  const wrap = (cache) => new Proxy(cache, {
    get(target, method) {
      if (method === 'match') return async (input, options) => {
        const { original, request } = fileRequest(input);
        if (request.method !== 'GET' || options?.ignoreSearch || options?.ignoreMethod || options?.ignoreVary) throw new ResourceBlockedError(request.url);
        request.signal.throwIfAborted();
        for (const key of request.url === original.url ? [request] : [request, original]) {
          let response;
          try { response = await target.match(key); }
          catch { request.signal.throwIfAborted(); return undefined; }
          if (!response) continue;
          try { return await verifiedResponse(request, response); }
          catch {
            try { await target.delete(key); } catch { /* Never return corrupt bytes even when eviction fails. */ }
            request.signal.throwIfAborted();
            return undefined; // A miss can fall back only through the independently verified fetch.
          }
        }
        return undefined;
      };
      if (method === 'put') return async (input, response) => {
        const { request } = fileRequest(input);
        if (request.method !== 'GET') throw new ResourceBlockedError(request.url);
        const verified = await verifiedResponse(request, response.clone());
        request.signal.throwIfAborted();
        return target.put(request, verified);
      };
      if (['matchAll', 'add', 'addAll'].includes(method)) return () => Promise.reject(new ResourceBlockedError(String(method)));
      const value = Reflect.get(target, method, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  storage.open = async (name) => {
    const normalized = String(name);
    const cache = await open(normalized);
    return STORES.has(normalized) ? wrap(cache) : cache;
  };
  storage.match = async (input, options) => {
    const cacheName = options?.cacheName;
    const name = cacheName === undefined ? undefined : String(cacheName);
    if (STORES.has(name)) return (await storage.open(name)).match(input, options);
    if (name !== undefined) return storageMatch(input, { ...options, cacheName: name });
    if (!nativeRequestUrl) throw new ResourceBlockedError('Native Request unavailable');
    let url;
    try { url = nativeRequestUrl.call(input); } catch { url = String(input); }
    if (new URL(url, globalThis.location?.href).hostname !== 'huggingface.co') return storageMatch(input, options);
    const { request } = fileRequest(input);
    if (request.method !== 'GET' || options?.ignoreSearch || options?.ignoreMethod || options?.ignoreVary) throw new ResourceBlockedError(request.url);
    const response = await storageMatch(input);
    return response ? verifiedResponse(request, response) : undefined;
  };
  globalThis[CACHE_PINNED] = true;
}

export { rewriteHuggingFace as pinnedHuggingFaceUrl };

// Resources are admitted from the generated policy only: the owner's approval of the exact
// reviewed row, for local runtime. An installed package, cached response, local URL or blob does
// not change a resource's identity, and anything the policy does not admit stays blocked.
export function requireResource(id) {
  const resource = typeof id !== 'string'
    ? undefined
    : Object.hasOwn(policy, id) ? policy[id] : entryForUrl(id);
  if (!admitted(resource)) {
    throw new ResourceBlockedError(id);
  }
  return resource;
}

/** The revision the owner approved for a resource, for loaders that fetch by repository name. */
export function approvedRevision(id) {
  const { revision } = requireResource(id);
  if (typeof revision !== 'string' || !/^[a-f0-9]{40}$/.test(revision)) throw new ResourceBlockedError(id);
  return revision;
}

export async function verifyResourceBytes(id, bytes) {
  const expectedSha256 = approvedFile(id).sha256;
  // Copy before awaiting so caller mutation cannot race the digest check.
  const copy = new Uint8Array(bytes).slice();
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', copy))]
    .map((value) => value.toString(16).padStart(2, '0')).join('');
  if (hash !== expectedSha256) throw new ResourceBlockedError(id);
  return copy;
}

export function canUseResource(id) {
  try { requireResource(id); return true; }
  catch (error) { if (error instanceof ResourceBlockedError) return false; throw error; }
}
