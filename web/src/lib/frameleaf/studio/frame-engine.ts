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
 * - **No credentials.** The frame receives the host context (data) and nothing else. Every service
 *   call it makes is answered here, by the same `StudioHostServices` the route built.
 * - **Complete disposal.** `dispose` asks the editor to release what it holds, then removes the
 *   frame, which ends every AudioContext, GPU device, worker and object URL it created.
 */
import type { StudioCommandEnvelope } from './commands';
import { registerStudioEngine, StudioEngineNotBuiltError } from './engine-loader';
import {
  isStudioFrameHello,
  STUDIO_FRAME_PROTOCOL_VERSION,
  type StudioCommandApplyOutcome,
  type StudioCommandApplyRequest,
  type StudioCommandFrameMessage,
  type StudioFrameManifest,
  type StudioFrameServiceName,
  type StudioFrameToHostMessage,
  type StudioHostToFrameMessage,
} from './frame-protocol';
import type {
  StudioAssetRef,
  StudioCommandEngine,
  StudioEngineInstance,
  StudioEngineModule,
  StudioHostContext,
  StudioHostServices,
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

type ServiceCall = (services: StudioHostServices, args: unknown[]) => Promise<unknown>;

/** The services a frame may call, each checked for shape before it reaches the host. */
const serviceCalls: Record<StudioFrameServiceName, ServiceCall> = {
  submitCommands: (services, [envelopes]) =>
    services.submitCommands(Array.isArray(envelopes) ? (envelopes as StudioCommandEnvelope[]) : []),
  stageDraft: (services, [graph, commandIds]) =>
    services.stageDraft
      ? services.stageDraft(
          graph,
          Array.isArray(commandIds) ? commandIds.filter((id): id is string => typeof id === 'string') : [],
        )
      : Promise.resolve({ status: 'rejected', reason: 'forbidden' } as const),
  reloadProject: (services) => services.reloadProject(),
  saveWorkspace: (services, [layout]) =>
    services.saveWorkspace ? services.saveWorkspace(layout) : Promise.resolve({ status: 'unavailable' } as const),
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
    const frame = createFrame(target, documentUrl(base, manifest.editor), false);
    let port: MessagePort;
    try {
      port = await connect(frame, 'editor', manifest.engineRevision, helloTimeoutMs);
    } catch (error) {
      frame.remove();
      throw error;
    }

    let disposed = false;
    let settleMount: { resolve: () => void; reject: (error: Error) => void } | null = null;
    let settleDispose: (() => void) | null = null;
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
          settleMount?.resolve();
          break;
        }
        case 'mount-failed': {
          settleMount?.reject(new Error(message.error));
          break;
        }
        case 'disposed': {
          settleDispose?.();
          break;
        }
        case 'service': {
          const handler = serviceCalls[message.name];
          const args = Array.isArray(message.args) ? message.args : [];
          const run = handler ? handler(services, args) : Promise.reject(new Error(`Unknown service ${message.name}`));
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
          services.notify(message.message, message.tone === 'error' ? 'error' : 'info');
          break;
        }
        case 'navigate': {
          services.navigate(message.target);
          break;
        }
        case 'dirty': {
          services.setDirty(message.dirty);
          break;
        }
        case 'fatal': {
          services.reportFatal(new Error(message.error));
          break;
        }
        case 'playhead': {
          const { num, den } = message.time ?? {};
          if (Number.isSafeInteger(num) && Number.isSafeInteger(den) && den > 0) {
            services.reportPlayhead?.({ num, den });
          }
          break;
        }
      }
    });
    port.start();

    const teardown = () => {
      disposed = true;
      port.close();
      frame.remove();
    };

    try {
      await new Promise<void>((resolve, reject) => {
        settleMount = { resolve, reject };
        send({ type: 'mount', protocolVersion: STUDIO_FRAME_PROTOCOL_VERSION, context: toFrameData(context) });
      });
    } catch (error) {
      teardown();
      throw error;
    } finally {
      settleMount = null;
    }

    let disposing: Promise<void> | null = null;
    const instance: StudioEngineInstance = {
      update(next) {
        send({ type: 'update', context: toFrameData(next) });
      },
      dispose() {
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

    return {
      apply(graph: unknown, envelopes: readonly StudioCommandEnvelope[], assets: readonly StudioAssetRef[]) {
        if (closed) {
          return Promise.resolve({
            status: 'rejected',
            index: 0,
            reason: 'failed',
            detail: 'The command engine was released',
          });
        }
        const requestId = nextRequest++;
        const request: StudioCommandApplyRequest = {
          type: 'apply',
          requestId,
          graph: toFrameData(graph),
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
        for (const resolve of waiting.values()) {
          resolve({ status: 'rejected', index: 0, reason: 'failed', detail: 'The command engine was released' });
        }
        waiting.clear();
        port.close();
        frame.remove();
      },
    };
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
