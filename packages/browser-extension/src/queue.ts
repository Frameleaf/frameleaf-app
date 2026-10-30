import type { CaptureCommitDto } from '@frameleaf/sdk';
import { normalizeServerAddress, type ServerBinding } from './api';
import { MAX_CAPTURE_BYTES } from './acquisition';
import { sanitizeSourceUrl } from './source-url';

export const CLAIM_MS = 60_000;
const MAX_QUEUE_BYTES = 512 * 1024 * 1024;
const databaseName = 'frameleaf-captures-v1';
const uuid4 =
  /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const uuid =
  /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
export type CaptureState =
  | 'queued'
  | 'uploading'
  | 'committing'
  | 'saved'
  | 'duplicate'
  | 'failed'
  | 'needs-attention'
  | 'cancelled';
export interface CaptureReceipt {
  captureId: string;
  status: 'created' | 'duplicate';
  kind: 'asset' | 'bookmark';
  itemId: string;
}
export interface CaptureTask {
  version: 1;
  id: string;
  captureId: string;
  binding: ServerBinding;
  albumId: string;
  tagIds: string[];
  source: CaptureCommitDto['source'];
  note?: string;
  bookmark?: CaptureCommitDto['bookmark'];
  file?: { filename: string; size: number; type: string; sha256: string };
  state: CaptureState;
  phase: 'upload' | 'commit';
  offset: number;
  attempts: number;
  retryAt?: number;
  error?: string;
  claim?: { owner: string; expiresAt: number };
  receipt?: CaptureReceipt;
  cancelRequested?: true;
  cancellationReceipt?: { captureId: string; status: 'cancelled' };
  createdAt: number;
  updatedAt: number;
}
export type EnqueueCapture = Pick<
  CaptureTask,
  'binding' | 'albumId' | 'source' | 'note'
> & {
  tagIds?: string[];
  file?: { blob: Blob; filename: string };
  bookmark?: CaptureCommitDto['bookmark'];
};
export class QueueFailure extends Error {
  constructor(
    message: string,
    readonly code: 'storage' | 'claim' | 'cancel' = 'storage',
  ) {
    super(message);
  }
}
export const CANCELLATION_PENDING =
  'Cancelling… waiting for your server to confirm.';
export type CaptureCancellation =
  | { captureId: string; status: 'cancelled' }
  | { captureId: string; status: 'already-published'; receipt: CaptureReceipt };
const invalid = () =>
  new QueueFailure(
    'This item’s details are damaged. Check its collection and source before trying again.',
  );
const damaged = () =>
  new QueueFailure(
    'Could not read the capture queue. Browser storage may be unavailable or damaged.',
  );
const claimLost = () =>
  new QueueFailure(
    'This capture claim expired or moved to another worker.',
    'claim',
  );
const sameDestination = (a: ServerBinding, b: ServerBinding) =>
  a.serverId === b.serverId && a.userId === b.userId && a.origin === b.origin;
const request = <T>(value: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error);
  });
async function openQueue(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') throw damaged();
  const opening = indexedDB.open(databaseName, 1);
  opening.onupgradeneeded = () => {
    opening.result.createObjectStore('tasks', { keyPath: 'id' });
    opening.result.createObjectStore('blobs', { keyPath: 'id' });
    opening.result.createObjectStore('meta').put(0, 'bytes');
  };
  return new Promise((resolve, reject) => {
    let settled = false;
    const stop = () => {
      settled = true;
      clearTimeout(timeout);
      reject(damaged());
    };
    const timeout = setTimeout(stop, 5000);
    opening.onblocked = stop;
    opening.onerror = stop;
    opening.onsuccess = () => {
      clearTimeout(timeout);
      if (settled) opening.result.close();
      else {
        settled = true;
        resolve(opening.result);
      }
    };
  });
}
async function transaction<T>(
  stores: string[],
  mode: IDBTransactionMode,
  operation: (tx: IDBTransaction) => Promise<T>,
): Promise<T> {
  let database: IDBDatabase | undefined;
  try {
    database = await openQueue();
    database.onversionchange = () => database?.close();
    const tx = database.transaction(stores, mode, {
      durability: mode === 'readwrite' ? 'strict' : 'default',
    });
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? damaged());
      tx.onerror = () => {};
    });
    try {
      // Only IDB requests may be awaited here; hashing/quota checks happen before this transaction.
      const result = await operation(tx);
      await done;
      return result;
    } catch (error) {
      try {
        tx.abort();
      } catch {}
      await done.catch(() => {});
      throw error;
    }
  } catch (error) {
    if (error instanceof QueueFailure) throw error;
    if (error instanceof DOMException && error.name === 'QuotaExceededError')
      throw new QueueFailure(
        'Browser storage has no space for this capture. Free space and try again.',
      );
    throw damaged();
  } finally {
    database?.close();
  }
}
function bindingCopy(value: ServerBinding): ServerBinding {
  if (
    !value ||
    typeof value.serverId !== 'string' ||
    !value.serverId ||
    value.serverId.length > 256 ||
    !uuid4.test(value.userId) ||
    !uuid4.test(value.credentialId) ||
    normalizeServerAddress(value.origin, true) !== value.origin
  )
    throw invalid();
  return {
    serverId: value.serverId,
    userId: value.userId,
    origin: value.origin,
    credentialId: value.credentialId,
  };
}
function cleanUrl(raw: string): string {
  if (typeof raw !== 'string' || raw.length > 8192) throw invalid();
  const url = sanitizeSourceUrl(raw);
  if (!url) throw invalid();
  return url;
}
function targetUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (
      raw.length > 8192 ||
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw invalid();
    return url.href;
  } catch {
    throw invalid();
  }
}
function sourceCopy(
  source: CaptureCommitDto['source'],
): CaptureCommitDto['source'] {
  if (
    !source ||
    typeof source.title !== 'string' ||
    source.title.length > 2000 ||
    typeof source.capturedAt !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:\d\d)$/.test(
      source.capturedAt,
    ) ||
    !Number.isFinite(Date.parse(source.capturedAt))
  )
    throw invalid();
  for (const value of [source.creator])
    if (
      value !== undefined &&
      value !== null &&
      (typeof value !== 'string' || value.length > 2000)
    )
      throw invalid();
  return {
    pageUrl: cleanUrl(source.pageUrl),
    title: source.title,
    // Kept as written: its UTC offset is the zone the item was saved in (FL-698).
    capturedAt: source.capturedAt,
    ...(source.mediaUrl != null && { mediaUrl: cleanUrl(source.mediaUrl) }),
    ...(source.licenseUrl != null && {
      licenseUrl: cleanUrl(source.licenseUrl),
    }),
    ...(source.creator != null && { creator: source.creator }),
  };
}
export function assertQueueCapacity(used: number, added: number) {
  if (
    !Number.isSafeInteger(used) ||
    used < 0 ||
    !Number.isSafeInteger(added) ||
    added < 0
  )
    throw damaged();
  if (added > MAX_CAPTURE_BYTES)
    throw new QueueFailure('Each image can be up to 100 MB.');
  if (used + added > MAX_QUEUE_BYTES)
    throw new QueueFailure(
      'The saving list is full (512 MB). Wait for items to finish, or cancel some, then try again.',
    );
}
async function storedBytes(tx: IDBTransaction): Promise<number> {
  const value = await request(tx.objectStore('meta').get('bytes'));
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_QUEUE_BYTES)
    throw damaged();
  return value;
}
function validReceipt(
  receipt: CaptureReceipt | undefined,
  id: string,
  kind: 'asset' | 'bookmark',
): boolean {
  return (
    !!receipt &&
    receipt.captureId === id &&
    ['created', 'duplicate'].includes(receipt.status) &&
    receipt.kind === kind &&
    uuid.test(receipt.itemId)
  );
}
function checkTask(task: CaptureTask): CaptureTask {
  try {
    if (
      task?.version !== 1 ||
      !uuid4.test(task.id) ||
      task.id !== task.captureId ||
      !uuid4.test(task.albumId) ||
      !Array.isArray(task.tagIds) ||
      task.tagIds.some((id) => !uuid4.test(id)) ||
      ![
        'queued',
        'uploading',
        'committing',
        'saved',
        'duplicate',
        'failed',
        'needs-attention',
        'cancelled',
      ].includes(task.state) ||
      !['upload', 'commit'].includes(task.phase) ||
      !Number.isSafeInteger(task.offset) ||
      task.offset < 0 ||
      !Number.isSafeInteger(task.attempts) ||
      task.attempts < 0 ||
      Boolean(task.file) === Boolean(task.bookmark)
    )
      throw damaged();
    if (['saved', 'duplicate'].includes(task.state)) {
      if (
        !validReceipt(
          task.receipt,
          task.id,
          task.file ? 'asset' : 'bookmark',
        ) ||
        task.receipt!.status !==
          (task.state === 'saved' ? 'created' : 'duplicate') ||
        task.phase !== 'commit' ||
        task.offset !== (task.file?.size ?? 0) ||
        task.claim
      )
        throw damaged();
    } else if (task.receipt !== undefined) throw damaged();
    if (task.cancelRequested !== undefined && task.cancelRequested !== true)
      throw damaged();
    if (
      task.cancelRequested &&
      ['saved', 'duplicate', 'cancelled'].includes(task.state)
    )
      throw damaged();
    if (task.state === 'cancelled') {
      const proof = task.cancellationReceipt;
      if (
        task.claim ||
        (task.attempts > 0 && !proof) ||
        (proof !== undefined &&
          (!proof ||
            proof.captureId !== task.id ||
            proof.status !== 'cancelled'))
      )
        throw damaged();
    } else if (task.cancellationReceipt !== undefined) throw damaged();
    bindingCopy(task.binding);
    sourceCopy(task.source);
    if (
      task.file &&
      (!/^[a-f0-9]{64}$/.test(task.file.sha256) ||
        !Number.isSafeInteger(task.file.size) ||
        task.file.size < 1 ||
        task.file.size > MAX_CAPTURE_BYTES ||
        task.offset > task.file.size)
    )
      throw damaged();
    if (
      task.claim &&
      (typeof task.claim.owner !== 'string' ||
        !Number.isFinite(task.claim.expiresAt))
    )
      throw damaged();
    return task;
  } catch {
    throw damaged();
  }
}
async function allTasks(tx: IDBTransaction): Promise<CaptureTask[]> {
  return (await request(tx.objectStore('tasks').getAll())).map(checkTask);
}
async function pruneHistory(tx: IDBTransaction, binding: ServerBinding) {
  const completed = (await allTasks(tx))
    .filter(
      (task) =>
        sameDestination(task.binding, binding) &&
        ['saved', 'duplicate', 'cancelled'].includes(task.state),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  let retained = 0;
  for (const task of completed) {
    // Preserve metadata whenever original bytes remain, even for damaged history.
    if (await request(tx.objectStore('blobs').getKey(task.id))) continue;
    if (++retained > 200)
      await request(tx.objectStore('tasks').delete(task.id));
  }
}
export const pruneCaptureHistory = (binding: ServerBinding): Promise<void> =>
  transaction(['tasks', 'blobs'], 'readwrite', (tx) =>
    pruneHistory(tx, binding),
  );
async function ownedTask(
  tx: IDBTransaction,
  id: string,
  owner: string,
  now: number,
): Promise<CaptureTask> {
  const task = checkTask(await request(tx.objectStore('tasks').get(id)));
  if (task.claim?.owner !== owner || task.claim.expiresAt <= now)
    throw claimLost();
  return task;
}
export async function enqueueCapture(
  input: EnqueueCapture,
): Promise<CaptureTask> {
  const file = input.file && {
    blob: input.file.blob,
    filename: input.file.filename,
  };
  if (file && !(file.blob instanceof Blob)) throw invalid();
  const binding = bindingCopy(input.binding);
  const source = sourceCopy(input.source);
  const tagIds = [...new Set(input.tagIds ?? [])];
  if (
    !uuid4.test(input.albumId) ||
    tagIds.length > 500 ||
    tagIds.some((id) => !uuid4.test(id)) ||
    (input.note !== undefined &&
      (typeof input.note !== 'string' || input.note.length > 20000)) ||
    Boolean(file) === Boolean(input.bookmark)
  )
    throw invalid();
  const size = file?.blob.size ?? 0;
  assertQueueCapacity(0, size);
  if (
    file &&
    (!(file.blob instanceof Blob) ||
      !size ||
      typeof file.filename !== 'string' ||
      !file.filename ||
      file.filename.length > 255 ||
      /[/\\\u0000-\u001f]/.test(file.filename))
  )
    throw invalid();
  if (
    input.bookmark &&
    (typeof input.bookmark.title !== 'string' ||
      input.bookmark.title.length > 2000)
  )
    throw invalid();
  const id = crypto.randomUUID();
  const now = Date.now();
  const task: CaptureTask = {
    version: 1,
    id,
    captureId: id,
    binding,
    albumId: input.albumId,
    tagIds,
    source,
    ...(input.note !== undefined && { note: input.note }),
    state: 'queued',
    phase: file ? 'upload' : 'commit',
    offset: 0,
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  };
  if (input.bookmark)
    task.bookmark = {
      url: targetUrl(input.bookmark.url),
      title: input.bookmark.title,
    };
  if (file) {
    const digest = await crypto.subtle.digest(
      'SHA-256',
      await file.blob.arrayBuffer(),
    );
    task.file = {
      filename: file.filename,
      size,
      type: file.blob.type,
      sha256: [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join(''),
    };
  }
  const estimate = await navigator.storage?.estimate?.();
  if (
    estimate?.quota !== undefined &&
    estimate.usage !== undefined &&
    size > Math.max(0, estimate.quota - estimate.usage)
  )
    throw new QueueFailure(
      'Browser storage has no space for this capture. Free space and try again.',
    );
  await transaction(['tasks', 'blobs', 'meta'], 'readwrite', async (tx) => {
    const used = await storedBytes(tx);
    assertQueueCapacity(used, size);
    await request(tx.objectStore('tasks').add(task));
    if (file)
      await request(tx.objectStore('blobs').add({ id, blob: file.blob }));
    await request(tx.objectStore('meta').put(used + size, 'bytes'));
  });
  return task;
}
export const listCaptures = (binding: ServerBinding): Promise<CaptureTask[]> =>
  transaction(['tasks'], 'readonly', async (tx) =>
    (await allTasks(tx))
      .filter((task) => sameDestination(task.binding, binding))
      .sort((a, b) => b.createdAt - a.createdAt),
  );
export const captureBlob = (id: string): Promise<Blob | null> =>
  transaction(
    ['blobs'],
    'readonly',
    async (tx) =>
      (await request(tx.objectStore('blobs').get(id)))?.blob ?? null,
  );
export async function claimCapture(
  binding: ServerBinding,
  owner: string,
  now = Date.now(),
): Promise<CaptureTask | null> {
  if (!owner || owner.length > 256) throw invalid();
  return transaction(['tasks', 'blobs'], 'readwrite', async (tx) => {
    const tasks = await allTasks(tx);
    if (
      tasks.filter((task) => task.claim && task.claim.expiresAt > now).length >=
      2
    )
      return null;
    for (const task of tasks.sort((a, b) => a.createdAt - b.createdAt)) {
      if (
        !sameDestination(task.binding, binding) ||
        !['queued', 'uploading', 'committing'].includes(task.state) ||
        (task.retryAt ?? 0) > now ||
        (task.claim?.expiresAt ?? 0) > now
      )
        continue;
      if (task.file && task.phase === 'upload' && !task.cancelRequested) {
        const stored = await request(tx.objectStore('blobs').get(task.id));
        if (
          !(stored?.blob instanceof Blob) ||
          stored.blob.size !== task.file.size
        ) {
          task.state = 'needs-attention';
          task.error =
            'The image kept in this browser is missing. Save it again from the page.';
          delete task.claim;
          await request(tx.objectStore('tasks').put(task));
          continue;
        }
      }
      task.state = task.phase === 'upload' ? 'uploading' : 'committing';
      task.attempts++;
      task.claim = { owner, expiresAt: now + CLAIM_MS };
      task.updatedAt = now;
      delete task.error;
      delete task.retryAt;
      await request(tx.objectStore('tasks').put(task));
      return task;
    }
    return null;
  });
}
export const saveCaptureProgress = (
  id: string,
  owner: string,
  progress: { state: 'uploading' | 'committing'; offset: number },
  now = Date.now(),
): Promise<CaptureTask> =>
  transaction(['tasks'], 'readwrite', async (tx) => {
    const task = await ownedTask(tx, id, owner, now);
    if (task.cancelRequested)
      throw new QueueFailure(CANCELLATION_PENDING, 'cancel');
    if (
      !['uploading', 'committing'].includes(progress.state) ||
      !Number.isSafeInteger(progress.offset) ||
      progress.offset < task.offset ||
      progress.offset > (task.file?.size ?? 0) ||
      (task.phase === 'commit' && progress.state !== 'committing')
    )
      throw invalid();
    task.state = progress.state;
    task.phase = progress.state === 'committing' ? 'commit' : 'upload';
    task.offset = progress.offset;
    task.updatedAt = now;
    task.claim!.expiresAt = now + CLAIM_MS;
    await request(tx.objectStore('tasks').put(task));
    return task;
  });
export const deferCapture = (
  id: string,
  owner: string,
  problem: {
    kind: 'retry' | 'attention' | 'failed';
    retryAt?: number;
    message: string;
  },
  now = Date.now(),
): Promise<void> =>
  transaction(['tasks'], 'readwrite', async (tx) => {
    const task = await ownedTask(tx, id, owner, now);
    if (
      !['retry', 'attention', 'failed'].includes(problem.kind) ||
      typeof problem.message !== 'string' ||
      problem.message.length > 1000 ||
      (problem.kind === 'retry' && !Number.isSafeInteger(problem.retryAt))
    )
      throw invalid();
    if (problem.kind !== 'retry')
      task.state = problem.kind === 'attention' ? 'needs-attention' : 'failed';
    task.error = problem.message;
    task.updatedAt = now;
    delete task.claim;
    if (problem.kind === 'retry')
      task.retryAt = Math.max(now + 5000, problem.retryAt!);
    await request(tx.objectStore('tasks').put(task));
  });
export const retryCapture = (
  id: string,
  binding: ServerBinding,
  now = Date.now(),
): Promise<void> =>
  transaction(['tasks'], 'readwrite', async (tx) => {
    const task = checkTask(await request(tx.objectStore('tasks').get(id)));
    if (
      !sameDestination(task.binding, binding) ||
      ['saved', 'duplicate', 'cancelled'].includes(task.state) ||
      (task.claim?.expiresAt ?? 0) > now
    )
      throw invalid();
    task.state = 'queued';
    task.retryAt = now;
    task.updatedAt = now;
    delete task.error;
    delete task.claim;
    await request(tx.objectStore('tasks').put(task));
  });
async function releaseBytes(tx: IDBTransaction, task: CaptureTask) {
  const used = await storedBytes(tx);
  const size = task.file?.size ?? 0;
  if (used < size) throw damaged();
  await request(tx.objectStore('blobs').delete(task.id));
  await request(tx.objectStore('meta').put(used - size, 'bytes'));
}
async function recordReceipt(
  tx: IDBTransaction,
  task: CaptureTask,
  receipt: CaptureReceipt,
  now: number,
) {
  if (!validReceipt(receipt, task.id, task.file ? 'asset' : 'bookmark'))
    throw invalid();
  await releaseBytes(tx, task);
  task.state = receipt.status === 'created' ? 'saved' : 'duplicate';
  task.phase = 'commit';
  task.offset = task.file?.size ?? 0;
  task.receipt = {
    captureId: task.id,
    status: receipt.status,
    kind: receipt.kind,
    itemId: receipt.itemId,
  };
  task.updatedAt = now;
  delete task.claim;
  delete task.error;
  delete task.retryAt;
  delete task.cancelRequested;
  await request(tx.objectStore('tasks').put(task));
  await pruneHistory(tx, task.binding);
}
export const finishCapture = (
  id: string,
  owner: string,
  receipt: CaptureReceipt,
  now = Date.now(),
): Promise<void> =>
  transaction(['tasks', 'blobs', 'meta'], 'readwrite', async (tx) => {
    const task = await ownedTask(tx, id, owner, now);
    if (
      task.state !== 'committing' ||
      task.phase !== 'commit' ||
      task.offset !== (task.file?.size ?? 0)
    )
      throw invalid();
    await recordReceipt(tx, task, receipt, now);
  });
export const requestCaptureCancellation = (
  id: string,
  binding: ServerBinding,
  now = Date.now(),
): Promise<void> =>
  transaction(['tasks'], 'readwrite', async (tx) => {
    const task = checkTask(await request(tx.objectStore('tasks').get(id)));
    if (
      !sameDestination(task.binding, binding) ||
      ['saved', 'duplicate', 'cancelled'].includes(task.state)
    )
      throw invalid();
    // Started captures parked for attention become claimable so the runner can settle them.
    if (['needs-attention', 'failed'].includes(task.state))
      task.state = 'queued';
    task.cancelRequested = true;
    task.error = CANCELLATION_PENDING;
    task.updatedAt = now;
    task.retryAt = Math.max(now, task.retryAt ?? now);
    await request(tx.objectStore('tasks').put(task));
  });
export const finishCaptureCancellation = (
  id: string,
  owner: string,
  outcome: CaptureCancellation,
  now = Date.now(),
): Promise<void> =>
  transaction(['tasks', 'blobs', 'meta'], 'readwrite', async (tx) => {
    const task = await ownedTask(tx, id, owner, now);
    if (!task.cancelRequested || !outcome || outcome.captureId !== id)
      throw invalid();
    if (outcome.status === 'already-published') {
      await recordReceipt(tx, task, outcome.receipt, now);
      return;
    }
    if (
      outcome.status !== 'cancelled' ||
      ('receipt' in outcome && outcome.receipt !== undefined)
    )
      throw invalid();
    await releaseBytes(tx, task);
    task.state = 'cancelled';
    task.updatedAt = now;
    task.cancellationReceipt = { captureId: id, status: 'cancelled' };
    delete task.claim;
    delete task.error;
    delete task.retryAt;
    delete task.cancelRequested;
    await request(tx.objectStore('tasks').put(task));
    await pruneHistory(tx, task.binding);
  });
export const cancelQueuedCapture = (
  id: string,
  binding: ServerBinding,
  now = Date.now(),
): Promise<void> =>
  transaction(['tasks', 'blobs', 'meta'], 'readwrite', async (tx) => {
    const task = checkTask(await request(tx.objectStore('tasks').get(id)));
    if (
      !sameDestination(task.binding, binding) ||
      !['queued', 'needs-attention', 'failed'].includes(task.state) ||
      task.attempts !== 0 ||
      task.claim
    )
      throw new QueueFailure(
        'This item has already started saving. Wait for your server’s answer before cancelling.',
      );
    await releaseBytes(tx, task);
    task.state = 'cancelled';
    delete task.cancelRequested;
    task.updatedAt = now;
    delete task.error;
    delete task.retryAt;
    await request(tx.objectStore('tasks').put(task));
    await pruneHistory(tx, task.binding);
  });

// Only after GET reported missing and creation/recovery confirmed the same UUID again.
export const restartMissingUpload = (
  id: string,
  owner: string,
  now = Date.now(),
): Promise<CaptureTask> =>
  transaction(['tasks'], 'readwrite', async (tx) => {
    const task = await ownedTask(tx, id, owner, now);
    if (!task.file || task.phase !== 'upload' || task.state !== 'uploading')
      throw invalid();
    task.offset = 0;
    task.updatedAt = now;
    task.claim!.expiresAt = now + CLAIM_MS;
    await request(tx.objectStore('tasks').put(task));
    return task;
  });
