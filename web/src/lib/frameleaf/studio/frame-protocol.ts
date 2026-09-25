/**
 * The message protocol between the Studio host and the Freecut editor frame (FL-88, FL-92).
 *
 * The React editor runs in its own same-origin document, built by `studio/adapters/web`, and the
 * host talks to it over one `MessageChannel` per mount. The frame is the isolation the plan asks
 * for (`03-studio-rendering-and-restoration.md`, "Isolate React routing/styles, hotkeys and
 * focus"): React, its router, its stylesheet, its stores and its global listeners live in a
 * document the Svelte app never shares, and removing the frame is what finally releases every
 * AudioContext, GPU device, worker and object URL the editor made, even one its own teardown
 * missed. It is not a security boundary: the document is same-origin, shares the session's cookies
 * and could reach the parent. The host still checks every message it receives.
 *
 * Only structured-cloneable data crosses: the host context, service calls and their answers. No
 * function, SDK instance, token or API base URL is posted; that keeps the engine's dependencies
 * explicit, but a same-origin frame is trusted code, not a sandbox. This file is imported by the
 * adapter build as well, so it stays free of Svelte and of runtime imports from the web app.
 */
import type { StudioCommandEnvelope, StudioCommandResult } from './commands';
import type {
  StudioDraftResult,
  StudioHostContext,
  StudioNavigationTarget,
  StudioNotificationTone,
  StudioProjectHandle,
  StudioWorkspaceSaveResult,
} from './host-contract';

/** Bumped when a message changes shape; a frame built for another version is refused. */
export const STUDIO_FRAME_PROTOCOL_VERSION = 1;

/** The engine build publishes this next to its documents (`/studio-engine/manifest.json`). */
export interface StudioFrameManifest {
  protocolVersion: number;
  /** The Freecut revision the build was prepared from; the loader refuses any other. */
  engineRevision: string;
  /** Adapted source digest from `studio/engine-build.json`, for the audit trail. */
  sourceSha256: string;
  /** Feature manifest rows the build claims (FL-85 conformance). */
  features: string[];
  /** Documents relative to the manifest. */
  editor: string;
  commands: string;
}

/** Services the frame may call. Each maps one-to-one onto `StudioHostServices`. */
export interface StudioFrameServiceCalls {
  submitCommands: { args: [envelopes: StudioCommandEnvelope[]]; result: StudioCommandResult[] };
  stageDraft: { args: [graph: unknown, commandIds: string[], baseRevision?: number]; result: StudioDraftResult };
  reloadProject: { args: []; result: StudioProjectHandle };
  saveWorkspace: { args: [layout: unknown]; result: StudioWorkspaceSaveResult };
}

export type StudioFrameServiceName = keyof StudioFrameServiceCalls;

/* Host → editor frame */
export type StudioHostToFrameMessage =
  | { type: 'mount'; protocolVersion: number; context: StudioHostContext }
  | { type: 'update'; context: StudioHostContext }
  | { type: 'dispose' }
  | { type: 'service-result'; callId: number; ok: true; value: unknown }
  | { type: 'service-result'; callId: number; ok: false; error: string };

/* Editor frame → host */
export type StudioFrameToHostMessage =
  | {
      type: 'mounted';
      /** What this browser can preview locally; without WebCodecs the server preview opens by itself. */
      support?: { webCodecs: boolean; webGpu: boolean };
    }
  | { type: 'mount-failed'; error: string }
  | { type: 'disposed' }
  | { type: 'service'; callId: number; name: StudioFrameServiceName; args: unknown[] }
  | { type: 'notify'; message: string; tone?: StudioNotificationTone }
  | { type: 'navigate'; target: StudioNavigationTarget }
  | { type: 'dirty'; dirty: boolean }
  | { type: 'fatal'; error: string }
  | { type: 'playhead'; time: { num: number; den: number } }
  /** The editor's Export: the host opens its own export dialog (render workers, rights, Activity). */
  | { type: 'request-export'; kind: 'video' };

/* Host → command frame (FL-92): apply canonical commands to a graph with the real engine. */
export interface StudioCommandApplyRequest {
  type: 'apply';
  requestId: number;
  /** The Freecut project graph the commands apply to, exactly as stored. */
  graph: unknown;
  envelopes: StudioCommandEnvelope[];
  /** Library media the commands may reference, for durations and frame rates. */
  assets: StudioHostContext['assets'];
}

export type StudioCommandApplyOutcome =
  | {
      status: 'applied';
      graph: unknown;
      /** Canonical SHA-256 of the graph, so equal results are provably equal. */
      digest: string;
    }
  | {
      status: 'rejected';
      /** Index of the envelope that failed; nothing in the batch was applied. */
      index: number;
      reason: 'invalid' | 'not-implemented' | 'failed';
      detail: string;
    };

export type StudioCommandFrameMessage =
  | { type: 'ready'; protocolVersion: number; engineRevision: string }
  | { type: 'applied'; requestId: number; outcome: StudioCommandApplyOutcome };

/** The frame documents announce themselves on `window.parent` with this message before the port. */
export interface StudioFrameHello {
  source: 'frameleaf-studio-frame';
  kind: 'editor' | 'commands';
  protocolVersion: number;
  engineRevision: string;
}

export const isStudioFrameHello = (value: unknown): value is StudioFrameHello => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const hello = value as Record<string, unknown>;
  return (
    hello.source === 'frameleaf-studio-frame' &&
    (hello.kind === 'editor' || hello.kind === 'commands') &&
    typeof hello.protocolVersion === 'number' &&
    typeof hello.engineRevision === 'string'
  );
};
