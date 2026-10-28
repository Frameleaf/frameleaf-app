import { CaptureFailure, sameBinding, type ServerBinding } from './api';
import { hasServerAccess } from './platform';
import { connectionStatus, credentialFor } from './settings';
import { resumeQueue } from './runner';
import { QueueFailure, listCaptures } from './queue';

let running: Promise<void> | undefined;
let controller: AbortController | undefined;
let requested = false;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let lastError: { binding: ServerBinding; message: string } | undefined;
export function stopDelivery() {
  clearTimeout(retryTimer);
  retryTimer = undefined;
  requested = false;
  controller?.abort();
  lastError = undefined;
}
export const deliveryError = (binding: ServerBinding): string | null =>
  lastError && sameBinding(lastError.binding, binding)
    ? lastError.message
    : null;

/** Settings mutations stay with the background's serialized pause callback. */
export function wakeDelivery(
  onFatal: (binding: ServerBinding, error: CaptureFailure) => Promise<void>,
): Promise<void> {
  clearTimeout(retryTimer);
  retryTimer = undefined;
  requested = true;
  if (running) return running;
  running = (async () => {
    while (requested) {
      requested = false;
      const ownController = new AbortController();
      controller = ownController;
      let binding: ServerBinding | undefined;
      try {
        const current = await connectionStatus();
        if (
          !current ||
          current.status !== 'connected' ||
          ownController.signal.aborted
        )
          continue;
        binding = current.binding;
        lastError = undefined;
        if (!(await hasServerAccess(binding.origin)))
          throw new CaptureFailure('permission');
        const token = await credentialFor(binding);
        if (!ownController.signal.aborted)
          await resumeQueue(binding, token, ownController.signal);
        if (!ownController.signal.aborted) {
          const pending = (await listCaptures(binding)).filter((task) =>
            ['queued', 'uploading', 'committing'].includes(task.state),
          );
          if (ownController.signal.aborted) continue;
          if (pending.length) {
            const now = Date.now();
            const next = pending.reduce(
              (next, task) =>
                Math.min(
                  next,
                  Math.max(task.retryAt ?? now, task.claim?.expiresAt ?? now),
                ),
              Infinity,
            );
            retryTimer = setTimeout(
              () => void wakeDelivery(onFatal),
              Math.min(300000, Math.max(5000, next - now)),
            );
          }
        }
      } catch (error) {
        if (!ownController.signal.aborted && binding) {
          lastError = {
            binding,
            message:
              error instanceof CaptureFailure || error instanceof QueueFailure
                ? error.message
                : 'Could not read or deliver the capture queue. Reopen the extension to try again.',
          };
          if (
            error instanceof CaptureFailure &&
            [
              'authorization',
              'identity',
              'unsupported',
              'permission',
              'credential',
              'address',
            ].includes(error.code)
          ) {
            try {
              await onFatal(binding, error);
            } catch {
              lastError = {
                binding,
                message:
                  'Could not pause this connection. Reopen the extension before continuing.',
              };
            }
          }
        }
      } finally {
        if (controller === ownController) controller = undefined;
      }
    }
  })().finally(() => {
    running = undefined;
    if (requested) void wakeDelivery(onFatal);
  });
  return running;
}
