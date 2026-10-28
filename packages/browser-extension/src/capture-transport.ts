import {
  appendCaptureUpload,
  cancelCaptureUpload,
  commitCapture,
  createCaptureUpload,
  getCaptureUpload,
  type CaptureCommitDto,
  type CaptureUploadStateDto,
  type CaptureResponseDto,
} from '@frameleaf/sdk';
import { boundOptions, CaptureFailure, type ServerBinding } from './api';
import type { CaptureTask, CaptureReceipt } from './queue';
import { MAX_CAPTURE_BYTES } from './acquisition';
const uuid4 =
  /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const uuid =
  /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
export const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
export type DeliveryFailureKind =
  | 'authorization'
  | 'missing'
  | 'attention'
  | 'permanent'
  | 'retry'
  | 'cancelled';
const messages: Record<DeliveryFailureKind, string> = {
  authorization:
    'Reconnect to the original server with an authorized capture key.',
  missing:
    'This capture resource is unavailable. Check the original key and server outcome.',
  attention:
    'This capture needs attention. Check its original key, destination, server space or unfinished upload.',
  permanent:
    'The server refused this capture. Review its file size, format and destination.',
  retry:
    'The server is temporarily unavailable. This capture can retry safely.',
  cancelled: 'Capture delivery stopped. Its persisted state is retained.',
};
export class DeliveryFailure extends CaptureFailure {
  constructor(
    readonly kind: DeliveryFailureKind,
    readonly status = 0,
    readonly retryAt?: number,
  ) {
    super(kind === 'authorization' ? 'authorization' : 'connection');
    this.message = messages[kind];
  }
}
export function retryAfterAt(
  value: string | null,
  now = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const when = /^\d+$/.test(value)
    ? now + Number(value) * 1000
    : Date.parse(value);
  return Number.isSafeInteger(when) &&
    Number.isFinite(new Date(when).getTime()) &&
    when >= now
    ? when
    : undefined;
}
function statusFailure(response: Response): DeliveryFailure | undefined {
  const status = response.status;
  if (
    status >= 200 &&
    status < 300 &&
    !response.redirected &&
    response.type !== 'opaqueredirect'
  )
    return;
  const kind: DeliveryFailureKind =
    response.redirected ||
    response.type === 'opaqueredirect' ||
    (status >= 300 && status < 400)
      ? 'attention'
      : status === 401 || status === 403
        ? 'authorization'
        : status === 404
          ? 'missing'
          : [409, 410, 412, 422, 507].includes(status)
            ? 'attention'
            : status === 408 ||
                status === 425 ||
                status === 429 ||
                status >= 500
              ? 'retry'
              : 'permanent';
  return new DeliveryFailure(
    kind,
    status,
    kind === 'retry'
      ? retryAfterAt(response.headers.get('retry-after'))
      : undefined,
  );
}
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
function fileFor(task: CaptureTask) {
  const file = task.file;
  if (
    !file ||
    !uuid4.test(task.id) ||
    task.id !== task.captureId ||
    !Number.isSafeInteger(file.size) ||
    file.size < 1 ||
    file.size > MAX_CAPTURE_BYTES ||
    !/^[a-f0-9]{64}$/.test(file.sha256) ||
    !file.filename ||
    file.filename.length > 255 ||
    /[/\\\u0000-\u001f]/.test(file.filename)
  )
    throw new DeliveryFailure('permanent');
  return file;
}
function checkedState(
  state: CaptureUploadStateDto,
  task: CaptureTask,
): CaptureUploadStateDto {
  const file = fileFor(task);
  if (
    !state ||
    state.id !== task.captureId ||
    !Number.isSafeInteger(state.offset) ||
    state.offset < 0 ||
    state.offset > file.size ||
    typeof state.ready !== 'boolean' ||
    (state.ready && state.offset !== file.size) ||
    typeof state.expiresAt !== 'string' ||
    state.expiresAt.length > 64 ||
    !Number.isFinite(Date.parse(state.expiresAt))
  )
    throw new DeliveryFailure('attention');
  return {
    id: state.id,
    offset: state.offset,
    ready: state.ready,
    expiresAt: state.expiresAt,
  };
}
function checkedReceipt(
  value: CaptureResponseDto,
  task: CaptureTask,
): CaptureReceipt {
  if (
    !value ||
    value.captureId !== task.captureId ||
    !['created', 'duplicate'].includes(value.status)
  )
    throw new DeliveryFailure('attention');
  const expected = task.file ? 'asset' : 'bookmark';
  if (value.item?.kind !== expected) throw new DeliveryFailure('attention');
  const itemId =
    value.item.kind === 'asset'
      ? value.item.asset?.id
      : value.item.bookmark?.id;
  if (typeof itemId !== 'string' || !uuid.test(itemId))
    throw new DeliveryFailure('attention');
  return {
    captureId: value.captureId,
    status: value.status,
    kind: expected,
    itemId,
  };
}

export function createCaptureTransport(
  binding: ServerBinding,
  token: string,
  options: { fetch?: typeof fetch; signal?: AbortSignal } = {},
) {
  const transport = options.fetch ?? globalThis.fetch.bind(globalThis);
  const classifiedFetch: typeof fetch = async (input, init) => {
    try {
      if (options.signal?.aborted) throw new DeliveryFailure('cancelled');
      const signal = options.signal
        ? AbortSignal.any([
            ...(init?.signal ? [init.signal] : []),
            options.signal,
          ])
        : init?.signal;
      const response = await transport(input, { ...init, signal });
      const failure = statusFailure(response);
      if (failure) {
        await response.body?.cancel();
        throw failure;
      }
      return response;
    } catch (error) {
      if (options.signal?.aborted) throw new DeliveryFailure('cancelled');
      throw error instanceof CaptureFailure
        ? error
        : new DeliveryFailure('retry');
    }
  };
  const guard = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (options.signal?.aborted) throw new DeliveryFailure('cancelled');
      if (
        error instanceof CaptureFailure &&
        !(error instanceof DeliveryFailure) &&
        error.code === 'connection'
      )
        throw new DeliveryFailure('retry');
      throw error instanceof CaptureFailure
        ? error
        : new DeliveryFailure('attention');
    }
  };
  const requestOptions = async (task: CaptureTask) => {
    if (
      task.binding.serverId !== binding.serverId ||
      task.binding.userId !== binding.userId ||
      task.binding.origin !== binding.origin ||
      !uuid4.test(task.captureId) ||
      task.id !== task.captureId
    )
      throw new DeliveryFailure('attention');
    return boundOptions(binding, token, classifiedFetch);
  };
  return {
    getUpload: (task: CaptureTask) =>
      guard(async () =>
        checkedState(
          await getCaptureUpload(
            { id: task.captureId },
            await requestOptions(task),
          ),
          task,
        ),
      ),
    createUpload: (task: CaptureTask) =>
      guard(async () => {
        const file = fileFor(task);
        const metadata = {
          publication: 'capture',
          captureId: task.captureId,
          libraryScope: 'design',
          filename: file.filename,
          fileCreatedAt: task.source.capturedAt,
          fileModifiedAt: task.source.capturedAt,
        };
        const assetMetadata = base64(
          new TextEncoder().encode(JSON.stringify(metadata)),
        )
          .replaceAll('+', '-')
          .replaceAll('/', '_')
          .replace(/=+$/, '');
        const digest = base64(
          Uint8Array.from(file.sha256.match(/../g)!, (byte) =>
            Number.parseInt(byte, 16),
          ),
        );
        const type = /^(image|video|audio)\/[a-z0-9.+-]+$/i.test(file.type)
          ? file.type
          : 'image/unknown';
        const opts = await requestOptions(task);
        return checkedState(
          await createCaptureUpload(
            { body: new Blob([]) },
            {
              ...opts,
              headers: {
                ...opts.headers,
                'Content-Type': type,
                'Asset-Metadata': assetMetadata,
                'Repr-Digest': `sha-256=:${digest}:`,
                'Upload-Length': String(file.size),
                'Upload-Complete': '?0',
                'Upload-Draft-Interop-Version': '9',
              },
            },
          ),
          task,
        );
      }),
    appendUpload: (task: CaptureTask, blob: Blob, offset: number) =>
      guard(async () => {
        const file = fileFor(task);
        if (
          blob.size !== file.size ||
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          offset > file.size
        )
          throw new DeliveryFailure('permanent');
        const body = blob.slice(
          offset,
          Math.min(file.size, offset + UPLOAD_CHUNK_BYTES),
        );
        const opts = await requestOptions(task);
        return checkedState(
          await appendCaptureUpload(
            { id: task.captureId, body },
            {
              ...opts,
              headers: {
                ...opts.headers,
                'Content-Type': 'application/partial-upload',
                'Upload-Draft-Interop-Version': '9',
                'Upload-Offset': String(offset),
                'Upload-Length': String(file.size),
                'Upload-Complete':
                  offset + body.size === file.size ? '?1' : '?0',
              },
            },
          ),
          task,
        );
      }),
    commit: (task: CaptureTask) =>
      guard(async () => {
        if (
          task.state !== 'committing' ||
          task.phase !== 'commit' ||
          task.offset !== (task.file?.size ?? 0)
        )
          throw new DeliveryFailure('attention');
        const captureCommitDto: CaptureCommitDto = {
          captureId: task.captureId,
          albumId: task.albumId,
          tagIds: task.tagIds,
          source: task.source,
          ...(task.note !== undefined && { note: task.note }),
          ...(task.file
            ? { uploadResourceId: task.captureId, sha256: fileFor(task).sha256 }
            : { bookmark: task.bookmark }),
        };
        return checkedReceipt(
          await commitCapture({ captureCommitDto }, await requestOptions(task)),
          task,
        );
      }),
    cancelUpload: (task: CaptureTask) =>
      guard(async () => {
        fileFor(task);
        await cancelCaptureUpload(
          { id: task.captureId },
          await requestOptions(task),
        );
      }),
  };
}
export type CaptureTransport = ReturnType<typeof createCaptureTransport>;
