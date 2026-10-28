import { wakeDelivery, stopDelivery, deliveryError } from './delivery';
import {
  listCaptures,
  retryCapture,
  cancelQueuedCapture,
  QueueFailure,
} from './queue';
import type { ServerBinding } from './api';
import type { QueueProgress } from './platform';
import { DiscoveryFailure, discoverActivePage } from './discovery';
import {
  clearPreview,
  createPreview,
  readPreview,
  releaseCandidates,
} from './preview';
import { sameBinding } from './api';
import {
  CaptureFailure,
  connectServer,
  getCatalog,
  normalizeServerAddress,
} from './api';
import {
  hasServerAccess,
  ensureDeliveryAlarm,
  registerDeliveryAlarm,
  openCapturePreview,
  registerBackground,
  trustedSender,
  type ExtensionReply,
} from './platform';
import {
  connectionStatus,
  credentialFor,
  disconnect,
  initializeStorage,
  pauseConnection,
  saveCatalog,
  saveConnection,
} from './settings';

let writes: Promise<unknown> = Promise.resolve();
function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = writes.then(operation);
  writes = result.catch(() => {});
  return result;
}
const wake = () => void wakeDelivery(pauseDeliveryBinding);
function pauseDeliveryBinding(binding: ServerBinding) {
  return serialize(async () => {
    const current = await connectionStatus();
    if (current && sameBinding(current.binding, binding)) {
      stopDelivery();
      clearPreview();
      await pauseConnection(binding);
    }
  });
}
async function queueProgress(): Promise<QueueProgress> {
  const current = await connectionStatus();
  const empty: QueueProgress = { items: [], unfinished: 0, hasMore: false };
  if (!current || current.status !== 'connected') return empty;
  if (!(await hasServerAccess(current.binding.origin))) {
    stopDelivery();
    clearPreview();
    await pauseConnection(current.binding);
    return empty;
  }
  const error = deliveryError(current.binding);
  if (error) return { ...empty, error };
  const tasks = await listCaptures(current.binding);
  const done = (state: string) =>
    ['saved', 'duplicate', 'cancelled'].includes(state);
  const unfinished = tasks.filter((task) => !done(task.state));
  const visible = [
    ...unfinished.toReversed().slice(0, 100),
    ...tasks.filter((task) => done(task.state)).slice(0, 20),
  ];
  const now = Date.now();
  return {
    unfinished: unfinished.length,
    hasMore: unfinished.length > 100,
    items: visible.map((task) => {
      const busy = (task.claim?.expiresAt ?? 0) > now;
      const label = task.file?.filename ?? task.bookmark?.title ?? 'Capture';
      return {
        id: task.id,
        label: typeof label === 'string' ? label.slice(0, 2000) : 'Capture',
        state: task.state,
        offset: task.offset,
        total: task.file?.size,
        retryAt: task.retryAt,
        error:
          typeof task.error === 'string'
            ? task.error.slice(0, 1000)
            : undefined,
        canRetry: !done(task.state) && !busy && (task.retryAt ?? 0) <= now,
        canCancel: !done(task.state) && !busy && task.attempts === 0,
      };
    }),
  };
}
async function refresh() {
  const current = await connectionStatus();
  if (!current || current.status !== 'connected') return;
  if (!(await hasServerAccess(current.binding.origin))) {
    stopDelivery();
    clearPreview();
    await pauseConnection(current.binding);
    throw new CaptureFailure('permission');
  }
  try {
    await saveCatalog(
      current.binding,
      await getCatalog(current.binding, await credentialFor(current.binding)),
    );
  } catch (error) {
    if (
      error instanceof CaptureFailure &&
      ['authorization', 'identity', 'unsupported'].includes(error.code)
    ) {
      stopDelivery();
      clearPreview();
      await pauseConnection(current.binding);
    }
    throw error;
  }
}
export function handleMessage(
  message: unknown,
  sender: chrome.runtime.MessageSender,
): Promise<ExtensionReply> {
  const settingsPage = trustedSender(sender);
  const capturePage = trustedSender(sender, ['/capture.html']);
  if (
    !settingsPage &&
    !(
      capturePage &&
      message &&
      typeof message === 'object' &&
      'type' in message &&
      typeof message.type === 'string' &&
      [
        'preview',
        'status',
        'refresh',
        'queue',
        'wake-queue',
        'retry-capture',
        'cancel-capture',
        'release-candidates',
      ].includes(message.type)
    )
  )
    return Promise.resolve({
      ok: false,
      error: 'Open the Frameleaf extension to change its connection.',
    });
  return serialize(async () => {
    try {
      if (!message || typeof message !== 'object' || !('type' in message))
        throw new Error();
      switch (message.type) {
        case 'connect': {
          stopDelivery();
          if (
            !('address' in message) ||
            !('token' in message) ||
            typeof message.address !== 'string' ||
            typeof message.token !== 'string'
          )
            throw new Error();
          const allowLocalhost =
            'allowLocalhost' in message && message.allowLocalhost === true;
          const origin = normalizeServerAddress(
            message.address,
            allowLocalhost,
          );
          if (!(await hasServerAccess(origin)))
            throw new CaptureFailure('permission');
          const binding = await connectServer(origin, message.token, {
            allowLocalhost,
          });
          if (!(await hasServerAccess(origin)))
            throw new CaptureFailure('permission');
          await saveConnection(binding, message.token);
          await refresh();
          wake();
          break;
        }
        case 'refresh':
          await refresh();
          break;
        case 'discover': {
          if (!trustedSender(sender, ['/popup.html'])) throw new Error();
          const current = await connectionStatus();
          if (!current || current.status !== 'connected')
            throw new CaptureFailure('credential');
          const discovery = await discoverActivePage();
          const latest = await connectionStatus();
          if (
            !latest ||
            latest.status !== 'connected' ||
            !sameBinding(current.binding, latest.binding)
          )
            throw new CaptureFailure('credential');
          const preview = createPreview(current.binding, discovery);
          await openCapturePreview(preview.id);
          break;
        }
        case 'preview': {
          if (
            !capturePage ||
            !('id' in message) ||
            typeof message.id !== 'string'
          )
            throw new Error();
          const current = await connectionStatus();
          const preview =
            current?.status === 'connected'
              ? readPreview(message.id, current.binding)
              : null;
          if (!preview) {
            if (current?.status !== 'connected') clearPreview();
            return {
              ok: false,
              error:
                'This collection preview has expired. Return to the webpage and find its images again.',
              connection: current,
            };
          }
          return { ok: true, connection: current, preview };
        }
        case 'release-candidates': {
          if (
            !capturePage ||
            !('id' in message) ||
            typeof message.id !== 'string' ||
            !('candidateIds' in message) ||
            !Array.isArray(message.candidateIds) ||
            message.candidateIds.length > 100 ||
            !message.candidateIds.every(
              (id) => typeof id === 'string' && /^candidate-\d+$/.test(id),
            )
          )
            throw new Error();
          const current = await connectionStatus();
          if (!current || current.status !== 'connected')
            throw new CaptureFailure('credential');
          const preview = releaseCandidates(
            message.id,
            current.binding,
            message.candidateIds,
          );
          if (!preview)
            throw new QueueFailure(
              'This collection preview has expired. Find its images again.',
            );
          return { ok: true, connection: current, preview };
        }
        case 'disconnect':
          stopDelivery();
          clearPreview();
          await disconnect();
          break;
        case 'queue': {
          const queue = await queueProgress();
          const current = await connectionStatus();
          return {
            ok: true,
            connection: current ? { ...current, catalog: null } : null,
            queue,
          };
        }
        case 'wake-queue':
          wake();
          break;
        case 'retry-capture':
        case 'cancel-capture': {
          if (
            !('id' in message) ||
            typeof message.id !== 'string' ||
            !/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(
              message.id,
            )
          )
            throw new QueueFailure('Choose a capture from your queue.');
          const current = await connectionStatus();
          if (!current || current.status !== 'connected')
            throw new CaptureFailure('credential');
          if (!(await hasServerAccess(current.binding.origin)))
            throw new CaptureFailure('permission');
          const task = (await listCaptures(current.binding)).find(
            (task) => task.id === message.id,
          );
          if (!task)
            throw new QueueFailure(
              'This capture is not in the selected account queue.',
            );
          if (message.type === 'retry-capture') {
            if ((task.retryAt ?? 0) > Date.now())
              throw new QueueFailure(
                'This retry is scheduled. Wait until its retry time.',
              );
            await retryCapture(message.id, current.binding);
            wake();
          } else await cancelQueuedCapture(message.id, current.binding);
          break;
        }
        case 'status':
          break;
        default:
          throw new Error();
      }
      return { ok: true, connection: await connectionStatus() };
    } catch (error) {
      const reason =
        error instanceof CaptureFailure ||
        error instanceof DiscoveryFailure ||
        error instanceof QueueFailure
          ? error.message
          : 'Could not read the connection. Reopen the extension and try again.';
      try {
        return {
          ok: false,
          error: reason,
          connection: await connectionStatus(),
        };
      } catch {
        return { ok: false, error: reason };
      }
    }
  });
}
registerDeliveryAlarm(wake);
registerBackground(
  handleMessage,
  async () => {
    await initializeStorage();
    await ensureDeliveryAlarm();
    wake();
  },
  () => {
    stopDelivery();
    return serialize(async () => {
      const current = await connectionStatus();
      if (current && !(await hasServerAccess(current.binding.origin))) {
        clearPreview();
        await pauseConnection(current.binding);
      } else wake();
    });
  },
);
