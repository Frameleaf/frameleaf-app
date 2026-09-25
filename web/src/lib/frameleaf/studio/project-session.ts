/**
 * The Studio project session (FL-89, `STU-202`).
 *
 * One object owns everything about persistence that the editor must never own: which project
 * is open, which revision the engine is editing, whether this tab holds the write lease, the
 * unsaved draft, and the conversation with the server about all of it. It is framework-free
 * so the rules are testable without a DOM, and the route wraps it in Svelte state.
 *
 * Rules, from `docs/docs/developer/frameleaf-plan/03-studio-rendering-and-restoration.md`:
 *
 * - **One writer.** The lease belongs to one editor instance (`clientId`), renewed every
 *   `renewMs`. A tab that finds the lease held elsewhere opens read-only and may take over only
 *   when the person asks; nothing here ever takes a lease implicitly.
 * - **Autosave stores a complete revision.** `stage(graph)` records the whole document and the
 *   commands that produced it; a pause of `autosaveDebounceMs` sends it as the next revision
 *   against `expectedRevision`. The request key is stable per document and per attempt: a retry
 *   after a lost response carries the same key and is answered with the same result, and a new
 *   `stage` gets a new key because it is a different document.
 * - **Drafts are never discarded by a failure.** A stale head, a lost lease, going offline and a
 *   transport failure all keep the draft in memory and change the status; only the person's
 *   explicit choice (reload, reacquire, take over, save as copy) resolves it.
 * - **Stale responses are ignored.** Every open and reload starts a new generation; a response
 *   from an earlier generation is dropped rather than applied over the current project.
 * - **Review is read-only.** A shared-space member gets the graph only when the server says
 *   every source resolved for them; `withheld` says so, and there is no draft and no lease.
 */
import {
  acquireStudioProjectLease,
  addStudioProjectComment,
  createStudioProject,
  getStudioProject,
  getStudioProjectComments,
  getStudioProjectHistory,
  releaseStudioProjectLease,
  restoreStudioProjectRevision,
  saveStudioProjectRevision,
  StudioProjectShelf,
  updateStudioProject,
  updateStudioProjectComment,
  type StudioCommentCreateDto,
  type StudioCommentDto,
  type StudioCommentListResponseDto,
  type StudioCommentUpdateDto,
  type StudioProjectCreateDto,
  type StudioProjectDetailDto,
  type StudioProjectEnvelopeDto,
  type StudioProjectHistoryResponseDto,
  type StudioProjectLeaseDto,
  type StudioProjectLeaseRequestDto,
  type StudioProjectResourcesDto,
  type StudioProjectRestoreDto,
  type StudioProjectSaveDto,
  type StudioProjectSaveResponseDto,
} from '@immich/sdk';
import type { StudioCommandEnvelope } from './commands';
import type { StudioProjectHandle } from './host-contract';

/* ------------------------------------------------------------------ */
/* Contract constants (mirrored from server/src/utils/studio-project.ts) */
/* ------------------------------------------------------------------ */

export const STUDIO_ENVELOPE_SCHEMA_VERSION = 1;
export const STUDIO_ENGINE = 'freecut';
/** Defaults until the server's lease response says otherwise; the response always wins. */
export const STUDIO_AUTOSAVE_DEBOUNCE_MS = 1500;
export const STUDIO_LEASE_RENEW_MS = 30_000;
/** First retry after a transport failure; doubles up to the cap. */
export const STUDIO_SAVE_RETRY_MS = 5000;
/** Canonical commands one save may carry; the server's `STUDIO_MAX_COMMANDS_PER_SAVE` (FL-92). */
export const STUDIO_MAX_COMMANDS_PER_SAVE = 500;
/**
 * Summary id for commands a save could not carry as envelopes (beyond the limit, or refused by the
 * server as a batch). Not a catalogue id, so the server keeps its count as reported.
 */
export const STUDIO_UNCHECKED_COMMANDS_SUMMARY = 'commands.unchecked';
export const STUDIO_SAVE_RETRY_MAX_MS = 60_000;
/** The id a project has before its first save creates it on the server. */
export const STUDIO_DRAFT_PROJECT_ID = 'draft';

/* ------------------------------------------------------------------ */
/* Conflicts                                                            */
/* ------------------------------------------------------------------ */

export type StudioConflictReason =
  | 'stale-revision'
  | 'lease-lost'
  | 'lease-held'
  | 'request-key-reused'
  | 'revision-missing'
  /** FL-91: the owner archived the project; it is read-only until brought back. */
  | 'project-archived'
  /** FL-91: the owner moved the project to the trash. */
  | 'project-trashed';

export interface StudioConflict {
  reason: StudioConflictReason;
  /** The head the server is on, when it said. */
  currentRevision: number | null;
  lease: StudioProjectLeaseDto | null;
}

const conflictReasons = new Set<string>([
  'stale-revision',
  'lease-lost',
  'lease-held',
  'request-key-reused',
  'revision-missing',
  'project-archived',
  'project-trashed',
]);

/** The project was put away (archived or trashed): nothing may be written until it is back. */
export const isShelvedConflict = (conflict: StudioConflict): boolean =>
  conflict.reason === 'project-archived' || conflict.reason === 'project-trashed';

/**
 * The status and body of a failed request, read structurally: the SDK's `HttpError` carries
 * both, and reading them by shape rather than by class keeps this independent of which runtime
 * instance threw.
 */
const httpFailure = (error: unknown): { status: number; data: unknown } | null => {
  if (!error || typeof error !== 'object') {
    return null;
  }
  const candidate = error as { status?: unknown; data?: unknown };
  return typeof candidate.status === 'number' ? { status: candidate.status, data: candidate.data } : null;
};

/** Read the server's `409` body, or null for anything that is not a Studio conflict. */
export const readStudioConflict = (error: unknown): StudioConflict | null => {
  const failure = httpFailure(error);
  if (!failure || failure.status !== 409) {
    return null;
  }
  const body = failure.data as { reason?: unknown; currentRevision?: unknown; lease?: unknown } | undefined;
  if (!body || typeof body.reason !== 'string' || !conflictReasons.has(body.reason)) {
    return null;
  }
  return {
    reason: body.reason as StudioConflictReason,
    currentRevision: typeof body.currentRevision === 'number' ? body.currentRevision : null,
    lease: body.lease && typeof body.lease === 'object' ? (body.lease as StudioProjectLeaseDto) : null,
  };
};

/** The server refused the request itself (`400`): sending it again unchanged cannot succeed. */
const isBadRequest = (error: unknown): boolean => httpFailure(error)?.status === 400;

const isNotFound = (error: unknown): boolean => {
  const status = httpFailure(error)?.status;
  return status === 404 || status === 403;
};

/* ------------------------------------------------------------------ */
/* State                                                                */
/* ------------------------------------------------------------------ */

export type StudioProjectStatus =
  /** Nothing opened yet. */
  | 'idle'
  | 'loading'
  /** Read-only: a reviewer, or an owner whose lease is held by another instance. */
  | 'review'
  | 'saved'
  /** A draft is staged and will be sent after the debounce. */
  | 'dirty'
  | 'saving'
  /** A draft is waiting for the connection to come back. */
  | 'offline'
  /** The head moved under the draft; the person chooses reload or save as copy. */
  | 'conflict'
  /** This instance no longer holds the lease; the draft is kept until the person decides. */
  | 'lease-lost'
  /** The project is not readable by this account any more. */
  | 'forbidden'
  | 'error';

export type StudioProjectAccess = 'owner' | 'reviewer';

export interface StudioProjectSessionState {
  status: StudioProjectStatus;
  project: StudioProjectHandle;
  access: StudioProjectAccess | null;
  /** Work in memory that the server has not accepted. */
  hasDraft: boolean;
  conflict: StudioConflict | null;
  /** Epoch milliseconds of the last accepted save in this session. */
  lastSavedAt: number | null;
  /** The server withheld the graph because a source is unavailable to this account. */
  withheld: boolean;
  resources: StudioProjectResourcesDto | null;
  /** Developer-facing detail for `error`; never the primary message. */
  error: string | null;
}

/* ------------------------------------------------------------------ */
/* Transport                                                            */
/* ------------------------------------------------------------------ */

/** The slice of the SDK the session uses, so tests inject a fake instead of mocking a module. */
export interface StudioProjectApi {
  get(id: string, signal?: AbortSignal): Promise<StudioProjectDetailDto>;
  create(dto: StudioProjectCreateDto): Promise<StudioProjectDetailDto>;
  save(id: string, dto: StudioProjectSaveDto): Promise<StudioProjectSaveResponseDto>;
  restore(id: string, dto: StudioProjectRestoreDto): Promise<StudioProjectSaveResponseDto>;
  acquireLease(id: string, dto: StudioProjectLeaseRequestDto): Promise<StudioProjectLeaseDto>;
  releaseLease(id: string, dto: StudioProjectLeaseRequestDto): Promise<unknown>;
  history(id: string, page: { skip: number; take: number }): Promise<StudioProjectHistoryResponseDto>;
  comments(id: string, page: { skip: number; take: number }): Promise<StudioCommentListResponseDto>;
  addComment(id: string, dto: StudioCommentCreateDto): Promise<StudioCommentDto>;
  updateComment(id: string, commentId: string, dto: StudioCommentUpdateDto): Promise<StudioCommentDto>;
  /** Rename a saved project; answers with the stored name. */
  rename(id: string, name: string): Promise<{ name: string }>;
}

export const studioProjectSdkApi: StudioProjectApi = {
  get: (id, signal) => getStudioProject({ id }, { signal }),
  create: (studioProjectCreateDto) => createStudioProject({ studioProjectCreateDto }),
  save: (id, studioProjectSaveDto) => saveStudioProjectRevision({ id, studioProjectSaveDto }),
  restore: (id, studioProjectRestoreDto) => restoreStudioProjectRevision({ id, studioProjectRestoreDto }),
  acquireLease: (id, studioProjectLeaseRequestDto) => acquireStudioProjectLease({ id, studioProjectLeaseRequestDto }),
  releaseLease: (id, studioProjectLeaseRequestDto) => releaseStudioProjectLease({ id, studioProjectLeaseRequestDto }),
  history: (id, { skip, take }) => getStudioProjectHistory({ id, skip, take }),
  comments: (id, { skip, take }) => getStudioProjectComments({ id, skip, take }),
  addComment: (id, studioCommentCreateDto) => addStudioProjectComment({ id, studioCommentCreateDto }),
  updateComment: (id, commentId, studioCommentUpdateDto) =>
    updateStudioProjectComment({ id, commentId, studioCommentUpdateDto }),
  rename: (id, name) => updateStudioProject({ id, studioProjectUpdateDto: { name } }),
};

/* ------------------------------------------------------------------ */
/* Session                                                              */
/* ------------------------------------------------------------------ */

export type CancelTimer = () => void;

export interface StudioProjectSessionOptions {
  api?: StudioProjectApi;
  /** This editor instance. One per mount, never persisted. */
  clientId: string;
  /** The project to open, or null for a new draft that is created on its first save. */
  projectId: string | null;
  /** The name a new draft is created with. */
  name: string;
  /** The pinned engine revision the graph was produced by. */
  engineRevision: string;
  onChange: (state: StudioProjectSessionState) => void;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => CancelTimer;
  isOnline?: () => boolean;
  newKey?: () => string;
}

export interface StudioProjectSession {
  readonly state: StudioProjectSessionState;
  /** Load the project (or start the draft) and, for the owner, take the lease. */
  open(): Promise<void>;
  /**
   * Record the engine's current document and the command ids that produced it since the last
   * stage. The save happens after the debounce, not now. `envelopes` are the canonical commands the
   * engine applied (FL-92); they travel with the save, and the server checks them and counts the
   * revision summary from them.
   */
  stage(graph: unknown, commands?: readonly string[], envelopes?: readonly StudioCommandEnvelope[]): void;
  /** Send the staged draft now, if there is one. */
  flush(): Promise<void>;
  /** Discard the draft and re-read the project. Resolves a `conflict` by accepting the head. */
  reload(): Promise<StudioProjectHandle>;
  /** Ask for the lease again after `lease-lost`; resubmits the draft when the head is unchanged. */
  reacquire(): Promise<boolean>;
  /** Take the lease away from another of this account's instances. Explicit by design. */
  takeOver(): Promise<boolean>;
  /** Save the draft (or the current graph) as a new project and switch to it. Returns its id. */
  saveAsCopy(name: string): Promise<string | null>;
  /**
   * Rename the project (`Studio.jsx` `renameProject`). A draft keeps the name for its first save;
   * a saved project is renamed on the server. Resolves false when the name was refused.
   */
  rename(name: string): Promise<boolean>;
  /** Append an earlier revision as the new head. Flushes any draft first. */
  restore(revision: number): Promise<boolean>;
  history(skip: number, take: number): Promise<StudioProjectHistoryResponseDto>;
  comments(skip: number, take: number): Promise<StudioCommentListResponseDto>;
  addComment(dto: StudioCommentCreateDto): Promise<StudioCommentDto>;
  updateComment(commentId: string, dto: StudioCommentUpdateDto): Promise<StudioCommentDto>;
  setOnline(online: boolean): void;
  /** Release the lease, cancel timers and ignore every response still in flight. */
  dispose(): Promise<void>;
}

type Draft = {
  graph: unknown;
  counts: Record<string, number>;
  total: number;
  /** Canonical commands behind this draft (FL-92), sent with the save; at most the per-save limit. */
  envelopes: StudioCommandEnvelope[];
  /** Commands over the per-save envelope limit, reported as a count only. */
  unchecked: number;
  /** Assigned on the first attempt and kept for retries; a new `stage` clears it. */
  requestKey: string | null;
};

const defaultTimer = (callback: () => void, ms: number): CancelTimer => {
  const handle = setTimeout(callback, ms);
  return () => clearTimeout(handle);
};

const defaultKey = (): string =>
  typeof globalThis.crypto?.randomUUID === 'function'
    ? crypto.randomUUID()
    : `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const emptyEnvelope = (engineRevision: string, graph: unknown): StudioProjectEnvelopeDto => ({
  schemaVersion: STUDIO_ENVELOPE_SCHEMA_VERSION,
  engine: STUDIO_ENGINE,
  engineRevision,
  graph: (graph ?? {}) as Record<string, unknown>,
});

const draftHandle = (name: string): StudioProjectHandle => ({
  id: STUDIO_DRAFT_PROJECT_ID,
  name,
  revision: 0,
  graph: null,
  hasLease: true,
});

export const createStudioProjectSession = (options: StudioProjectSessionOptions): StudioProjectSession => {
  const api = options.api ?? studioProjectSdkApi;
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? defaultTimer;
  const isOnline = options.isOnline ?? (() => globalThis.navigator?.onLine);
  const newKey = options.newKey ?? defaultKey;
  const { clientId, engineRevision } = options;

  let state: StudioProjectSessionState = {
    status: 'idle',
    project: draftHandle(options.name),
    access: null,
    hasDraft: false,
    conflict: null,
    lastSavedAt: null,
    withheld: false,
    resources: null,
    error: null,
  };

  let projectId: string | null = options.projectId;
  let draft: Draft | null = null;
  let debounce: CancelTimer | null = null;
  let renew: CancelTimer | null = null;
  let retry: CancelTimer | null = null;
  let retryMs = STUDIO_SAVE_RETRY_MS;
  let saving: Promise<void> | null = null;
  /** The draft a save is carrying right now; a `stage` meanwhile starts a fresh summary. */
  let inflightDraft: Draft | null = null;
  let autosaveMs = STUDIO_AUTOSAVE_DEBOUNCE_MS;
  let renewMs = STUDIO_LEASE_RENEW_MS;
  /** Bumped by open, reload, saveAsCopy and dispose; responses from an older value are dropped. */
  let generation = 0;
  let disposed = false;
  let inflight: AbortController | null = null;

  const emit = (patch: Partial<StudioProjectSessionState>) => {
    state = { ...state, ...patch, hasDraft: draft !== null };
    options.onChange(state);
  };

  const cancel = (timer: CancelTimer | null) => {
    timer?.();
  };

  const stopTimers = () => {
    cancel(debounce);
    cancel(renew);
    cancel(retry);
    debounce = null;
    renew = null;
    retry = null;
  };

  const restStatus = (): StudioProjectStatus => {
    if (state.access === 'reviewer' || !state.project.hasLease) {
      return 'review';
    }
    return draft ? 'dirty' : 'saved';
  };

  const applyLease = (lease: StudioProjectLeaseDto) => {
    autosaveMs = lease.autosaveDebounceMs || autosaveMs;
    renewMs = lease.renewMs || renewMs;
  };

  const scheduleRenewal = (gen: number) => {
    cancel(renew);
    renew = setTimer(() => {
      renew = null;
      void renewLease(gen);
    }, renewMs);
  };

  const renewLease = async (gen: number) => {
    if (gen !== generation || !projectId || !state.project.hasLease) {
      return;
    }
    try {
      const lease = await api.acquireLease(projectId, { clientId });
      if (gen !== generation) {
        return;
      }
      applyLease(lease);
      scheduleRenewal(gen);
    } catch (error) {
      if (gen !== generation) {
        return;
      }
      const conflict = readStudioConflict(error);
      if (conflict) {
        if (isShelvedConflict(conflict)) {
          shelve(conflict);
        } else {
          loseLease(conflict);
        }
        return;
      }
      // A transport failure proves nothing about the lease; the next save will say.
      scheduleRenewal(gen);
    }
  };

  /**
   * The owner archived or trashed the project while it was open (FL-91). It turns read-only; an
   * unsaved draft is kept in this tab, and the navigation guard still asks before it is lost.
   */
  const shelve = (conflict: StudioConflict) => {
    cancel(renew);
    renew = null;
    cancel(debounce);
    debounce = null;
    cancel(retry);
    retry = null;
    emit({ status: 'review', project: { ...state.project, hasLease: false }, conflict });
  };

  const loseLease = (conflict: StudioConflict) => {
    cancel(renew);
    renew = null;
    cancel(debounce);
    debounce = null;
    emit({
      status: 'lease-lost',
      project: { ...state.project, hasLease: false },
      conflict,
    });
  };

  const applyDetail = (detail: StudioProjectDetailDto, gen: number, leaseHeld: boolean) => {
    if (gen !== generation) {
      return;
    }
    projectId = detail.id;
    emit({
      project: {
        id: detail.id,
        name: detail.name,
        revision: detail.revision,
        graph: detail.envelope?.graph ?? null,
        hasLease: leaseHeld,
      },
      access: detail.access,
      withheld: detail.withheld,
      resources: detail.resources,
      error: null,
    });
  };

  const fail = (error: unknown, gen: number) => {
    if (gen !== generation) {
      return;
    }
    if (isNotFound(error)) {
      draft = null;
      stopTimers();
      emit({ status: 'forbidden', project: { ...state.project, hasLease: false }, conflict: null, error: null });
      return;
    }
    emit({ status: 'error', error: error instanceof Error ? error.message : String(error) });
  };

  /** Read the project and, for the owner, take the lease. Never touches the draft. */
  const load = async (gen: number, { keepDraft }: { keepDraft: boolean }) => {
    if (!projectId) {
      emit({ status: 'saved', project: draftHandle(options.name), access: 'owner', conflict: null, error: null });
      return;
    }

    emit({ status: 'loading', error: null });
    inflight?.abort();
    inflight = typeof AbortController === 'function' ? new AbortController() : null;

    let detail: StudioProjectDetailDto;
    try {
      detail = await api.get(projectId, inflight?.signal);
    } catch (error) {
      fail(error, gen);
      return;
    }
    if (gen !== generation) {
      return;
    }

    // An archived or trashed project opens read-only, for its owner too: it takes no lease (FL-91).
    const shelved = detail.shelf === StudioProjectShelf.Archived || detail.shelf === StudioProjectShelf.Trashed;
    if (detail.access !== 'owner' || shelved) {
      applyDetail(detail, gen, false);
      emit({ status: 'review', conflict: null });
      return;
    }

    try {
      const lease = await api.acquireLease(detail.id, { clientId });
      if (gen !== generation) {
        return;
      }
      applyLease(lease);
      applyDetail(detail, gen, lease.heldByYou);
      scheduleRenewal(gen);
      emit({ status: keepDraft && draft ? 'dirty' : 'saved', conflict: null });
      if (keepDraft && draft) {
        scheduleFlush();
      }
    } catch (error) {
      if (gen !== generation) {
        return;
      }
      const conflict = readStudioConflict(error);
      if (conflict) {
        // Another instance is editing, or the project was put away in the meantime. Open for
        // review; for a live project the person may take over explicitly.
        applyDetail(detail, gen, false);
        emit({ status: isShelvedConflict(conflict) ? 'review' : 'lease-lost', conflict });
        return;
      }
      fail(error, gen);
    }
  };

  const scheduleFlush = () => {
    cancel(debounce);
    debounce = setTimer(() => {
      debounce = null;
      void flush();
    }, autosaveMs);
  };

  const scheduleRetry = () => {
    cancel(retry);
    retry = setTimer(() => {
      retry = null;
      void flush();
    }, retryMs);
    retryMs = Math.min(retryMs * 2, STUDIO_SAVE_RETRY_MAX_MS);
  };

  /**
   * The summary a save reports. With envelopes, the server counts catalogue commands from them, so
   * commands over the per-save limit are added under one non-catalogue id; without envelopes (after
   * a quarantine) the counts are reported as they are, unchecked.
   */
  const summaryOf = (current: Draft) => {
    if (current.unchecked === 0 || current.envelopes.length === 0) {
      return { counts: current.counts, total: current.total };
    }
    return {
      counts: { ...current.counts, [STUDIO_UNCHECKED_COMMANDS_SUMMARY]: current.unchecked },
      total: current.total + current.unchecked,
    };
  };

  /** One save attempt for the current draft. Serialized: a second call waits for the first. */
  const flush = async (): Promise<void> => {
    if (saving) {
      await saving;
      return;
    }
    if (!draft || disposed) {
      return;
    }
    if (['conflict', 'lease-lost', 'forbidden'].includes(state.status)) {
      // These are the person's to resolve; autosave must not keep knocking.
      return;
    }
    if (!isOnline()) {
      emit({ status: 'offline' });
      return;
    }

    const gen = generation;
    const current = draft;
    current.requestKey ??= newKey();
    inflightDraft = current;
    emit({ status: 'saving', error: null });

    saving = (async () => {
      try {
        let result: { revision: number; lease: StudioProjectLeaseDto | null };
        if (projectId) {
          const saved = await api.save(projectId, {
            clientId,
            requestKey: current.requestKey as string,
            expectedRevision: state.project.revision,
            envelope: emptyEnvelope(engineRevision, current.graph),
            summary: summaryOf(current),
            ...(current.envelopes.length > 0 && {
              commands: current.envelopes.map((envelope) => ({
                id: envelope.id,
                payload: envelope.payload as unknown as Record<string, unknown>,
                revision: envelope.revision,
                idempotencyKey: envelope.idempotencyKey,
                issuedAt: envelope.issuedAt,
              })),
            }),
          });
          if (gen !== generation) {
            return;
          }
          result = { revision: saved.revision, lease: saved.lease };
        } else {
          const created = await api.create({
            name: state.project.name,
            clientId,
            envelope: emptyEnvelope(engineRevision, current.graph),
            requestKey: current.requestKey ?? undefined,
          });
          if (gen !== generation) {
            return;
          }
          projectId = created.id;
          emit({
            project: { ...state.project, id: created.id, name: created.name, hasLease: created.lease.heldByYou },
            access: 'owner',
          });
          result = { revision: created.revision, lease: created.lease };
        }

        if (result.lease) {
          applyLease(result.lease);
        }
        retryMs = STUDIO_SAVE_RETRY_MS;
        // A newer stage while this one was in flight keeps its own draft and gets its own save.
        if (draft === current) {
          draft = null;
        }
        emit({
          project: { ...state.project, revision: result.revision, graph: current.graph },
          lastSavedAt: now(),
          conflict: null,
          error: null,
          status: draft ? 'dirty' : 'saved',
        });
        if (state.project.hasLease) {
          scheduleRenewal(gen);
        }
        if (draft) {
          scheduleFlush();
        }
      } catch (error) {
        if (gen !== generation) {
          return;
        }
        const conflict = readStudioConflict(error);
        if (conflict) {
          if (conflict.reason === 'stale-revision' || conflict.reason === 'revision-missing') {
            emit({ status: 'conflict', conflict });
          } else if (conflict.reason === 'request-key-reused') {
            // Same key, different document: a client bug. Take a fresh key rather than loop.
            current.requestKey = null;
            emit({ status: 'error', conflict, error: 'The save request key was reused for a different document' });
          } else if (isShelvedConflict(conflict)) {
            shelve(conflict);
          } else {
            loseLease(conflict);
          }
          return;
        }
        if (isNotFound(error)) {
          fail(error, gen);
          return;
        }
        if (isBadRequest(error)) {
          // Final: the same request would be refused again. When the draft carried canonical
          // commands, they are the likely cause (FL-92): quarantine them as a count and save the
          // document on its own, once, with a fresh key. Otherwise the document itself was refused;
          // it stays in memory for Save as copy, and the next edit sends a new document.
          const message = error instanceof Error ? error.message : String(error);
          current.requestKey = null;
          if (current.envelopes.length > 0 && draft === current) {
            current.unchecked = 0;
            current.envelopes = [];
            emit({ status: 'dirty', error: message });
            scheduleFlush();
            return;
          }
          emit({ status: 'error', error: message });
          return;
        }
        if (!isOnline()) {
          emit({ status: 'offline' });
          return;
        }
        // Lost response or server trouble: the same key is retried, so a save that did land is
        // answered with its result rather than applied twice.
        emit({ status: 'dirty', error: error instanceof Error ? error.message : String(error) });
        scheduleRetry();
      } finally {
        saving = null;
        inflightDraft = null;
      }
    })();

    await saving;
  };

  const requireProject = (): string => {
    if (!projectId) {
      throw new Error('The project has not been saved yet');
    }
    return projectId;
  };

  const acquire = async (takeover: boolean): Promise<boolean> => {
    const id = requireProject();
    const gen = generation;
    try {
      const lease = await api.acquireLease(id, { clientId, takeover });
      if (gen !== generation) {
        return false;
      }
      applyLease(lease);
      if (!lease.heldByYou) {
        return false;
      }
      // The lease is back. The draft is only safe to send if the head did not move underneath it.
      const detail = await api.get(id);
      if (gen !== generation) {
        return false;
      }
      const headMoved = detail.revision !== state.project.revision;
      if (headMoved && draft) {
        applyDetail(detail, gen, true);
        emit({
          status: 'conflict',
          conflict: { reason: 'stale-revision', currentRevision: detail.revision, lease },
        });
        scheduleRenewal(gen);
        return true;
      }
      if (draft) {
        emit({ project: { ...state.project, hasLease: true } });
      } else {
        applyDetail(detail, gen, true);
      }
      emit({ status: draft ? 'dirty' : 'saved', conflict: null });
      scheduleRenewal(gen);
      if (draft) {
        scheduleFlush();
      }
      return true;
    } catch (error) {
      if (gen !== generation) {
        return false;
      }
      const conflict = readStudioConflict(error);
      if (conflict) {
        emit({ status: 'lease-lost', conflict });
        return false;
      }
      fail(error, gen);
      return false;
    }
  };

  const session: StudioProjectSession = {
    get state() {
      return state;
    },

    async open() {
      generation += 1;
      await load(generation, { keepDraft: false });
    },

    stage(graph, commands = [], envelopes = []) {
      // Edits made after the lease was lost are kept with the draft until the person reacquires,
      // takes over or saves a copy; they are never dropped (FL-89).
      const keepsDraft = state.status === 'lease-lost' && state.access === 'owner';
      if (disposed || state.access === 'reviewer' || (!state.project.hasLease && !keepsDraft)) {
        return;
      }
      // Commands already travelling in a save belong to that revision's summary, not the next.
      const base = draft && draft !== inflightDraft ? draft : null;
      const counts: Record<string, number> = base ? { ...base.counts } : {};
      for (const id of commands) {
        counts[id] = (counts[id] ?? 0) + 1;
      }
      // A save carries at most the per-save limit of envelopes (FL-92); the oldest beyond it travel
      // as a count, and a draft that reaches the limit is sent now rather than after the pause.
      const merged = [...(base?.envelopes ?? []), ...envelopes];
      const overflow = Math.max(0, merged.length - STUDIO_MAX_COMMANDS_PER_SAVE);
      draft = {
        graph,
        counts,
        total: (base?.total ?? 0) + commands.length,
        envelopes: merged.slice(overflow),
        unchecked: (base?.unchecked ?? 0) + overflow,
        // A different document is a different request; the key is assigned when it is sent.
        requestKey: null,
      };
      if (keepsDraft) {
        emit({ project: { ...state.project, graph } });
        return;
      }
      if (state.status === 'conflict') {
        // The person has not decided yet; more edits join the draft and wait with it.
        emit({ project: { ...state.project, graph } });
        return;
      }
      // A document the server refused ('error') gets a fresh attempt with the next edit.
      emit({ project: { ...state.project, graph }, status: isOnline() ? 'dirty' : 'offline' });
      if (isOnline()) {
        if (draft.envelopes.length >= STUDIO_MAX_COMMANDS_PER_SAVE) {
          void flush();
        } else {
          scheduleFlush();
        }
      }
    },

    async flush() {
      cancel(debounce);
      debounce = null;
      await flush();
    },

    async reload() {
      draft = null;
      stopTimers();
      generation += 1;
      await load(generation, { keepDraft: false });
      return state.project;
    },

    async reacquire() {
      return acquire(false);
    },

    async takeOver() {
      return acquire(true);
    },

    async rename(name) {
      const next = name.trim();
      if (!next) {
        return false;
      }
      if (!projectId) {
        emit({ project: { ...state.project, name: next } });
        return true;
      }
      const gen = generation;
      try {
        const renamed = await api.rename(projectId, next);
        if (gen === generation) {
          emit({ project: { ...state.project, name: renamed.name } });
        }
        return true;
      } catch {
        return false;
      }
    },

    async saveAsCopy(name) {
      const graph = draft?.graph ?? state.project.graph;
      if (graph === null || graph === undefined) {
        return null;
      }
      const previous = generation;
      generation += 1;
      const gen = generation;
      stopTimers();
      try {
        const created = await api.create({
          name,
          clientId,
          envelope: emptyEnvelope(engineRevision, graph),
          requestKey: newKey(),
        });
        if (gen !== generation) {
          return created.id;
        }
        draft = null;
        applyLease(created.lease);
        applyDetail(created, gen, created.lease.heldByYou);
        emit({ status: 'saved', conflict: null, lastSavedAt: now() });
        scheduleRenewal(gen);
        return created.id;
      } catch (error) {
        if (gen === generation) {
          generation = previous;
          emit({
            status: state.conflict ? 'conflict' : 'error',
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return null;
      }
    },

    async restore(revision) {
      const id = requireProject();
      if (!state.project.hasLease) {
        return false;
      }
      await session.flush();
      if (draft || state.status === 'conflict' || state.status === 'lease-lost') {
        return false;
      }
      const gen = generation;
      try {
        const result = await api.restore(id, {
          clientId,
          requestKey: newKey(),
          expectedRevision: state.project.revision,
          revision,
        });
        if (gen !== generation) {
          return false;
        }
        applyLease(result.lease);
        const detail = await api.get(id);
        if (gen !== generation) {
          return false;
        }
        applyDetail(detail, gen, true);
        emit({ status: 'saved', conflict: null, lastSavedAt: now() });
        scheduleRenewal(gen);
        return true;
      } catch (error) {
        if (gen !== generation) {
          return false;
        }
        const conflict = readStudioConflict(error);
        if (conflict) {
          if (conflict.reason === 'lease-lost' || conflict.reason === 'lease-held') {
            loseLease(conflict);
          } else if (isShelvedConflict(conflict)) {
            shelve(conflict);
          } else {
            emit({ status: 'conflict', conflict });
          }
          return false;
        }
        fail(error, gen);
        return false;
      }
    },

    history(skip, take) {
      if (!projectId) {
        return Promise.resolve({ items: [], total: 0 });
      }
      return api.history(projectId, { skip, take });
    },

    comments(skip, take) {
      if (!projectId) {
        return Promise.resolve({ items: [], total: 0 });
      }
      return api.comments(projectId, { skip, take });
    },

    addComment(dto) {
      return api.addComment(requireProject(), dto);
    },

    updateComment(commentId, dto) {
      return api.updateComment(requireProject(), commentId, dto);
    },

    setOnline(online) {
      if (disposed) {
        return;
      }
      if (!online) {
        cancel(debounce);
        debounce = null;
        cancel(retry);
        retry = null;
        if (draft) {
          emit({ status: 'offline' });
        }
        return;
      }
      if (state.status === 'offline') {
        emit({ status: draft ? 'dirty' : restStatus() });
        if (draft) {
          scheduleFlush();
        }
      }
    },

    async dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      generation += 1;
      stopTimers();
      inflight?.abort();
      const heldId = state.project.hasLease && projectId ? projectId : null;
      draft = null;
      if (heldId) {
        try {
          await api.releaseLease(heldId, { clientId });
        } catch {
          // The lease lapses on its own; nothing else to do on the way out.
        }
      }
    },
  };

  return session;
};
