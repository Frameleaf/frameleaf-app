import { takeScreenshot, ScreenshotFailure } from './capture';
import {
  initializeCaptureMenus,
  registerCaptureMenus,
  discoverMenuPage,
} from './context-menus';
import { wakeDelivery, stopDelivery, deliveryError } from './delivery';
import {
  listCaptures,
  retryCapture,
  cancelQueuedCapture,
  requestCaptureCancellation,
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
  releaseScreenshot,
} from './preview';
import { sameBinding } from './api';
import {
  CaptureFailure,
  connectServer,
  createAlbum,
  getCatalog,
  normalizeServerAddress,
} from './api';
import {
  hasServerAccess,
  openOptions,
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

let screenshotController: AbortController | undefined;
function stopScreenshot() {
  screenshotController?.abort();
}
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
      stopScreenshot();
      clearPreview();
      await pauseConnection(binding);
    }
  });
}
const uuidPattern =
  /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
async function queueProgress(): Promise<QueueProgress> {
  const current = await connectionStatus();
  const empty: QueueProgress = { items: [], unfinished: 0, hasMore: false };
  if (!current) return empty;
  // A paused connection keeps its waiting items; list them read-only until the user connects again.
  const paused = current.status !== 'connected';
  if (!paused && !(await hasServerAccess(current.binding.origin))) {
    stopDelivery();
    stopScreenshot();
    clearPreview();
    await pauseConnection(current.binding);
    return empty;
  }
  const error = paused ? undefined : deliveryError(current.binding);
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
        kind: task.bookmark ? 'link' : 'image',
        albumId: task.albumId,
        updatedAt: task.updatedAt,
        ...(task.receipt &&
          uuidPattern.test(task.receipt.itemId) && {
            itemId: task.receipt.itemId,
            itemKind: task.receipt.kind,
          }),
        cancelling: !!task.cancelRequested,
        canRetry:
          !paused && !done(task.state) && !busy && (task.retryAt ?? 0) <= now,
        canCancel: !paused && !done(task.state) && !task.cancelRequested,
      };
    }),
  };
}
async function refresh() {
  const current = await connectionStatus();
  if (!current || current.status !== 'connected') return;
  if (!(await hasServerAccess(current.binding.origin))) {
    stopDelivery();
    stopScreenshot();
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
      stopScreenshot();
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
        'release-screenshot',
        'create-album',
      ].includes(message.type)
    )
  )
    return Promise.resolve({
      ok: false,
      error: 'Open the Frameleaf extension to change its connection.',
    });
  if (message && typeof message === 'object' && 'type' in message) {
    if (
      settingsPage &&
      ['connect', 'disconnect'].includes(String(message.type))
    )
      stopScreenshot();
    if (message.type === 'screenshot') {
      if (
        !trustedSender(sender, ['/popup.html']) ||
        !('mode' in message) ||
        (message.mode !== 'visible' && message.mode !== 'area')
      )
        return Promise.resolve({
          ok: false,
          error: 'Open the extension toolbar to capture a screenshot.',
        });
      return startScreenshot(message.mode);
    }
  }
  return serialize(async () => {
    try {
      if (!message || typeof message !== 'object' || !('type' in message))
        throw new Error();
      switch (message.type) {
        case 'connect': {
          stopDelivery();
          stopScreenshot();
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
        case 'discover':
        case 'bookmark': {
          if (!trustedSender(sender, ['/popup.html'])) throw new Error();
          const current = await connectionStatus();
          if (!current || current.status !== 'connected')
            throw new CaptureFailure('credential');
          const discovery = await discoverActivePage(
            message.type === 'bookmark' ? 'bookmark' : 'images',
          );
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
                'This list of images has expired. Go back to the page and find its images again.',
              connection: current,
            };
          }
          return { ok: true, connection: current, preview };
        }
        case 'create-album': {
          if (
            !capturePage ||
            !('previewId' in message) ||
            typeof message.previewId !== 'string' ||
            !('name' in message) ||
            typeof message.name !== 'string'
          )
            throw new Error();
          const name = message.name.trim();
          if (!name || name.length > 255)
            throw new QueueFailure(
              'Enter a collection name of 1 to 255 characters.',
            );
          const current = await connectionStatus();
          if (
            !current ||
            current.status !== 'connected' ||
            !readPreview(message.previewId, current.binding)
          )
            throw new CaptureFailure('credential');
          if (!(await hasServerAccess(current.binding.origin)))
            throw new CaptureFailure('permission');
          const parentId = 'parentId' in message ? message.parentId : undefined;
          if (
            parentId !== undefined &&
            (typeof parentId !== 'string' ||
              !current.catalog?.albums.some((album) => album.id === parentId))
          )
            throw new QueueFailure(
              'Refresh collections and choose one to create it inside.',
            );
          let album;
          try {
            album = await createAlbum(
              current.binding,
              await credentialFor(current.binding),
              name,
              parentId,
            );
            await refresh();
          } catch (error) {
            if (
              error instanceof CaptureFailure &&
              ['authorization', 'identity', 'unsupported'].includes(error.code)
            ) {
              stopDelivery();
              stopScreenshot();
              clearPreview();
              await pauseConnection(current.binding);
            }
            throw error;
          }
          const latest = await connectionStatus();
          if (
            !latest ||
            latest.status !== 'connected' ||
            !sameBinding(latest.binding, current.binding) ||
            !latest.catalog?.albums.some(
              (value) =>
                value.id === album.id && value.parentId === (parentId ?? null),
            )
          )
            throw new CaptureFailure('album');
          return { ok: true, connection: latest, albumId: album.id };
        }
        case 'release-screenshot': {
          if (
            !capturePage ||
            !('id' in message) ||
            typeof message.id !== 'string'
          )
            throw new Error();
          const current = await connectionStatus();
          if (
            current?.status !== 'connected' ||
            !releaseScreenshot(message.id, current.binding)
          )
            throw new CaptureFailure('credential');
          return { ok: true, connection: current };
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
              'This list of images has expired. Find its images again.',
            );
          return { ok: true, connection: current, preview };
        }
        case 'disconnect':
          stopDelivery();
          stopScreenshot();
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
            throw new QueueFailure('Choose an item from your saving list.');
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
              'This item isn’t in this account’s saving list.',
            );
          if (message.type === 'retry-capture') {
            if ((task.retryAt ?? 0) > Date.now())
              throw new QueueFailure(
                'A retry is already scheduled. Wait until then.',
              );
            await retryCapture(message.id, current.binding);
            wake();
          } else if (task.attempts === 0 && !task.claim)
            await cancelQueuedCapture(message.id, current.binding);
          else {
            await requestCaptureCancellation(message.id, current.binding);
            wake();
          }
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
async function startScreenshot(
  mode: 'visible' | 'area',
): Promise<ExtensionReply> {
  if (screenshotController)
    return {
      ok: false,
      error: 'Finish or cancel the current screenshot first.',
    };
  const controller = new AbortController();
  screenshotController = controller;
  try {
    const current = await serialize(async () => {
      const value = await connectionStatus();
      if (value?.status !== 'connected') throw new CaptureFailure('credential');
      if (!(await hasServerAccess(value.binding.origin)))
        throw new CaptureFailure('permission');
      return value;
    });
    const result = await takeScreenshot(mode, controller.signal);
    return await serialize(async () => {
      if (controller.signal.aborted) throw new ScreenshotFailure();
      const latest = await connectionStatus();
      if (
        latest?.status !== 'connected' ||
        !sameBinding(latest.binding, current.binding) ||
        !(await hasServerAccess(current.binding.origin))
      )
        throw new CaptureFailure('credential');
      if (result) {
        const preview = createPreview(
          current.binding,
          result.discovery,
          Date.now(),
          result.screenshot,
        );
        await openCapturePreview(preview.id);
      }
      return { ok: true, connection: latest };
    });
  } catch (error) {
    if (mode === 'area' && !controller.signal.aborted)
      await chrome.tabs
        .create({ url: chrome.runtime.getURL('capture.html?error=screenshot') })
        .catch(() => {});
    return {
      ok: false,
      error:
        error instanceof CaptureFailure
          ? error.message
          : new ScreenshotFailure().message,
    };
  } finally {
    if (screenshotController === controller) screenshotController = undefined;
  }
}
async function handleMenu(
  info: chrome.contextMenus.OnClickData,
  tab?: chrome.tabs.Tab,
) {
  return serialize(async () => {
    try {
      const current = await connectionStatus();
      if (!current || current.status !== 'connected') {
        await openOptions();
        return;
      }
      if (!(await hasServerAccess(current.binding.origin))) {
        stopDelivery();
        stopScreenshot();
        clearPreview();
        await pauseConnection(current.binding);
        await openOptions();
        return;
      }
      const discovery = await discoverMenuPage(info, tab);
      const latest = await connectionStatus();
      if (
        !latest ||
        latest.status !== 'connected' ||
        !sameBinding(latest.binding, current.binding)
      )
        throw new CaptureFailure('credential');
      const preview = createPreview(current.binding, discovery);
      await openCapturePreview(preview.id);
    } catch {
      await chrome.tabs.create({
        url: chrome.runtime.getURL('capture.html?error=page'),
      });
    }
  });
}
registerCaptureMenus(handleMenu);
registerDeliveryAlarm(wake);
registerBackground(
  handleMessage,
  async () => {
    await initializeStorage();
    await ensureDeliveryAlarm();
    wake();
    await initializeCaptureMenus();
  },
  () => {
    stopDelivery();
    stopScreenshot();
    return serialize(async () => {
      const current = await connectionStatus();
      if (current && !(await hasServerAccess(current.binding.origin))) {
        clearPreview();
        await pauseConnection(current.binding);
      } else wake();
    });
  },
);
