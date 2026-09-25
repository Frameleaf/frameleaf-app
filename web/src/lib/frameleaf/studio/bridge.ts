/**
 * The typed command bridge (FL-88, vocabulary from FL-92).
 *
 * Everything the React editor wants to change arrives here first. The bridge is the only
 * place that decides whether a command may proceed, and it decides in a fixed order so the
 * answer a person gets is the true reason:
 *
 *   1. shape        — an envelope that is not an envelope, or names an unknown command
 *   2. access       — the session no longer has the project
 *   3. connectivity — nothing can be submitted while offline
 *   4. lease        — read-only review sessions cannot mutate the graph
 *   5. revision     — the editor was editing an older project than the host holds
 *   6. capability   — the command needs a worker this deployment does not have
 *   7. ownership    — the semantics belong to a later story and are not implemented yet
 *
 * A later story implementing a command replaces step 7 for that row only, by supplying an
 * `apply` handler; nothing else here changes. Until then the editor gets an explicit
 * `not-implemented` rejection, never a silent success and never a no-op that looks like one.
 *
 * The bridge never touches the network itself. It delegates to the `apply` handler the host
 * supplies, which is where the authorized service call lives, so the engine has no client
 * API dependency at all (FL-96).
 */
import type { StudioCommandEnvelope, StudioCommandId, StudioCommandResult } from './commands';
import {
  isStudioCommandEnvelope,
  isStudioCommandImplemented,
  studioCommandDefinition,
  studioCommandRejection,
} from './commands';
import type { StudioCapabilities } from './host-contract';

export interface StudioBridgeContext {
  /** The project revision the host currently holds. */
  revision: number;
  /** This session may write. False for a review-only session or a lost lease. */
  hasLease: boolean;
  /** The session still has access to the project. */
  hasAccess: boolean;
  online: boolean;
  capabilities: StudioCapabilities;
}

/**
 * Applies one validated command. Supplied by the story that owns the command's semantics;
 * it returns the new project revision on success. Throwing is treated as `failed`, so a
 * handler never has to build a result object for the unhappy path.
 */
export type StudioCommandHandler = (envelope: StudioCommandEnvelope) => Promise<number>;

/**
 * Thrown by a handler that decided the command cannot apply, with the reason the person should
 * hear (`invalid` for a payload the graph contradicts, `not-implemented` for an intent the engine
 * has no equivalent for). Settled like any other decision: a retry of the same key gets the same
 * answer. Anything else a handler throws is an unknown outcome and stays retryable.
 */
export class StudioCommandRejectedError extends Error {
  constructor(
    readonly reason: 'invalid' | 'not-implemented' | 'failed',
    message: string,
  ) {
    super(message);
    this.name = 'StudioCommandRejectedError';
  }
}

export interface StudioBridgeOptions {
  /** Read the live context at submission time, not at construction time. */
  context: () => StudioBridgeContext;
  /**
   * Handlers by command id. A missing entry means the command is a typed extension point:
   * it is accepted by the vocabulary, validated here and rejected as `not-implemented`.
   */
  handlers?: Partial<Record<StudioCommandId, StudioCommandHandler>>;
}

export interface StudioBridge {
  submit(envelopes: readonly StudioCommandEnvelope[]): Promise<StudioCommandResult[]>;
}

const keyOf = (candidate: unknown): string => {
  const key = (candidate as { idempotencyKey?: unknown })?.idempotencyKey;
  return typeof key === 'string' && key.length > 0 && key.length <= 128 ? key : 'unknown';
};

export const createStudioBridge = ({ context, handlers = {} }: StudioBridgeOptions): StudioBridge => {
  /**
   * Results already returned, so a retry of a dropped response cannot apply twice. The map
   * is per mount: a fresh mount re-reads the project and starts a new revision chain, so
   * keeping it longer would only risk answering a new command with an old result.
   */
  const settled = new Map<string, StudioCommandResult>();

  const evaluate = async (candidate: unknown): Promise<StudioCommandResult> => {
    const key = keyOf(candidate);

    const previous = settled.get(key);
    if (previous) {
      return previous;
    }

    if (!isStudioCommandEnvelope(candidate)) {
      // Not recorded as settled: a malformed message carries no trustworthy key.
      return studioCommandRejection(key, 'invalid');
    }

    const envelope = candidate;
    const { revision, hasLease, hasAccess, online, capabilities } = context();
    const definition = studioCommandDefinition(envelope.id);

    const reject = (reason: Parameters<typeof studioCommandRejection>[1], withRevision?: number) => {
      const result = studioCommandRejection(envelope.idempotencyKey, reason, withRevision);
      settled.set(envelope.idempotencyKey, result);
      return result;
    };

    if (!hasAccess) {
      return reject('forbidden');
    }

    if (!online) {
      // Not settled: the same command is legitimate once the connection returns.
      return studioCommandRejection(envelope.idempotencyKey, 'offline');
    }

    if (definition.mutatesGraph && !hasLease) {
      return reject('lease-lost');
    }

    if (definition.mutatesGraph && envelope.revision !== revision) {
      // The editor must reconcile against the revision the host reports.
      return studioCommandRejection(envelope.idempotencyKey, 'stale-revision', revision);
    }

    if (definition.requiresCapability && !capabilities[definition.requiresCapability]) {
      return reject('capability-missing');
    }

    const handler = handlers[envelope.id];
    if (!handler) {
      // Guards the registry against drifting from the handler table: a row this story
      // claims to own must have a handler, or the claim is wrong.
      return reject(isStudioCommandImplemented(envelope.id) ? 'failed' : 'not-implemented');
    }

    try {
      const nextRevision = await handler(envelope);
      const result: StudioCommandResult = {
        status: 'accepted',
        idempotencyKey: envelope.idempotencyKey,
        revision: nextRevision,
      };
      settled.set(envelope.idempotencyKey, result);
      return result;
    } catch (error) {
      if (error instanceof StudioCommandRejectedError) {
        return reject(error.reason);
      }
      // Not settled: a transport failure leaves the outcome unknown, and the editor may
      // legitimately retry the same key.
      return studioCommandRejection(envelope.idempotencyKey, 'failed');
    }
  };

  return {
    /**
     * Evaluated in order, one at a time: later commands in a batch depend on the revision
     * earlier ones produced, so they cannot be evaluated concurrently.
     */
    async submit(envelopes) {
      const results: StudioCommandResult[] = [];
      for (const envelope of envelopes) {
        results.push(await evaluate(envelope));
      }
      return results;
    },
  };
};
