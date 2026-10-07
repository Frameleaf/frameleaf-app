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
if (typeof globalThis.fetch === 'function' && !globalThis[PINNED]) {
  const original = globalThis.fetch;
  globalThis.fetch = function pinnedFetch(input, init) {
    let requestUrl;
    try {
      requestUrl = Object.getOwnPropertyDescriptor(Request.prototype, 'url').get.call(input);
    } catch { /* Non-Requests use native fetch's string input form, regardless of realm. */ }
    let normalized;
    try { normalized = requestUrl ?? String(input); }
    catch (error) { return Promise.reject(error); }
    let destination;
    try {
      destination = new URL(normalized, globalThis.location?.href);
    } catch { /* Invalid inputs retain native fetch handling. */ }
    if (destination?.hostname.replace(/\.$/, '') === 'huggingface.co') {
      let request;
      try { request = new Request(requestUrl === undefined ? normalized : input, init); }
      catch { return Promise.reject(new ResourceBlockedError(destination.origin + destination.pathname)); }
      if ((request.method !== 'GET' && request.method !== 'HEAD') || request.body !== null) {
        return Promise.reject(new ResourceBlockedError(destination.origin + destination.pathname));
      }
      // Forward only the checked native state; caller accessors are never evaluated again.
      const target = rewriteHuggingFace(request.url);
      return original.call(globalThis, target === request.url ? request : new Request(target, request));
    }
    return original.call(globalThis, requestUrl === undefined ? normalized : input, init);
  };
  globalThis[PINNED] = true;
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
  const resource = requireResource(id);
  // Model IDs and locator roots cannot borrow a file's hash. Resolve exactly one URL through
  // the most-specific admitted row; blocked overlapping rows still refuse it in requireResource.
  const file = typeof id === 'string' && Object.hasOwn(resource.files ?? {}, id) ? resource.files[id] : undefined;
  if (!file || file.url !== id || file.approvalSha256 !== resource.approvalSha256
    || file.revision !== resource.revision || !/^[a-f0-9]{40}$/.test(file.revision ?? '')
    || !/^[a-f0-9]{64}$/.test(file.sha256 ?? '')) throw new ResourceBlockedError(id);
  const expectedSha256 = file.sha256;
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
