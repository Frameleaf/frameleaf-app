/**
 * Canonical command semantics in the host (FL-92, `STU-205`).
 *
 * The bridge (`bridge.ts`) has already decided shape, access, connectivity, lease, revision and
 * capability by the time a handler here runs. These handlers give the graph-changing rows their
 * meaning:
 *
 * - **Apply** — the command runtime of the built engine (`frame-engine.ts` → `studio/adapters/web`)
 *   applies the envelope to the session's current graph with Freecut's own timeline actions, and
 *   the result is staged as the next draft, which autosave stores as a revision (FL-89).
 * - **Validate** — the engine refuses an envelope the graph contradicts (a missing clip, a time
 *   outside it, media the session was not given); that refusal is settled and named, never a
 *   silent no-op. The whole batch the engine was given is atomic.
 * - **Undo / redo** — `history.undo` and `history.redo` walk the graphs this session replaced,
 *   newest first, whether a canonical command or the editor's own autosave replaced them. With
 *   `toRevision`, or with nothing left in this session's history, undo restores a stored revision:
 *   history is append-only, so the restore is itself a new revision (FL-89).
 */
import type { StudioCommandHandler } from './bridge';
import { StudioCommandRejectedError } from './bridge';
import type { StudioCommandEnvelope, StudioCommandId } from './commands';
import type { StudioAssetRef, StudioCommandEngine, StudioProjectImportRef } from './host-contract';

/**
 * The canonical commands whose semantics the engine provides. Kept here, not in the adapter, so the
 * host and the command runtime read one list; the adapter test checks it covers all 19 Freecut
 * public command rows plus the FL-94 timeline tools.
 */
export const studioEngineCommandIds = [
  'captions.set',
  'clip.add',
  'clip.delete',
  'clip.group',
  'clip.insert',
  'clip.join',
  'clip.move',
  'clip.overwrite',
  'clip.push',
  'clip.relink',
  'clip.reorder',
  'clip.roll',
  'clip.setAudio',
  'clip.setKenBurns',
  'clip.setLink',
  'clip.setMask',
  'clip.setSpeed',
  'clip.setTransform',
  'clip.setTransformParent',
  'clip.setTransition',
  'clip.slide',
  'clip.slip',
  'clip.split',
  'clip.trimEnd',
  'clip.trimStart',
  'clip.ungroup',
  'clip.update',
  'composition.add',
  'composition.setControlOverrides',
  'composition.setPublishedControls',
  'effect.add',
  'effect.remove',
  'keyframe.add',
  'keyframe.remove',
  'keyframe.setEasing',
  'keyframe.update',
  'lottie.update',
  'marker.add',
  'marker.remove',
  'marker.update',
  'media.relink',
  'music.add',
  'project.applyTemplate',
  'project.setMasterAudio',
  'property.bakeModifier',
  'property.setExpression',
  'property.setModifier',
  'sequence.setSettings',
  'shape.add',
  'shape.setStyle',
  'text.setMotion',
  'title.add',
  'title.setStyle',
  'track.add',
  'track.closeGap',
  'track.remove',
  'track.reorder',
  'track.set',
  'track.setAudio',
] as const satisfies readonly StudioCommandId[];

export type StudioEngineCommandId = (typeof studioEngineCommandIds)[number];

/** How many replaced graphs one session keeps for undo, as the prototype does (`HISTORY_LIMIT`). */
export const STUDIO_HISTORY_LIMIT = 100;

export interface StudioGraphHistory {
  /** Record that `before` was replaced by `after`; clears anything that could have been redone. */
  record(before: unknown, after: unknown): void;
  /** The graph to go back to, or null when this session has nothing to undo. */
  undo(current: unknown): unknown;
  /** The graph to go forward to, or null. */
  redo(current: unknown): unknown;
  clear(): void;
  readonly depth: { undo: number; redo: number };
}

export const createStudioGraphHistory = (limit = STUDIO_HISTORY_LIMIT): StudioGraphHistory => {
  const past: unknown[] = [];
  const future: unknown[] = [];
  return {
    record(before) {
      past.push(before);
      if (past.length > limit) {
        past.shift();
      }
      future.length = 0;
    },
    undo(current) {
      if (past.length === 0) {
        return null;
      }
      future.push(current);
      return past.pop();
    },
    redo(current) {
      if (future.length === 0) {
        return null;
      }
      past.push(current);
      return future.pop();
    },
    clear() {
      past.length = 0;
      future.length = 0;
    },
    get depth() {
      return { undo: past.length, redo: future.length };
    },
  };
};

export interface StudioEngineCommandOptions {
  /** The graph the session holds now (the draft, or the stored head). */
  graph: () => unknown;
  projectId?: () => string;
  /** The session identity fences an account/project A–B–A transition during engine awaits. */
  origin?: () => unknown;
  /** The project revision the bridge reports back. */
  revision: () => number;
  /** Library media the session may place. */
  assets: () => readonly StudioAssetRef[];
  projectImports?: () => readonly StudioProjectImportRef[];
  /** Relink is complete only after its leased save is acknowledged. */
  commitRelink?: (graph: unknown, revision: number) => Promise<boolean>;
  /**
   * Stage a graph as the next draft, with the command ids for the revision summary and the envelopes
   * the server checks and counts (FL-92). Answers as the project session does: `ignored` or
   * `superseded` means the draft was not kept (the project was deleted or the session closed while
   * the engine worked), and the command is then refused rather than reported as applied.
   */
  stage: (
    graph: unknown,
    commandIds: readonly string[],
    envelopes: readonly StudioCommandEnvelope[],
  ) => 'staged' | 'ignored' | 'superseded' | void;
  /** Append a stored revision as the new head (FL-89 restore). */
  restore: (revision: number) => Promise<boolean>;
  /** The engine's command runtime; started on first use. */
  engine: () => Promise<StudioCommandEngine | null>;
  history: StudioGraphHistory;
}

const rejectedBy = (reason: 'invalid' | 'not-implemented' | 'failed' | 'stale-revision', detail: string) =>
  new StudioCommandRejectedError(reason, detail);

const kept = (outcome: 'staged' | 'ignored' | 'superseded' | void) => outcome !== 'ignored' && outcome !== 'superseded';

const notKept = () => rejectedBy('failed', 'The project can no longer be edited here, so the change was not kept');

export const createStudioEngineCommandHandlers = (
  options: StudioEngineCommandOptions,
): Partial<Record<StudioCommandId, StudioCommandHandler>> => {
  const apply: StudioCommandHandler = async (envelope: StudioCommandEnvelope) => {
    const graph = options.graph();
    const origin = options.origin?.();
    const projectId = options.projectId?.();
    if (!graph || typeof graph !== 'object') {
      throw rejectedBy('invalid', 'The project has no graph to edit yet');
    }
    const engine = await options.engine();
    if (!engine) {
      throw rejectedBy('failed', 'The Studio engine is not available');
    }
    const outcome = await engine.apply(graph, [envelope], options.assets(), projectId, options.projectImports?.());
    if (outcome.status === 'rejected') {
      throw rejectedBy(outcome.reason, outcome.detail);
    }
    // The editor may have saved a newer draft while the engine worked; this result was computed
    // from the older graph and must not overwrite it.
    if (options.graph() !== graph || options.projectId?.() !== projectId || options.origin?.() !== origin) {
      throw rejectedBy('stale-revision', 'The project changed while the command was applied');
    }
    if (envelope.id === 'media.relink') {
      if (!options.commitRelink || !(await options.commitRelink(outcome.graph, envelope.revision))) {
        throw notKept();
      }
    } else if (!kept(options.stage(outcome.graph, [envelope.id], [envelope]))) {
      throw notKept();
    }
    options.history.record(graph, outcome.graph);
    return options.revision();
  };

  const step = (direction: 'undo' | 'redo'): StudioCommandHandler => {
    return async (envelope) => {
      const toRevision = (envelope.payload as { toRevision?: unknown }).toRevision;
      if (toRevision !== undefined) {
        if (!Number.isSafeInteger(toRevision) || (toRevision as number) < 1) {
          throw rejectedBy('invalid', 'toRevision must be a stored revision number');
        }
        if (toRevision === options.revision()) {
          return options.revision();
        }
        // A stored revision comes back as a new one; this session's own history no longer applies.
        if (!(await options.restore(toRevision as number))) {
          throw rejectedBy('invalid', `Revision ${String(toRevision)} could not be restored`);
        }
        options.history.clear();
        return options.revision();
      }
      const current = options.graph();
      const target = direction === 'undo' ? options.history.undo(current) : options.history.redo(current);
      if (target !== null && target !== undefined) {
        if (!kept(options.stage(target, [envelope.id], [envelope]))) {
          // Step the history back so it still describes the graph the session holds.
          if (direction === 'undo') {
            options.history.redo(target);
          } else {
            options.history.undo(target);
          }
          throw notKept();
        }
        return options.revision();
      }
      if (direction === 'undo' && options.revision() > 1) {
        // Nothing left in this session: step back one stored revision.
        if (!(await options.restore(options.revision() - 1))) {
          throw rejectedBy('failed', 'The previous revision could not be restored');
        }
        return options.revision();
      }
      throw rejectedBy('invalid', direction === 'undo' ? 'There is nothing to undo' : 'There is nothing to redo');
    };
  };

  const handlers: Partial<Record<StudioCommandId, StudioCommandHandler>> = {
    'history.undo': step('undo'),
    'history.redo': step('redo'),
  };
  for (const id of studioEngineCommandIds) {
    handlers[id] = apply;
  }
  return handlers;
};
