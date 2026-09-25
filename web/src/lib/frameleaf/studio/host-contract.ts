/**
 * The Studio host adapter contract (FL-88, `STU-201`).
 *
 * Svelte stays the authentication, navigation, permission, library and settings host. The
 * vendored React editor is mounted into one element through the small typed lifecycle
 * boundary defined here: `mount` once, `update` when the host's view of the world changes,
 * `dispose` on exit or on access loss.
 *
 * Boundary rules, from `docs/docs/developer/frameleaf-plan/03-studio-rendering-and-restoration.md`
 * and from FL-96 (no client API dependency in preview):
 *
 * - The engine receives data, never credentials. There is no token, no API base URL and no
 *   SDK instance in `StudioHostContext`. Media arrives as already-authorized URLs the host
 *   built, and everything else goes through `StudioHostServices`.
 * - The engine never writes storage. A canonical change is a `StudioCommandEnvelope` handed to
 *   `submitCommands`; the editor's own autosave hands the complete graph to `stageDraft` (the
 *   FL-89 draft primitive). Either way the host applies revision, lease and access rules, and the
 *   server validates the envelope again before it stores a revision.
 * - The engine renders into the element it is given and owns nothing global. The host owns
 *   the route, the document title, the theme and the full-screen chrome.
 * - `dispose` must release media element sources and object URLs, AudioContexts, GPU
 *   devices, workers, subscriptions and the project lease, and must be safe to call twice.
 *
 * The adapters that satisfy this contract live outside `studio/vendor/freecut`, which is a
 * provenance-checked snapshot that no story edits.
 */
import type { StudioCapabilityId, StudioCommandEnvelope, StudioCommandResult, StudioDuration } from './commands';
import type { StudioPreviewView } from './preview';

/* ------------------------------------------------------------------ */
/* What the host tells the engine                                       */
/* ------------------------------------------------------------------ */

/**
 * Who is editing. Identity only: the engine shows it and attributes review comments with
 * it. Authorization is decided by the server on every command, never by this object.
 */
export interface StudioAuthContext {
  userId: string;
  name: string;
  /** Absolute URL for the avatar, or null when the account has no profile image. */
  avatarUrl: string | null;
  /** BCP 47 tag the shell resolved, so the engine formats numbers and dates the same way. */
  locale: string;
}

export type StudioAssetKind = 'image' | 'video';

/**
 * One item of library media the engine may place on the timeline. The host resolves every
 * URL with the session's own credentials before handing it over; the engine only ever puts
 * these strings into `src` attributes.
 */
export interface StudioAssetRef {
  id: string;
  kind: StudioAssetKind;
  name: string;
  /**
   * Source duration in seconds for video, null for stills — an exact rational (FL-93), not a
   * float. The library stores whole milliseconds, so 12500 ms arrives as 25/2 and a clip placed
   * at the end of this one starts at exactly 25/2, not at 12.499999999999998.
   */
  duration: StudioDuration | null;
  thumbnailUrl: string;
  previewUrl: string;
  /** Video playback source, null for stills. */
  playbackUrl: string | null;
  /** The original is missing from storage, so the engine must not offer it as a source. */
  isOffline: boolean;
  /** Pixel size the library recorded, when it has one; the engine probes the rest. */
  width?: number | null;
  height?: number | null;
  /** The original's MIME type, when the library knows it. */
  mimeType?: string | null;
}

/**
 * The resolved Frameleaf design tokens for the current theme, as a plain snapshot. The
 * engine styles itself from these rather than reaching into the host's stylesheet, so
 * React and Svelte never share a global CSS scope.
 */
export interface StudioThemeTokens {
  theme: 'dark' | 'light';
  /** Token name (with the leading `--`) to computed value. */
  tokens: Readonly<Record<string, string>>;
}

/**
 * What the deployment can actually do. Ordinary library use and the quick editor stay
 * GPU-free; full Studio needs a worker. `missing` is what the unavailable state names to
 * the person, so it must identify capabilities rather than say "unavailable".
 */
export interface StudioCapabilities {
  /** Local AI analysis: captioning, scene detection, silence and filler detection. */
  analysisWorker: boolean;
  /** Local generation: text to speech and music generation. */
  generationWorker: boolean;
  gpuWorker: boolean;
  renderWorker: boolean;
  restorationWorker: boolean;
  transcriptionWorker: boolean;
}

export const emptyStudioCapabilities = (): StudioCapabilities => ({
  analysisWorker: false,
  generationWorker: false,
  gpuWorker: false,
  renderWorker: false,
  restorationWorker: false,
  transcriptionWorker: false,
});

export const missingStudioCapabilities = (capabilities: StudioCapabilities): StudioCapabilityId[] =>
  (Object.keys(capabilities) as StudioCapabilityId[]).filter((id) => !capabilities[id]).sort();

/** The capabilities the editor cannot open at all without. */
export const requiredStudioCapabilities: readonly StudioCapabilityId[] = ['gpuWorker', 'renderWorker'];

export const unmetRequiredCapabilities = (capabilities: StudioCapabilities): StudioCapabilityId[] =>
  requiredStudioCapabilities.filter((id) => !capabilities[id]);

/**
 * A project the engine opens. `graph` is Freecut's own document, passed through opaquely:
 * the host stores and transports it and never interprets it, so a graph field the host
 * does not know about survives a round trip unchanged. `revision` is what commands are
 * issued against.
 */
export interface StudioProjectHandle {
  id: string;
  name: string;
  revision: number;
  /** Opaque Freecut graph. `null` while a project has been created but never saved. */
  graph: unknown;
  /** True when this session holds the write lease; false means read-only review. */
  hasLease: boolean;
}

export interface StudioHostContext {
  project: StudioProjectHandle;
  /**
   * Library media offered in the bin, including the selection a "make a movie" handoff
   * carried in. Ordering is the host's: the handoff selection first, in the order the
   * person chose it.
   */
  assets: readonly StudioAssetRef[];
  /** Asset ids the handoff asked the editor to start from, in order. */
  handoffAssetIds: readonly string[];
  auth: StudioAuthContext;
  theme: StudioThemeTokens;
  capabilities: StudioCapabilities;
  /**
   * The remote preview, as data (FL-96).
   *
   * This is the `preview-ready` direction of the preview contract. The engine asks for a frame
   * by sending a `preview.request` command envelope and receives the answer here on the next
   * `update`; it never fetches a frame itself, because it has nothing to fetch one with. The
   * phase is honest — `rendering`, `stale` and `unavailable` mean what they say — so the engine
   * and the host chrome can both show the truth rather than an old frame passed off as current.
   */
  preview: StudioPreviewView;
  /** False when the browser reports no network; the engine must go read-only. */
  online: boolean;
  /**
   * The workspace layout, when the host can store one (FL-91). Absent or `unavailable` means the
   * engine uses its defaults and must not assume anything it lays out is kept.
   */
  workspace?: StudioWorkspaceView;
  /**
   * Basic or Advanced (`Studio.jsx:2626-2633`, `setSettings({ mode })`). The host owns the
   * header's switch and hands the choice to the engine, which shows the fuller workspace in
   * Advanced. Absent means Basic.
   */
  mode?: StudioWorkspaceMode;
  /**
   * The few words the adapter's own chrome shows (the server preview panel), already translated by
   * the host, because the engine's locale files do not carry Frameleaf strings.
   */
  strings?: Readonly<Partial<Record<StudioAdapterString, string>>>;
}

export type StudioAdapterString =
  | 'previewTitle'
  | 'previewShow'
  | 'previewHide'
  | 'previewRendering'
  | 'previewStale'
  | 'previewUnavailable'
  | 'previewToneMapped'
  | 'previewNoWorker';

export type StudioWorkspaceMode = 'basic' | 'advanced';

/* ------------------------------------------------------------------ */
/* Workspace layout (FL-91)                                             */
/* ------------------------------------------------------------------ */

/**
 * The editor's own workspace: which panels are open, their sizes, the zoom of the timeline.
 *
 * Freecut keeps this in a workspace folder (`infrastructure/storage/workspace-fs`). In Frameleaf it
 * is stored per account on the server (`GET`/`PUT /studio/workspace`), never in a folder handle, so
 * it follows the person to Safari and Firefox and to another device. What it contains is the
 * engine's to define; the server keeps it as the same JSON value (not its key order). When it cannot be read or kept the host
 * says so plainly: `unavailable` means the engine starts from its own defaults and nothing it lays
 * out is persisted. It is never a silent no-op that looks like a save.
 *
 * The project document itself is not workspace state. It is stored, versioned and exported through
 * the project session and portable bundles, which work today.
 */
export type StudioWorkspaceView =
  /**
   * `engine-absent`: nothing to lay out yet. `storage-unavailable`: the server could not read the
   * stored layout (offline, or the fork schema mid-handoff), so the engine starts from defaults.
   */
  | { state: 'unavailable'; reason: 'engine-absent' | 'storage-unavailable' }
  | {
      state: 'ready';
      /** Opaque engine layout, returned as the same JSON value it was saved as (key order and spacing are not kept). */
      layout: unknown;
      savedAt: string | null;
    };

export type StudioWorkspaceSaveResult = { status: 'saved'; savedAt: string } | { status: 'unavailable' };

/**
 * The answer to `stageDraft`. `staged` means the host holds the graph and autosave will store it
 * as the next revision; every other status says why it will not, so the editor never believes an
 * edit is kept when it is not.
 */
export type StudioDraftResult =
  { status: 'staged' } | { status: 'rejected'; reason: 'invalid' | 'forbidden' | 'lease-lost' | 'offline' };

export const unavailableStudioWorkspace = (): StudioWorkspaceView => ({
  state: 'unavailable',
  reason: 'engine-absent',
});

/* ------------------------------------------------------------------ */
/* What the engine may ask the host to do                               */
/* ------------------------------------------------------------------ */

export type StudioNavigationTarget = { kind: 'library' } | { kind: 'activity' } | { kind: 'asset'; assetId: string };

export type StudioNotificationTone = 'info' | 'error';

/**
 * The only channel out of the engine. Every method is async or fire-and-forget on purpose:
 * the engine may not assume any of them succeed, and none of them expose transport
 * details.
 */
export interface StudioHostServices {
  /**
   * Submit an ordered batch. The host validates, authorizes and applies; the results come
   * back in the same order, one per envelope. A rejected envelope does not stop the ones
   * after it from being evaluated, so partial batches are reported honestly rather than
   * silently dropped.
   */
  submitCommands(envelopes: readonly StudioCommandEnvelope[]): Promise<StudioCommandResult[]>;
  /**
   * Hand the host the editor's complete graph after its own edits (FL-89 autosave, FL-92's
   * "replace graph" draft primitive). `commandIds` names the editor actions the draft contains,
   * for the revision summary. Optional: a host without project storage leaves it out and the
   * editor stays read-only.
   */
  stageDraft?(graph: unknown, commandIds: readonly string[]): Promise<StudioDraftResult>;
  /** Re-read the project, for reconciling after a `stale-revision` rejection. */
  reloadProject(): Promise<StudioProjectHandle>;
  /** Resolve one asset the engine knows only by id. */
  resolveAsset(assetId: string): StudioAssetRef | undefined;
  /** Show a message in the host's own notification surface. */
  notify(message: string, tone?: StudioNotificationTone): void;
  /** Ask the host to leave Studio. The host runs the unsaved-changes guard first. */
  navigate(target: StudioNavigationTarget): void;
  /**
   * Report whether the engine holds changes that are not yet persisted. The host uses it
   * for the save indicator and for the navigation guard; it is the engine's only way to
   * block a route change.
   */
  setDirty(dirty: boolean): void;
  /** Report a fatal engine error so the host can show its error state and dispose. */
  reportFatal(error: unknown): void;
  /**
   * Keep the workspace layout (FL-91). Optional: a host without workspace storage leaves it out or
   * answers `unavailable`, and the engine then keeps its layout for the session only.
   */
  saveWorkspace?(layout: unknown): Promise<StudioWorkspaceSaveResult>;
  /**
   * Report where the playhead is, as an exact rational instant (FL-93), so review comments the
   * person adds from the host's Review panel are pinned there (`Studio.jsx:1759`) rather than at
   * the start of the sequence. Optional; fire and forget.
   */
  reportPlayhead?(time: { num: number; den: number }): void;
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                            */
/* ------------------------------------------------------------------ */

export interface StudioEngineInstance {
  /**
   * The host calls this whenever the context changes (theme, capabilities, online state,
   * asset list, project revision). It must be cheap and must not remount.
   */
  update(context: StudioHostContext): void;
  /**
   * Release everything the engine acquired. Must be idempotent: the host calls it on route
   * change, on sign-out, on relock and on a fatal error, and any two of those can race.
   */
  dispose(): Promise<void> | void;
}

/**
 * Canonical command semantics against the real engine (FL-92). Given a stored graph and an ordered
 * batch, the engine applies every command with its own timeline actions and returns the resulting
 * graph, or refuses the whole batch and names the envelope that failed: a batch is atomic, so a
 * partial result is never staged.
 */
export interface StudioCommandEngine {
  apply(
    graph: unknown,
    envelopes: readonly StudioCommandEnvelope[],
    assets: readonly StudioAssetRef[],
  ): Promise<StudioCommandApplication>;
  dispose(): void;
}

export type StudioCommandApplication =
  | { status: 'applied'; graph: unknown; digest: string }
  | { status: 'rejected'; index: number; reason: 'invalid' | 'not-implemented' | 'failed'; detail: string };

export interface StudioEngineModule {
  /**
   * The pinned Freecut revision this adapter was built from. The loader refuses a module
   * whose revision is not the one `studio/freecut-provenance.json` records, so a stale or
   * substituted bundle cannot mount silently.
   */
  readonly engineRevision: string;
  /** Feature manifest rows this build claims. Used by the conformance work in FL-85. */
  readonly features: readonly string[];
  mount(target: HTMLElement, context: StudioHostContext, services: StudioHostServices): Promise<StudioEngineInstance>;
  /**
   * Start the command engine (FL-92), separate from any mounted editor so applying a command never
   * disturbs what the person is editing. Absent when the build has no command runtime.
   */
  createCommandEngine?(): Promise<StudioCommandEngine>;
}
