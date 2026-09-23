import type { Translations } from 'svelte-i18n';
/**
 * The Studio host state machine (FL-88).
 *
 * The route can be in one of six states, and which one wins matters: a person who has lost
 * access must never be told "no GPU worker", and a person on a plane must not be told
 * their session expired. This module is a pure reducer so that precedence is testable
 * without a DOM, a network or React.
 *
 * Precedence, highest first:
 *   forbidden > offline > unavailable > error > loading > ready
 *
 * `forbidden` outranks everything because it is about access, and the host disposes the
 * engine when it is reached so private state leaves the page. `offline` outranks
 * `unavailable` because a capability probe that could not reach the server proves nothing.
 */
import type { StudioCapabilityId } from './commands';
import type { StudioEngineAbsenceReason } from './engine-loader';
import type { StudioCapabilities } from './host-contract';
import { unmetRequiredCapabilities } from './host-contract';

export type StudioHostPhase = 'loading' | 'ready' | 'unavailable' | 'forbidden' | 'offline' | 'error';

export interface StudioHostState {
  phase: StudioHostPhase;
  /** True once the engine has mounted and not yet been disposed. */
  mounted: boolean;
  /** Named capabilities the deployment is missing, for the unavailable state. */
  missingCapabilities: readonly StudioCapabilityId[];
  /** Why the engine itself could not be resolved, when that is the reason. */
  engineAbsence: StudioEngineAbsenceReason | null;
  /** i18n key for the body text of the current non-ready state. */
  messageKey: Translations | null;
  /** Developer-facing detail; never rendered as the primary message. */
  detail: string | null;
  /** The engine reports unpersisted changes, so the navigation guard is armed. */
  dirty: boolean;
}

export const initialStudioHostState = (): StudioHostState => ({
  phase: 'loading',
  mounted: false,
  missingCapabilities: [],
  engineAbsence: null,
  messageKey: null,
  detail: null,
  dirty: false,
});

export type StudioHostEvent =
  | { type: 'capabilities'; capabilities: StudioCapabilities }
  | { type: 'engine-absent'; reason: StudioEngineAbsenceReason; messageKey: Translations; detail?: string }
  | { type: 'engine-mounted' }
  | { type: 'engine-disposed' }
  | { type: 'connectivity'; online: boolean }
  | { type: 'access-lost' }
  | { type: 'fatal'; detail?: string }
  | { type: 'dirty'; dirty: boolean }
  | { type: 'retry' };

/**
 * A state the engine must not be running in. The host disposes on entering any of them:
 * `forbidden` so private frames, audio and cached media leave the page, and the others
 * because an editor that cannot save is worse than no editor.
 */
const disposingPhases: ReadonlySet<StudioHostPhase> = new Set<StudioHostPhase>(['forbidden', 'unavailable', 'error']);

export const shouldDisposeEngine = (phase: StudioHostPhase): boolean => disposingPhases.has(phase);

/** A mount that lands while one of these holds is recorded, but does not make the host ready. */
const PHASES_THAT_OUTRANK_MOUNTING: ReadonlySet<StudioHostPhase> = new Set(['offline', 'unavailable', 'error']);

export const reduceStudioHost = (state: StudioHostState, event: StudioHostEvent): StudioHostState => {
  // Access loss is terminal for this mount, so nothing below can move out of it.
  if (state.phase === 'forbidden' && event.type !== 'retry') {
    return state;
  }

  switch (event.type) {
    case 'access-lost': {
      return {
        ...state,
        phase: 'forbidden',
        mounted: false,
        // The person lost access; what the deployment can render is not their problem.
        missingCapabilities: [],
        engineAbsence: null,
        messageKey: 'frameleaf_studio_forbidden_body',
        detail: null,
        // The draft is gone with the engine, so the guard must not block the redirect.
        dirty: false,
      };
    }

    case 'connectivity': {
      if (!event.online) {
        return {
          ...state,
          phase: 'offline',
          messageKey: 'frameleaf_studio_offline_body',
          detail: null,
        };
      }
      // Coming back online only clears the offline state itself. A missing capability or a
      // missing engine is still missing, and a mounted engine keeps running.
      if (state.phase !== 'offline') {
        return state;
      }
      return {
        ...state,
        phase: state.mounted ? 'ready' : 'loading',
        messageKey: null,
      };
    }

    case 'capabilities': {
      const missing = unmetRequiredCapabilities(event.capabilities);
      if (missing.length > 0) {
        return {
          ...state,
          phase: state.phase === 'offline' ? 'offline' : 'unavailable',
          mounted: false,
          missingCapabilities: missing,
          messageKey: state.phase === 'offline' ? state.messageKey : 'frameleaf_studio_unavailable_body',
          detail: null,
          dirty: false,
        };
      }
      return { ...state, missingCapabilities: [] };
    }

    case 'engine-absent': {
      if (state.phase === 'offline') {
        // An engine bundle that failed to arrive while offline says nothing about the build.
        return { ...state, engineAbsence: event.reason, detail: event.detail ?? null };
      }
      return {
        ...state,
        phase: 'unavailable',
        mounted: false,
        engineAbsence: event.reason,
        messageKey: event.messageKey,
        detail: event.detail ?? null,
        dirty: false,
      };
    }

    case 'engine-mounted': {
      if (PHASES_THAT_OUTRANK_MOUNTING.has(state.phase)) {
        return { ...state, mounted: true };
      }
      return { ...state, phase: 'ready', mounted: true, messageKey: null, detail: null };
    }

    case 'engine-disposed': {
      return { ...state, mounted: false, dirty: false };
    }

    case 'fatal': {
      return {
        ...state,
        phase: 'error',
        mounted: false,
        messageKey: 'frameleaf_studio_error_body',
        detail: event.detail ?? null,
        dirty: false,
      };
    }

    case 'dirty': {
      if (state.dirty === event.dirty) {
        return state;
      }
      // Only a running engine can hold a draft.
      return { ...state, dirty: event.dirty && state.mounted };
    }

    case 'retry': {
      return { ...initialStudioHostState(), dirty: false };
    }
  }
};

/** The heading key for a non-ready state, or null when the editor is up. */
export const studioHostHeadingKey = (state: StudioHostState): Translations | null => {
  switch (state.phase) {
    case 'ready': {
      return null;
    }
    case 'loading': {
      return 'frameleaf_studio_loading_title';
    }
    case 'forbidden': {
      return 'frameleaf_studio_forbidden_title';
    }
    case 'offline': {
      return 'frameleaf_studio_offline_title';
    }
    case 'unavailable': {
      return 'frameleaf_studio_unavailable_title';
    }
    case 'error': {
      return 'frameleaf_studio_error_title';
    }
  }
};

/** Retrying is only useful where the condition can change without a reload. */
export const studioHostCanRetry = (state: StudioHostState): boolean =>
  ['offline', 'error', 'unavailable'].includes(state.phase);

/** The navigation guard blocks only while a running engine holds unsaved work. */
export const studioHostBlocksNavigation = (state: StudioHostState): boolean => state.dirty && state.mounted;

/**
 * Capability names the unavailable state lists, as i18n keys. Spelled out rather than
 * interpolated so every key in this file is greppable in `i18n/en.json`.
 */
const capabilityLabelKeys: Record<StudioCapabilityId, Translations> = {
  analysisWorker: 'frameleaf_studio_capability_analysis_worker',
  generationWorker: 'frameleaf_studio_capability_generation_worker',
  gpuWorker: 'frameleaf_studio_capability_gpu_worker',
  renderWorker: 'frameleaf_studio_capability_render_worker',
  restorationWorker: 'frameleaf_studio_capability_restoration_worker',
  transcriptionWorker: 'frameleaf_studio_capability_transcription_worker',
};

export const studioCapabilityLabelKey = (id: StudioCapabilityId): Translations => capabilityLabelKeys[id];
