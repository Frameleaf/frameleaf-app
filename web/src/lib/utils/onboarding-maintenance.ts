import { getServerConfig } from '@frameleaf/sdk';
import { maintenanceShouldRedirect } from '$lib/utils/maintenance';

/** The public onboarding socket can be rejected by the old, authenticated API during restart. */
export async function waitForOnboardingMaintenance(owner: AbortSignal): Promise<void> {
  const readiness = new AbortController();
  const stop = () => readiness.abort(owner.reason);
  owner.addEventListener('abort', stop, { once: true });
  if (owner.aborted) {
    stop();
  }
  const deadline = setTimeout(
    () => readiness.abort(new DOMException('Maintenance did not become available', 'TimeoutError')),
    30_000,
  );

  try {
    while (true) {
      readiness.signal.throwIfAborted();
      let maintenanceMode = false;
      try {
        ({ maintenanceMode } = await getServerConfig({ signal: readiness.signal }));
      } catch (error) {
        readiness.signal.throwIfAborted();
        if (
          error &&
          typeof error === 'object' &&
          'status' in error &&
          typeof error.status === 'number' &&
          error.status < 500
        ) {
          throw error;
        }
      }
      readiness.signal.throwIfAborted();
      if (maintenanceMode) {
        if (maintenanceShouldRedirect(true, location)) {
          location.reload();
        }
        return;
      }

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          readiness.signal.removeEventListener('abort', cancelWait);
          resolve();
        }, 1000);
        const cancelWait = () => {
          clearTimeout(timer);
          readiness.signal.removeEventListener('abort', cancelWait);
          reject(readiness.signal.reason);
        };
        readiness.signal.addEventListener('abort', cancelWait, { once: true });
        if (readiness.signal.aborted) {
          cancelWait();
        }
      });
    }
  } finally {
    clearTimeout(deadline);
    owner.removeEventListener('abort', stop);
  }
}
