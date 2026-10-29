import {
  takeScreenshot,
  ScreenshotFailure,
  type ScreenshotPreview,
} from './capture';
import { takeWholePage } from './whole-page-capture';
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
import {
  DiscoveryFailure,
  discoverActivePage,
  type PageDiscovery,
} from './discovery';
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
  allowPageUrl,
  checkServer,
  codeChallenge,
  exchangeCode,
  randomText,
  readReturn,
  removeAccess,
  SIGN_IN_WINDOW_MS,
  SignInFailure,
  windowClosed,
} from './sign-in';
import {
  browserClient,
  hasServerAccess,
  launchSignInWindow,
  signInRedirectUri,
  openOptions,
  ensureDeliveryAlarm,
  registerDeliveryAlarm,
  openCapturePreview,
  registerBackground,
  registerStartup,
  trustedSender,
  type ExtensionReply,
} from './platform';
import {
  accessFor,
  addPendingRemoval,
  connectionStatus,
  pendingRemovals,
  setPendingRemovals,
  installationId,
  credentialFor,
  disconnect,
  recentServers,
  rememberServer,
  setSignInNotice,
  signInNotice,
  type SignInProblem,
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
      ['connect', 'disconnect', 'sign-in'].includes(String(message.type))
    )
      stopScreenshot();
    // FL-655: the sign-in window stays open while you sign in, so it never holds the queue of messages.
    if (settingsPage && message.type === 'sign-in') return signIn(message);
    if (message.type === 'screenshot') {
      if (
        !trustedSender(sender, ['/popup.html']) ||
        !('mode' in message) ||
        (message.mode !== 'visible' &&
          message.mode !== 'area' &&
          message.mode !== 'whole')
      )
        return Promise.resolve({
          ok: false,
          error: 'Open the extension toolbar to capture a screenshot.',
        });
      return message.mode === 'whole'
        ? startWholeScreenshot()
        : startScreenshot(message.mode);
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
          // FL-655: a key replaces a signed-in access, which is removed on its server
          await revokeSignedIn();
          generation++;
          await saveConnection(binding, message.token);
          await rememberServer(origin, binding.userName);
          await setSignInNotice(null);
          await refresh();
          wake();
          void retryRemovals();
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
        case 'disconnect': {
          stopDelivery();
          stopScreenshot();
          clearPreview();
          // FL-655: "Sign out of this browser only" leaves the access in Frameleaf on purpose
          const localOnly =
            'localOnly' in message && message.localOnly === true;
          if (!(await signOutCurrent(localOnly)))
            throw new CaptureFailure('signOut');
          generation++;
          await setSignInNotice(null);
          break;
        }
        case 'sign-in-state':
          return {
            ok: true,
            connection: await connectionStatus(),
            recent: await recentServers(),
            notice: await signInNotice(),
          };
        case 'dismiss-notice':
          await setSignInNotice(null);
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
/**
 * FL-655: sign out of the current server. An access added by signing in removes itself on the
 * server, so it leaves API keys too; a key pasted by hand is only forgotten here. Waiting items
 * are kept either way, for when you sign in to that server again.
 */
async function signOutCurrent(localOnly = false): Promise<boolean> {
  const current = await connectionStatus().catch(() => null);
  if (current) {
    const access = await accessFor(current.binding).catch(() => null);
    // A paused access can't save any more: sign out here, and remove it on the server now or later.
    if (
      access?.method === 'sign-in' &&
      !localOnly &&
      current.status !== 'connected'
    ) {
      await revoke(current.binding.origin, access.token);
      await disconnect();
      return true;
    }
    if (access?.method === 'sign-in' && !localOnly) {
      // nothing more is sent with the key while it is being removed
      stopDelivery();
      const removed =
        (await hasServerAccess(current.binding.origin)) &&
        (await removeAccess(
          current.binding.origin,
          access.token,
          globalThis.fetch.bind(globalThis),
        ).catch(() => false));
      if (!removed) {
        // still signed in: keep the key, and carry on saving with it
        wake();
        return false;
      }
    }
  }
  await disconnect();
  return true;
}
/**
 * FL-655: counts every change you make to the connection (connect, sign out, a sign-in saved), so a
 * sign-in window that comes back after a newer change is not saved over it.
 */
let generation = 0;
class Superseded extends Error {}
/** Remove an access on the server; if it can't be reached now, keep trying later. */
async function revoke(origin: string, token: string) {
  const removed =
    (await hasServerAccess(origin).catch(() => false)) &&
    (await removeAccess(origin, token, globalThis.fetch.bind(globalThis)).catch(
      () => false,
    ));
  if (!removed) await addPendingRemoval(origin, token);
}
/** A signed-in access about to be replaced by another connection. */
async function revokeSignedIn() {
  const current = await connectionStatus().catch(() => null);
  if (!current) return;
  const access = await accessFor(current.binding).catch(() => null);
  if (access?.method === 'sign-in')
    await revoke(current.binding.origin, access.token);
}
let retrying: Promise<void> | undefined;
/** Retries the removals still owed; each leaves the list once the server removed it or says it's gone. */
export function retryRemovals(): Promise<void> {
  return (retrying ??= (async () => {
    try {
      const removed = new Set<string>();
      for (const item of await pendingRemovals()) {
        const done =
          (await hasServerAccess(item.origin).catch(() => false)) &&
          (await removeAccess(
            item.origin,
            item.token,
            globalThis.fetch.bind(globalThis),
          ).catch(() => false));
        if (done) removed.add(item.token);
      }
      // removals added meanwhile are kept
      await setPendingRemovals(
        (await pendingRemovals()).filter((item) => !removed.has(item.token)),
      );
    } finally {
      retrying = undefined;
    }
  })());
}
let signingIn = false;
/**
 * FL-655: sign in with your Frameleaf account. The popup closes while the browser's sign-in window
 * is open, so this runs here and leaves a notice ("You're signed in", or what went wrong) for the
 * next time the popup opens.
 */
async function signIn(message: object): Promise<ExtensionReply> {
  if (
    !('address' in message) ||
    typeof message.address !== 'string' ||
    message.address.length > 8192
  )
    return { ok: false, error: new CaptureFailure('address').message };
  const allowLocalhost =
    'allowLocalhost' in message && message.allowLocalhost === true;
  const switching = 'switching' in message && message.switching === true;
  let origin: string;
  try {
    origin = normalizeServerAddress(message.address, allowLocalhost);
  } catch {
    return {
      ok: false,
      error: new CaptureFailure('address').message,
      problem: 'address',
    };
  }
  if (signingIn)
    return {
      ok: false,
      error: 'A sign-in window is already open.',
      problem: 'busy',
    };
  signingIn = true;
  const transport = globalThis.fetch.bind(globalThis);
  /** An access the server made that this browser has not kept yet, removed again if it isn't. */
  let exchanged: { secret: string } | undefined;
  let saved = false;
  try {
    if (!(await hasServerAccess(origin))) throw new SignInFailure('permission');
    await checkServer(origin, transport);
    await setSignInNotice(null);
    if (switching)
      await serialize(async () => {
        stopDelivery();
        stopScreenshot();
        clearPreview();
        if (!(await signOutCurrent())) throw new SignInFailure('sign-out');
        generation++;
      });
    // a sign-out or another connection while the window is open wins over this sign-in
    const before = generation;
    const verifier = randomText(48);
    const state = randomText(24);
    const redirectUri = signInRedirectUri();
    const started = Date.now();
    let returned: string | undefined;
    try {
      returned = await launchSignInWindow(
        allowPageUrl(origin, {
          redirectUri,
          codeChallenge: await codeChallenge(verifier),
          state,
          client: browserClient(),
          installationId: await installationId(),
        }),
      );
    } catch (error) {
      // closing the window is cancelling; a window left open too long has expired; a window that
      // could not open at all offers the key instead
      throw new SignInFailure(
        Date.now() - started > SIGN_IN_WINDOW_MS
          ? 'expired'
          : windowClosed(error)
            ? 'cancelled'
            : 'window',
      );
    }
    if (Date.now() - started > SIGN_IN_WINDOW_MS)
      throw new SignInFailure('expired');
    const code = readReturn(returned, redirectUri, state);
    const access = await exchangeCode(
      origin,
      { code, codeVerifier: verifier, redirectUri },
      transport,
    );
    exchanged = access;
    await serialize(async () => {
      stopDelivery();
      stopScreenshot();
      clearPreview();
      if (!(await hasServerAccess(origin)))
        throw new SignInFailure('permission');
      const binding = await connectServer(origin, access.secret, {
        allowLocalhost,
      });
      if (
        binding.serverId !== access.serverId ||
        binding.userId !== access.userId
      )
        throw new SignInFailure('failed');
      if (generation !== before) throw new Superseded();
      // the access this replaces, on whichever server, is removed there
      await revokeSignedIn();
      generation++;
      await saveConnection(binding, access.secret, {
        method: 'sign-in',
        apiKeyId: access.apiKeyId,
      });
      saved = true;
      await rememberServer(origin, binding.userName);
      await setSignInNotice({ kind: 'welcome' });
      await refresh().catch(() => {});
      wake();
    });
    void retryRemovals();
    return { ok: true, connection: await connectionStatus() };
  } catch (error) {
    // an access the server made but this browser didn't keep is removed again, now or later
    if (exchanged && !saved)
      await revoke(origin, exchanged.secret).catch(() => {});
    if (error instanceof Superseded)
      return {
        ok: false,
        error:
          'You signed out or connected again while signing in, so this sign-in wasn’t kept.',
        connection: await connectionStatus().catch(() => null),
      };
    const problem: SignInProblem =
      error instanceof SignInFailure ? error.problem : 'failed';
    await setSignInNotice({ kind: 'problem', problem, origin }).catch(() => {});
    return {
      ok: false,
      error: problem,
      problem,
      connection: await connectionStatus().catch(() => null),
    };
  } finally {
    signingIn = false;
  }
}
function connectedForScreenshot() {
  return serialize(async () => {
    const value = await connectionStatus();
    if (value?.status !== 'connected') throw new CaptureFailure('credential');
    if (!(await hasServerAccess(value.binding.origin)))
      throw new CaptureFailure('permission');
    return value;
  });
}
function showScreenshot(
  controller: AbortController,
  binding: ServerBinding,
  result: { discovery: PageDiscovery; screenshot: ScreenshotPreview } | null,
): Promise<ExtensionReply> {
  return serialize(async () => {
    if (controller.signal.aborted) throw new ScreenshotFailure();
    const latest = await connectionStatus();
    if (
      latest?.status !== 'connected' ||
      !sameBinding(latest.binding, binding) ||
      !(await hasServerAccess(binding.origin))
    )
      throw new CaptureFailure('credential');
    if (result) {
      const preview = createPreview(
        binding,
        result.discovery,
        Date.now(),
        result.screenshot,
      );
      await openCapturePreview(preview.id);
    }
    return { ok: true, connection: latest };
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
    const current = await connectedForScreenshot();
    const result = await takeScreenshot(mode, controller.signal);
    return await showScreenshot(controller, current.binding, result);
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
/**
 * Replies as soon as the capture can start, so the popup can close itself and stay out of
 * the picture. Progress and Cancel are shown on the page; the preview opens in a tab.
 */
async function startWholeScreenshot(): Promise<ExtensionReply> {
  if (screenshotController)
    return {
      ok: false,
      error: 'Finish or cancel the current screenshot first.',
    };
  const controller = new AbortController();
  screenshotController = controller;
  let current: Awaited<ReturnType<typeof connectedForScreenshot>>;
  try {
    current = await connectedForScreenshot();
  } catch (error) {
    if (screenshotController === controller) screenshotController = undefined;
    return {
      ok: false,
      error:
        error instanceof CaptureFailure
          ? error.message
          : new ScreenshotFailure().message,
    };
  }
  void runWholeScreenshot(controller, current.binding);
  return { ok: true, connection: current };
}
async function runWholeScreenshot(
  controller: AbortController,
  binding: ServerBinding,
) {
  // A failure in the fallback the person chose is an ordinary screenshot failure, not a whole-page one.
  let failure: 'whole' | 'screenshot' = 'whole';
  try {
    // Give the popup a moment to close before the page starts to scroll.
    await new Promise((done) => setTimeout(done, 300));
    const outcome = await takeWholePage(controller.signal);
    if (outcome.kind === 'cancelled') return;
    if (outcome.kind === 'fallback') failure = 'screenshot';
    const result =
      outcome.kind === 'fallback'
        ? await takeScreenshot(outcome.mode, controller.signal)
        : outcome;
    await showScreenshot(controller, binding, result);
  } catch {
    if (!controller.signal.aborted)
      await chrome.tabs
        .create({ url: chrome.runtime.getURL(`capture.html?error=${failure}`) })
        .catch(() => {});
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
registerDeliveryAlarm(() => {
  wake();
  void retryRemovals().catch(() => {});
});
// FL-655: removals still owed are retried when the browser starts, on the alarm and after connecting
registerStartup(() => void retryRemovals().catch(() => {}));
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
