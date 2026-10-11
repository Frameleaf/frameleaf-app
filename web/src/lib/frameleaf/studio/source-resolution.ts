import type { StudioSourceResolutionDto, StudioSourceResolutionRequestDto } from '@frameleaf/sdk';
import { isStudioSourceRequest } from './frame-service-schema';
import type { StudioEditorScope, StudioProjectHandle } from './host-contract';

export interface StudioSourceAuthority {
  userId: string;
  project: StudioProjectHandle;
  sourceEpoch: number;
  generation: number;
  online: boolean;
  eligible: boolean;
}

/** Stable JSON, including every manifest field and preserving ordered arrays. */
export const studioSourceJson = (value: unknown): string =>
  JSON.stringify(value, (_key, entry: unknown) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : entry,
  );
const refuse = (): never => {
  throw new Error('STUDIO_SOURCE_REFUSED');
};
const keys = (value: unknown, fields: string[]): value is Record<string, unknown> =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === fields.length &&
  fields.every((key) => Object.hasOwn(value, key));
const hex = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const path = (value: unknown) =>
  typeof value === 'string' &&
  value.length <= 1024 &&
  value.length > 0 &&
  !/^(?:\/)|\\|\/\/|(?:^|\/)\.\.?(?:\/|$)|[\u0000-\u001f\u007f]/.test(value);
const canonicalBase64 = (value: unknown): value is string => {
  if (
    typeof value !== 'string' ||
    value.length > 24 * 1024 * 1024 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  )
    return false;
  return value.endsWith('==')
    ? /[AQgw]/.test(value.at(-3) ?? '')
    : !value.endsWith('=') || /[AEIMQUYcgkosw048]/.test(value.at(-2) ?? '');
};
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export const studioSourceSha = async (bytes: Uint8Array): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

/** Decode directly into the registered buffer; atob's full additional string is avoided. */
const decode = (text: string, bytes: Uint8Array) => {
  let offset = 0;
  for (let i = 0; i < text.length; i += 4) {
    const packed =
      (alphabet.indexOf(text[i]) << 18) |
      (alphabet.indexOf(text[i + 1]) << 12) |
      ((text[i + 2] === '=' ? 0 : alphabet.indexOf(text[i + 2])) << 6) |
      (text[i + 3] === '=' ? 0 : alphabet.indexOf(text[i + 3]));
    if (offset < bytes.length) bytes[offset++] = packed >>> 16;
    if (offset < bytes.length) bytes[offset++] = packed >>> 8;
    if (offset < bytes.length) bytes[offset++] = packed;
  }
};

/** The caller owns returned bytes and must zero them, including when its parser refuses. */
export async function verifyStudioSourceResult(
  result: StudioSourceResolutionDto,
  request: StudioSourceResolutionRequestDto,
  projectId: string,
  check: () => void,
  owned: Uint8Array[],
  now: () => number = Date.now,
): Promise<{ files: Record<string, Uint8Array>; decoded: number; encoded: number }> {
  check();
  if (
    !keys(result, [
      'projectId',
      'revision',
      'graphDigest',
      'manifestDigest',
      'parent',
      'expiresAt',
      'archive',
      'files',
      'selection',
    ]) ||
    !isStudioSourceRequest({
      revision: result.revision,
      graphDigest: result.graphDigest,
      parent: result.parent,
      selection: result.selection,
    }) ||
    result.projectId !== projectId ||
    result.revision !== request.revision ||
    result.graphDigest !== request.graphDigest ||
    studioSourceJson(result.parent) !== studioSourceJson(request.parent) ||
    studioSourceJson(result.selection) !== studioSourceJson(request.selection) ||
    !hex(result.manifestDigest) ||
    typeof result.archive !== 'boolean' ||
    typeof result.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(result.expiresAt)) ||
    Date.parse(result.expiresAt) <= now() ||
    Date.parse(result.expiresAt) > now() + 5000 ||
    !Array.isArray(result.files) ||
    result.files.length < 1 ||
    result.files.length > 256
  )
    refuse();
  let decoded = 0;
  let encoded = 0;
  const names = new Set<string>();
  const lengths: number[] = [];
  for (const file of result.files) {
    if (
      !keys(file, ['path', 'sha256', 'base64']) ||
      !path(file.path) ||
      names.has(file.path) ||
      !hex(file.sha256) ||
      !canonicalBase64(file.base64)
    )
      refuse();
    names.add(file.path);
    encoded += file.base64.length;
    const length = (file.base64.length / 4) * 3 - (file.base64.endsWith('==') ? 2 : file.base64.endsWith('=') ? 1 : 0);
    decoded += length;
    lengths.push(length);
  }
  // Include the incoming UTF16 snapshot, decoded buffers, digest/ZIP working space and Blob copies.
  if (
    encoded > 24 * 1024 * 1024 ||
    decoded > 16 * 1024 * 1024 ||
    encoded * 2 + decoded * 4 + result.files.length * 16 * 1024 > 32 * 1024 * 1024
  )
    refuse();
  const { manifestDigest: _digest, files: _files, ...metadata } = result;
  const manifest = new TextEncoder().encode(
    studioSourceJson({ ...metadata, files: result.files.map(({ path, sha256 }) => ({ path, sha256 })) }),
  );
  owned.push(manifest);
  const actual = await studioSourceSha(manifest);
  check();
  if (actual !== result.manifestDigest) refuse();
  const files: Record<string, Uint8Array> = Object.create(null);
  for (const [i, file] of result.files.entries()) {
    check();
    const bytes = new Uint8Array(lengths[i]);
    owned.push(bytes);
    decode(file.base64, bytes);
    const checksum = await studioSourceSha(bytes);
    check();
    if (checksum !== file.sha256) refuse();
    files[file.path] = bytes;
  }
  check();
  return { files, decoded, encoded };
}

export function createStudioSourceResolution(options: {
  authority(): StudioSourceAuthority;
  resolve(
    id: string,
    request: StudioSourceResolutionRequestDto,
    signal: AbortSignal,
  ): Promise<StudioSourceResolutionDto>;
  signal: AbortSignal;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  return async (
    request: StudioSourceResolutionRequestDto,
    scope: StudioEditorScope,
  ): Promise<StudioSourceResolutionDto> => {
    const initial = options.authority();
    const identity = studioSourceJson(initial);
    const check = () => {
      options.signal.throwIfAborted();
      const live = options.authority();
      if (
        !live.eligible ||
        !live.online ||
        !live.project.hasLease ||
        !live.project.graphDigest ||
        !live.project.leaseExpiresAt ||
        Date.parse(live.project.leaseExpiresAt) <= now() ||
        !Number.isFinite(Date.parse(live.project.leaseExpiresAt)) ||
        identity !== studioSourceJson(live)
      )
        refuse();
    };
    check();
    if (
      !isStudioSourceRequest(request) ||
      request.revision !== initial.project.revision ||
      request.graphDigest !== initial.project.graphDigest ||
      scope.userId !== initial.userId ||
      scope.projectId !== initial.project.id ||
      scope.graphVersion !== (initial.project.graphVersion ?? 0)
    )
      refuse();
    const result = await options.resolve(initial.project.id, request, options.signal);
    const owned: Uint8Array[] = [];
    try {
      check();
      const current = () => {
        check();
        if (Date.parse(result.expiresAt) <= now()) refuse();
      };
      await verifyStudioSourceResult(result, request, initial.project.id, current, owned, now);
      current();
      return result;
    } finally {
      for (const bytes of owned) bytes.fill(0);
    }
  };
}
