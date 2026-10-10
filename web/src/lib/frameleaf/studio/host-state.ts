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

/**
 * Why the host is `unavailable`. The two recover differently: a deployment whose required
 * workers come online mounts the engine without the person doing anything, while an engine
 * that is not part of the build (or failed to load) stays unavailable until they retry.
 */
export type StudioUnavailableReason = 'capabilities' | 'engine-absent';

export interface StudioHostState {
  phase: StudioHostPhase;
  /** True once the engine has mounted and not yet been disposed. */
  mounted: boolean;
  /**
   * The last capabilities the server reported, or null until the probe has answered. Before
   * the probe answers nothing is judged missing: an unknown deployment is not a deficient one.
   */
  capabilities: StudioCapabilities | null;
  /** Named capabilities the deployment is missing, for the unavailable state. */
  missingCapabilities: readonly StudioCapabilityId[];
  /** Why the phase is `unavailable`; null in every other phase. */
  unavailableReason: StudioUnavailableReason | null;
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
  capabilities: null,
  missingCapabilities: [],
  unavailableReason: null,
  engineAbsence: null,
  messageKey: null,
  detail: null,
  dirty: false,
});

export type StudioHostEvent =
  /** `null` means the probe has not answered yet, which says nothing about the deployment. */
  | { type: 'capabilities'; capabilities: StudioCapabilities | null }
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

/**
 * True when the engine may be mounted in this state: the probe has answered, nothing blocks
 * the editor, and no engine is running yet.
 */
export const studioHostCanMount = (state: StudioHostState): boolean =>
  state.phase === 'loading' && !state.mounted && state.capabilities !== null;

/**
 * True when a transition needs the host to (re)mount the engine: the state has just become
 * mountable, because the probe answered with the required workers, because they came online
 * after the unavailable state, or because the person pressed Try again. Only the transition
 * itself counts, so a burst of identical events mounts once.
 */
export const studioHostNeedsMount = (previous: StudioHostState, next: StudioHostState): boolean =>
  studioHostCanMount(next) && !studioHostCanMount(previous);

/**
 * True when a transition enters a phase the engine must not run in. A mount still starting
 * at that moment has to be abandoned, or it would land after the teardown and be left running.
 */
export const studioHostAbandonsMount = (previous: StudioHostState, next: StudioHostState): boolean =>
  shouldDisposeEngine(next.phase) && !shouldDisposeEngine(previous.phase);

/** The phase a host that is not blocked by anything returns to. */
const settledPhase = (state: StudioHostState): StudioHostPhase => (state.mounted ? 'ready' : 'loading');

const unavailableForCapabilities = (
  state: StudioHostState,
  capabilities: StudioCapabilities,
  missing: StudioCapabilityId[],
): StudioHostState => ({
  ...state,
  phase: 'unavailable',
  unavailableReason: 'capabilities',
  mounted: false,
  capabilities,
  missingCapabilities: missing,
  messageKey: 'frameleaf_studio_unavailable_body',
  detail: null,
  dirty: false,
});

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
        unavailableReason: null,
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
      // Coming back online only clears the offline state itself. A missing capability is still
      // missing, and a mounted engine keeps running. An engine that failed to load while offline
      // was never proof of anything, so the host tries it again from `loading`.
      if (state.phase !== 'offline') {
        return state;
      }
      if (state.capabilities && state.missingCapabilities.length > 0) {
        return unavailableForCapabilities(state, state.capabilities, [...state.missingCapabilities]);
      }
      return {
        ...state,
        phase: settledPhase(state),
        unavailableReason: null,
        messageKey: null,
      };
    }

    case 'capabilities': {
      const capabilities = event.capabilities;
      if (!capabilities) {
        // The probe has not answered. Nothing is missing yet; the host keeps loading.
        return state;
      }
      const missing = unmetRequiredCapabilities(capabilities);
      if (missing.length > 0) {
        // Offline outranks unavailable (the probe proves nothing), and an absent engine is the
        // more fundamental reason, so both keep their phase and only record what is missing.
        if (state.phase === 'offline' || state.unavailableReason === 'engine-absent') {
          return { ...state, capabilities, missingCapabilities: missing };
        }
        return unavailableForCapabilities(state, capabilities, missing);
      }
      if (state.phase === 'unavailable' && state.unavailableReason === 'capabilities') {
        // The required workers arrived: this unavailability is over, so go back to loading
        // and let the host mount the engine (see `studioHostNeedsMount`).
        return {
          ...state,
          phase: settledPhase(state),
          unavailableReason: null,
          capabilities,
          missingCapabilities: [],
          messageKey: null,
          detail: null,
        };
      }
      return { ...state, capabilities, missingCapabilities: [] };
    }

    case 'engine-absent': {
      if (state.phase === 'offline') {
        // An engine bundle that failed to arrive while offline says nothing about the build.
        return { ...state, engineAbsence: event.reason, detail: event.detail ?? null };
      }
      return {
        ...state,
        phase: 'unavailable',
        unavailableReason: 'engine-absent',
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
        unavailableReason: null,
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
      // A retry starts over, but what the probe already said still holds: retrying with the
      // required workers still missing stays unavailable rather than mounting an engine that
      // cannot render. A still-running engine (offline keeps it) is not mounted twice.
      const fresh: StudioHostState = {
        ...initialStudioHostState(),
        mounted: state.mounted,
        capabilities: state.capabilities,
      };
      const missing = state.capabilities ? unmetRequiredCapabilities(state.capabilities) : [];
      if (state.capabilities && missing.length > 0) {
        return unavailableForCapabilities(fresh, state.capabilities, missing);
      }
      return { ...fresh, phase: settledPhase(fresh) };
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
