import policy from './resource-policy.json' with { type: 'json' };

export class ResourceBlockedError extends Error {
  constructor(id) {
    super(`FRAMELEAF_RESOURCE_BLOCKED: ${id}`);
    this.name = 'ResourceBlockedError';
    this.code = 'FRAMELEAF_RESOURCE_BLOCKED';
  }
}

// The production generator admits no current resource. An installed package,
// cached response, local URL or blob does not change the resource's identity.
export function requireResource(id) {
  const resource = Object.hasOwn(policy, id) ? policy[id] : undefined;
  if (resource?.localRuntime !== 'allowed' || !/^[a-f0-9]{64}$/.test(resource.sha256 ?? '')) {
    throw new ResourceBlockedError(id);
  }
  return resource;
}

export async function verifyResourceBytes(id, bytes) {
  const resource = requireResource(id);
  // Copy before awaiting so caller mutation cannot race the digest check.
  const copy = new Uint8Array(bytes).slice();
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', copy))]
    .map((value) => value.toString(16).padStart(2, '0')).join('');
  if (hash !== resource.sha256) throw new ResourceBlockedError(id);
  return copy;
}

export function canUseResource(id) {
  try { requireResource(id); return true; }
  catch (error) { if (error instanceof ResourceBlockedError) return false; throw error; }
}
