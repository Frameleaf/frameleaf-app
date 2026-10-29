import type { CaptureUploadStateDto } from '@frameleaf/sdk';
import { CaptureFailure, type ServerBinding } from './api';
import {
  createCaptureTransport,
  DeliveryFailure,
  type CaptureTransport,
} from './capture-transport';
import {
  captureBlob,
  CANCELLATION_PENDING,
  claimCapture,
  deferCapture,
  finishCapture,
  QueueFailure,
  restartMissingUpload,
  saveCaptureProgress,
  type CaptureTask,
} from './queue';

export function nextRetryAt(
  attempt: number,
  retryAfter: number | undefined,
  now = Date.now(),
): number {
  const delay = Math.min(
    300000,
    5000 * 2 ** Math.min(6, Math.max(0, attempt - 1)),
  );
  return Math.max(
    now + delay,
    Number.isSafeInteger(retryAfter) ? retryAfter! : 0,
  );
}
const recoverable = (error: unknown) =>
  error instanceof DeliveryFailure &&
  (error.kind === 'retry' || error.status === 409);
const lostClaim = (error: unknown) =>
  error instanceof QueueFailure && error.code === 'claim';
const fatalConnection = (error: unknown) =>
  error instanceof CaptureFailure &&
  [
    'authorization',
    'identity',
    'unsupported',
    'permission',
    'credential',
    'address',
  ].includes(error.code);

async function deliver(
  task: CaptureTask,
  owner: string,
  transport: CaptureTransport,
  signal: AbortSignal,
) {
  if (task.cancelRequested)
    throw new QueueFailure(CANCELLATION_PENDING, 'cancel');
  const remember = async (state: 'uploading' | 'committing', offset: number) =>
    (task = await saveCaptureProgress(task.id, owner, { state, offset }));
  const call = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (signal.aborted) throw new DeliveryFailure('cancelled');
    await remember(
      task.phase === 'commit' ? 'committing' : 'uploading',
      task.offset,
    );
    if (signal.aborted) throw new DeliveryFailure('cancelled');
    return operation();
  };
  if (task.file && task.phase === 'upload') {
    const blob = await captureBlob(task.id);
    if (!blob || blob.size !== task.file.size)
      throw new DeliveryFailure('attention');
    let recreated = false;
    let state: CaptureUploadStateDto;
    try {
      state = await call(() => transport.getUpload(task));
    } catch (error) {
      if (!(error instanceof DeliveryFailure) || error.kind !== 'missing')
        throw error;
      recreated = true;
      try {
        state = await call(() => transport.createUpload(task));
      } catch (creationError) {
        if (!recoverable(creationError)) throw creationError;
        try {
          state = await call(() => transport.getUpload(task));
        } catch (recoveryError) {
          if (
            recoveryError instanceof DeliveryFailure &&
            recoveryError.kind === 'missing'
          )
            throw creationError;
          throw recoveryError;
        }
      }
    }
    if (state.offset < task.offset) {
      if (!recreated) throw new DeliveryFailure('attention');
      task = await restartMissingUpload(task.id, owner);
    }
    await remember('uploading', state.offset);
    while (!state.ready) {
      const previous = state.offset;
      try {
        state = await call(() => transport.appendUpload(task, blob, previous));
      } catch (error) {
        if (!recoverable(error)) throw error;
        state = await call(() => transport.getUpload(task));
        if (!state.ready && state.offset === previous) {
          if (error instanceof DeliveryFailure && error.kind === 'retry')
            throw error;
          throw new DeliveryFailure('retry', 409);
        }
      }
      if (state.offset < previous) throw new DeliveryFailure('attention');
      if (!state.ready && state.offset === previous)
        throw new DeliveryFailure('retry');
      await remember('uploading', state.offset);
    }
    await remember('committing', state.offset);
  }
  const receipt = await call(() => transport.commit(task));
  await finishCapture(task.id, owner, receipt);
}

/** Two local loops share native IDB claims with every other worker or extension page. */
export async function resumeQueue(
  binding: ServerBinding,
  token: string,
  signal?: AbortSignal,
): Promise<void> {
  const stop = new AbortController();
  const active = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
  const transport = createCaptureTransport(binding, token, { signal: active });
  let fatal: CaptureFailure | undefined;
  const worker = async () => {
    const owner = crypto.randomUUID();
    try {
      while (!active.aborted) {
        const task = await claimCapture(binding, owner);
        if (!task) return;
        try {
          await deliver(task, owner, transport, active);
        } catch (error) {
          if (lostClaim(error)) continue;
          if (error instanceof QueueFailure && error.code !== 'cancel')
            throw error;
          if (fatalConnection(error)) {
            fatal ??= error as CaptureFailure;
            stop.abort();
          }
          const retry =
            error instanceof DeliveryFailure && error.kind === 'retry';
          const permanent =
            error instanceof DeliveryFailure && error.kind === 'permanent';
          const message =
            error instanceof CaptureFailure ||
            (error instanceof QueueFailure && error.code === 'cancel')
              ? error.message
              : 'Could not confirm this capture. Its queue entry is retained.';
          try {
            await deferCapture(task.id, owner, {
              kind: retry ? 'retry' : permanent ? 'failed' : 'attention',
              message,
              ...(retry && {
                retryAt: nextRetryAt(task.attempts, error.retryAt),
              }),
            });
          } catch (updateError) {
            if (!lostClaim(updateError)) throw updateError;
          }
        }
      }
    } catch (error) {
      stop.abort();
      throw error;
    }
  };
  const outcomes = await Promise.allSettled([worker(), worker()]);
  if (fatal) throw fatal;
  for (const result of outcomes)
    if (result.status === 'rejected') throw result.reason;
}
