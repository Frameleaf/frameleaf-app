/**
 * The Freecut editor as a Studio engine module (FL-88, FL-92).
 *
 * `studio/adapters/web` builds the complete React editor, and a separate command runtime, into
 * `/studio-engine/` next to the web app. This module is the host half: it satisfies
 * `StudioEngineModule` by starting that editor in a same-origin frame inside the element the host
 * gives it and speaking `frame-protocol.ts` over a `MessageChannel`.
 *
 * - **Honest absence.** The build is optional. When `/studio-engine/manifest.json` is not there the
 *   loader reports `not-built`, and the route shows the unavailable state it always has.
 * - **Pinned engine.** A manifest or a frame announcing any other Freecut revision, or another
 *   protocol version, is refused before anything mounts.
 * - **Data only, not a sandbox.** The frame is posted the host context (data) and nothing else, and
 *   every service call it makes is answered here, by the same `StudioHostServices` the route built,
 *   after its shape is checked. The frame is same-origin and shares the session's cookies, so this
 *   is not a security boundary; the engine is trusted as the pinned, hash-verified build.
 * - **Complete disposal.** `dispose` asks the editor to release what it holds, then removes the
 *   frame, which ends every AudioContext, GPU device, worker and object URL it created.
 */
import type { StudioCommandEnvelope } from './commands';
import { registerStudioEngine, StudioEngineNotBuiltError } from './engine-loader';
import {
  isStudioFrameHello,
  isStudioProjectImportUpload,
  STUDIO_FRAME_PROTOCOL_VERSION,
  type StudioCommandApplyOutcome,
  type StudioCommandApplyRequest,
  type StudioCommandFrameMessage,
  type StudioFrameManifest,
  type StudioFrameServiceName,
  type StudioFrameToHostMessage,
  type StudioHostToFrameMessage,
} from './frame-protocol';
import { storeGeneratedMedia } from './generated-media';
import { createStudioGeneratedAccess } from './generated-media-client';
import type {
  StudioAssetRef,
  StudioCommandEngine,
  StudioEngineInstance,
  StudioEngineModule,
  StudioHostContext,
  StudioHostServices,
  StudioProjectImportRef,
  StudioNavigationTarget,
} from './host-contract';

export const STUDIO_ENGINE_BASE = '/studio-engine/';

/** How long a frame may take to announce itself before the mount is reported as failed. */
const HELLO_TIMEOUT_MS = 60_000;
/** How long `dispose` waits for the editor's own teardown before removing the frame anyway. */
const DISPOSE_TIMEOUT_MS = 5000;

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object';

/**
 * Read and check the build manifest. A missing file is `not-built`; a file for another engine is a
 * mismatch the loader reports as such.
 */
export const resolveStudioFrameManifest = async (
  fetchImpl: typeof fetch = fetch,
  base = STUDIO_ENGINE_BASE,
): Promise<StudioFrameManifest> => {
  let response: Response;
  try {
    response = await fetchImpl(`${base}manifest.json`, { cache: 'no-store', credentials: 'same-origin' });
  } catch {
    throw new StudioEngineNotBuiltError('The Studio engine could not be reached');
  }
  if (response.status === 404) {
    throw new StudioEngineNotBuiltError('The Studio engine is not part of this build');
  }
  if (!response.ok) {
    throw new Error(`The Studio engine manifest answered HTTP ${response.status}`);
  }
  let manifest: unknown;
  try {
    manifest = await response.json();
  } catch {
    // A single-page fallback answered with HTML: the engine was never built into this deployment.
    throw new StudioEngineNotBuiltError('The Studio engine is not part of this build');
  }
  if (
    !isRecord(manifest) ||
    typeof manifest.engineRevision !== 'string' ||
    typeof manifest.protocolVersion !== 'number' ||
    typeof manifest.editor !== 'string' ||
    typeof manifest.commands !== 'string' ||
    !Array.isArray(manifest.features)
  ) {
    throw new Error('The Studio engine manifest is malformed');
  }
  if (manifest.protocolVersion !== STUDIO_FRAME_PROTOCOL_VERSION) {
    throw new Error(
      `The Studio engine speaks protocol ${manifest.protocolVersion}, not ${STUDIO_FRAME_PROTOCOL_VERSION}`,
    );
  }
  return manifest as unknown as StudioFrameManifest;
};

/**
 * Structured-clone-safe copy of host data. The route's values are Svelte state proxies, which
 * `postMessage` cannot clone, and the frame must get a snapshot rather than a live object anyway.
 */
// `structuredClone` throws on a Svelte state proxy, which is exactly what this is given.
// eslint-disable-next-line unicorn/prefer-structured-clone
export const toFrameData = <T>(value: T): T => JSON.parse(JSON.stringify(value ?? null)) as T;

/** Documents are resolved against the manifest's base; only same-origin paths are accepted. */
const documentUrl = (base: string, relative: string): string => {
  const url = new URL(relative, new URL(base, location.href));
  if (url.origin !== location.origin) {
    throw new Error('The Studio engine document is not same-origin');
  }
  return url.href;
};

export interface StudioFrameFactory {
  /** Create the frame element for `src` inside `parent`. Replaced in tests. */
  (parent: HTMLElement, src: string, hidden: boolean): HTMLIFrameElement;
}

export const createStudioFrameElement: StudioFrameFactory = (parent, src, hidden) => {
  const frame = document.createElement('iframe');
  frame.src = src;
  frame.title = hidden ? 'Frameleaf Studio commands' : 'Frameleaf Studio editor';
  frame.referrerPolicy = 'same-origin';
  // Media playback and full-screen preview are the editor's own; nothing else is delegated.
  frame.allow = 'autoplay; fullscreen';
  frame.dataset.testid = hidden ? 'studio-command-frame' : 'studio-editor-frame';
  if (hidden) {
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
  } else {
    frame.style.cssText = 'display:block;width:100%;height:100%;border:0;background:transparent';
  }
  parent.append(frame);
  return frame;
};

/**
 * Wait for the frame to announce itself, check it, then hand it its end of a channel. The frame
 * speaks first so the host never posts into a document that has not started yet.
 */
const connect = (
  frame: HTMLIFrameElement,
  kind: 'editor' | 'commands',
  engineRevision: string,
  timeoutMs = HELLO_TIMEOUT_MS,
): Promise<MessagePort> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      removeEventListener('message', onMessage);
      reject(new Error(`The Studio ${kind} did not start`));
    }, timeoutMs);
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || event.origin !== location.origin) {
        return;
      }
      if (!isStudioFrameHello(event.data) || event.data.kind !== kind) {
        return;
      }
      clearTimeout(timer);
      removeEventListener('message', onMessage);
      if (
        event.data.protocolVersion !== STUDIO_FRAME_PROTOCOL_VERSION ||
        event.data.engineRevision !== engineRevision
      ) {
        reject(new Error(`The Studio ${kind} was built for another engine (${event.data.engineRevision})`));
        return;
      }
      const channel = new MessageChannel();
      frame.contentWindow?.postMessage({ source: 'frameleaf-studio-host' }, location.origin, [channel.port2]);
      resolve(channel.port1);
    };
    addEventListener('message', onMessage);
  });

const assetIdPattern = /^[\w-]{1,64}$/;

/** Only the navigation targets the contract defines, with a well-formed asset id. */
export const toNavigationTarget = (value: unknown): StudioNavigationTarget | null => {
  if (!isRecord(value)) {
    return null;
  }
  if (value.kind === 'library' || value.kind === 'activity') {
    return { kind: value.kind };
  }
  if (value.kind === 'asset' && typeof value.assetId === 'string' && assetIdPattern.test(value.assetId)) {
    return { kind: 'asset', assetId: value.assetId };
  }
  return null;
};

type ServiceCall = (services: StudioHostServices, args: unknown[]) => Promise<unknown>;

const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** The services a frame may call, each checked for shape before it reaches the host. */
const serviceCalls: Record<StudioFrameServiceName, ServiceCall> = {
  authorizeGeneratedMedia: () => Promise.resolve(false),
  submitCommands: (services, [envelopes]) =>
    services.submitCommands(Array.isArray(envelopes) ? (envelopes as StudioCommandEnvelope[]) : []),
  stageDraft: (services, [graph, commandIds, baseRevision, graphVersion]) => {
    if (!services.stageDraft) {
      return Promise.resolve({ status: 'rejected', reason: 'forbidden' } as const);
    }
    // Protocol 3: an editor draft names the revision and the host graph version it was loaded from,
    // both whole counts. Without them it could not be judged as the editor's, so it is refused
    // rather than staged as anything else (FL-174).
    if (!isCount(baseRevision) || !isCount(graphVersion)) {
      return Promise.resolve({ status: 'rejected', reason: 'invalid' } as const);
    }
    const ids = Array.isArray(commandIds) ? commandIds.filter((id): id is string => typeof id === 'string') : [];
    return services.stageDraft(graph, ids, baseRevision, graphVersion);
  },
  commitEditorDraft: (services, [graph, baseRevision, scope]) => {
    if (!services.commitEditorDraft || !isCount(baseRevision) || !scope || typeof scope !== 'object') {
      return Promise.resolve({ status: 'rejected', reason: 'Invalid relink save origin' });
    }
    const origin = scope as { projectId?: unknown; userId?: unknown; graphVersion?: unknown };
    if (typeof origin.projectId !== 'string' || typeof origin.userId !== 'string' || !isCount(origin.graphVersion)) {
      return Promise.resolve({ status: 'rejected', reason: 'Invalid relink save origin' });
    }
    return services.commitEditorDraft(graph, baseRevision, {
      projectId: origin.projectId,
      userId: origin.userId,
      graphVersion: origin.graphVersion,
    });
  },
  reloadProject: (services) => services.reloadProject(),
  saveWorkspace: (services, [layout]) =>
    services.saveWorkspace ? services.saveWorkspace(layout) : Promise.resolve({ status: 'unavailable' } as const),
  // The frame is not trusted to send an upload of the right shape; the server checks the bytes.
  uploadProjectImport: (services, [upload]) => {
    if (!services.uploadProjectImport) {
      return Promise.reject(new Error('This project cannot keep imported files'));
    }
    return isStudioProjectImportUpload(upload)
      ? services.uploadProjectImport(upload)
      : Promise.reject(new Error('Invalid project import'));
  },
};

export interface FrameEngineOptions {
  manifest: StudioFrameManifest;
  base?: string;
  createFrame?: StudioFrameFactory;
  helloTimeoutMs?: number;
}

export const createFrameStudioEngine = ({
  manifest,
  base = STUDIO_ENGINE_BASE,
  createFrame = createStudioFrameElement,
  helloTimeoutMs,
}: FrameEngineOptions): StudioEngineModule => ({
  engineRevision: manifest.engineRevision,
  features: [...manifest.features],

  async mount(target: HTMLElement, context: StudioHostContext, services: StudioHostServices) {
    let revoke: (error: Error) => void = () => {};
    let pendingRevocation: Error | null = null;
    const access = createStudioGeneratedAccess((error) => {
      pendingRevocation = error;
      revoke(error);
    });
    let current: StudioHostContext;
    try {
      current = {
        ...context,
        generatedMedia: await access.admit(context.project.id, context.project.graph, context.project.revision),
      };
    } catch (error) {
      access.dispose();
      throw error;
    }
    const frame = createFrame(target, documentUrl(base, manifest.editor), false);
    let port: MessagePort;
    try {
      port = await connect(frame, 'editor', manifest.engineRevision, helloTimeoutMs);
    } catch (error) {
      access.dispose();
      frame.remove();
      throw error;
    }

    let disposed = false;
    let disposing: Promise<void> | null = null;
    let settleMount: { resolve: () => void; reject: (error: Error) => void } | null = null;
    let settleDispose: (() => void) | null = null;
    let settleRevocation: (() => void) | null = null;
    let revoking = false;
    const send = (message: StudioHostToFrameMessage) => {
      if (!disposed) {
        port.postMessage(message);
      }
    };

    port.addEventListener('message', (event: MessageEvent<StudioFrameToHostMessage>) => {
      const message = event.data;
      if (!isRecord(message)) {
        return;
      }
      switch (message.type) {
        case 'mounted': {
          const support = (message as { support?: { webCodecs?: unknown; webGpu?: unknown } }).support;
          if (support && typeof support === 'object') {
            services.reportLocalPreviewSupport?.({
              webCodecs: support.webCodecs === true,
              webGpu: support.webGpu === true,
            });
          }
          settleMount?.resolve();
          break;
        }
        case 'mount-failed': {
          settleMount?.reject(new Error(message.error));
          break;
        }
        case 'disposed': {
          settleRevocation?.();
          settleDispose?.();
          break;
        }
        case 'service': {
          if (!Number.isSafeInteger(message.callId)) {
            break;
          }
          // Own properties only: `constructor` or `__proto__` must not reach a handler lookup.
          const handler =
            typeof message.name === 'string' && Object.hasOwn(serviceCalls, message.name)
              ? serviceCalls[message.name]
              : undefined;
          const args = Array.isArray(message.args) ? message.args : [];
          const run = (async () => {
            await Promise.resolve();
            return message.name === 'authorizeGeneratedMedia'
              ? access.recheck()
              : handler
                ? handler(
                    services,
                    message.name === 'stageDraft' ? [storeGeneratedMedia(args[0]), ...args.slice(1)] : args,
                  )
                : Promise.reject(new Error(`Unknown service ${String((message as { name: unknown }).name)}`));
          })();
          void run
            .then((value) =>
              send({ type: 'service-result', callId: message.callId, ok: true, value: toFrameData(value) }),
            )
            .catch((error: unknown) =>
              send({
                type: 'service-result',
                callId: message.callId,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              }),
            );
          break;
        }
        case 'notify': {
          if (typeof message.message === 'string' && message.message.length > 0) {
            services.notify(message.message.slice(0, 500), message.tone === 'error' ? 'error' : 'info');
          }
          break;
        }
        case 'navigate': {
          const target = toNavigationTarget(message.target);
          if (target) {
            services.navigate(target);
          }
          break;
        }
        case 'dirty': {
          // The frame is not trusted to send a boolean.
          services.setDirty((message as { dirty: unknown }).dirty === true);
          break;
        }
        case 'fatal': {
          services.reportFatal(
            new Error(typeof message.error === 'string' ? message.error.slice(0, 500) : 'Studio failed'),
          );
          break;
        }
        case 'request-export': {
          services.requestExport?.('video');
          break;
        }
        case 'playhead': {
          const { num, den } = message.time ?? {};
          if (Number.isSafeInteger(num) && Number.isSafeInteger(den) && den > 0) {
            services.reportPlayhead?.({ num, den });
          }
          break;
        }
        case 'transport': {
          const { num, den } = message.time ?? {};
          if (Number.isSafeInteger(num) && Number.isSafeInteger(den) && den > 0 && num >= 0) {
            services.reportTransport?.({
              playing: (message as { playing: unknown }).playing === true,
              time: { num, den },
              seek: (message as { seek: unknown }).seek === true,
            });
          }
          break;
        }
      }
    });
    port.start();

    const teardown = () => {
      disposed = true;
      access.dispose();
      port.close();
      frame.remove();
    };

    revoke = (error) => {
      if (revoking || disposed || disposing) {
        return;
      }
      revoking = true;
      frame.style.visibility = 'hidden';
      access.dispose();
      void (async () => {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, DISPOSE_TIMEOUT_MS);
          settleRevocation = () => {
            clearTimeout(timer);
            resolve();
          };
          send({ type: 'revoke-generated' });
        });
        settleMount?.reject(error);
        teardown();
        services.reportFatal(error);
      })();
    };

    try {
      if (pendingRevocation) {
        throw pendingRevocation;
      }
      await new Promise<void>((resolve, reject) => {
        settleMount = { resolve, reject };
        send({ type: 'mount', protocolVersion: STUDIO_FRAME_PROTOCOL_VERSION, context: toFrameData(current) });
      });
    } catch (error) {
      teardown();
      throw error;
    } finally {
      settleMount = null;
    }

    let updating: Promise<void> = Promise.resolve();
    const instance: StudioEngineInstance = {
      update(next) {
        updating = updating
          .then(async () => {
            if (disposed || revoking || disposing) {
              return;
            }
            const generatedMedia = await access.admit(next.project.id, next.project.graph, next.project.revision);
            if (disposed || revoking || disposing) {
              return;
            }
            current = { ...next, generatedMedia };
            send({ type: 'update', context: toFrameData(current) });
          })
          .catch((error) => revoke(error instanceof Error ? error : new Error(String(error))));
      },
      dispose() {
        if (disposed) {
          return Promise.resolve();
        }
        access.dispose();
        disposing ??= (async () => {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, DISPOSE_TIMEOUT_MS);
            settleDispose = () => {
              clearTimeout(timer);
              resolve();
            };
            send({ type: 'dispose' });
          });
          teardown();
        })();
        return disposing;
      },
    };
    return instance;
  },

  async createCommandEngine(): Promise<StudioCommandEngine> {
    const frame = createFrame(document.body, documentUrl(base, manifest.commands), true);
    let port: MessagePort;
    try {
      port = await connect(frame, 'commands', manifest.engineRevision, helloTimeoutMs);
    } catch (error) {
      frame.remove();
      throw error;
    }
    let nextRequest = 1;
    const waiting = new Map<number, (outcome: StudioCommandApplyOutcome) => void>();
    port.addEventListener('message', (event: MessageEvent<StudioCommandFrameMessage>) => {
      const message = event.data;
      if (isRecord(message) && message.type === 'applied') {
        waiting.get(message.requestId)?.(message.outcome);
        waiting.delete(message.requestId);
      }
    });
    port.start();
    let closed = false;
    const access = createStudioGeneratedAccess(() => instance.dispose());

    const instance: StudioCommandEngine = {
      async apply(
        graph: unknown,
        envelopes: readonly StudioCommandEnvelope[],
        assets: readonly StudioAssetRef[],
        projectId?: string,
        projectImports?: readonly StudioProjectImportRef[],
      ) {
        if (closed) {
          return {
            status: 'rejected',
            index: 0,
            reason: 'failed',
            detail: 'The command engine was released',
          };
        }
        let generatedMedia;
        try {
          generatedMedia = await access.admit(projectId, graph);
        } catch (error) {
          return { status: 'rejected', index: 0, reason: 'failed', detail: String(error) };
        }
        if (closed) {
          return { status: 'rejected', index: 0, reason: 'failed', detail: 'Generated media was revoked' };
        }
        const requestId = nextRequest++;
        const request: StudioCommandApplyRequest = {
          type: 'apply',
          requestId,
          graph: toFrameData(storeGeneratedMedia(graph)),
          generatedMedia: toFrameData(generatedMedia),
          projectImports: toFrameData(projectImports),
          envelopes: toFrameData([...envelopes]),
          assets: toFrameData([...assets]),
        };
        return new Promise((resolve) => {
          waiting.set(requestId, resolve);
          port.postMessage(request);
        });
      },
      dispose() {
        if (closed) {
          return;
        }
        closed = true;
        access.dispose();
        for (const resolve of waiting.values()) {
          resolve({ status: 'rejected', index: 0, reason: 'failed', detail: 'The command engine was released' });
        }
        waiting.clear();
        port.close();
        frame.remove();
      },
    };
    return instance;
  },
});

/** One factory for the life of the page, so registering again is a no-op, not a second engine. */
const frameEngineFactory = async (): Promise<StudioEngineModule> =>
  createFrameStudioEngine({ manifest: await resolveStudioFrameManifest() });

/**
 * Make the built editor available to the loader. The loader still refuses it unless its revision is
 * the pinned one, so a stale deployment cannot mount.
 */
export const registerFrameStudioEngine = (): void => {
  registerStudioEngine(frameEngineFactory);
};
