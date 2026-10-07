import { StudioCommandRejectedError, type StudioBridgeContext, type StudioCommandHandler } from './bridge';
import { createStudioCommandEnvelope, type StudioCommandEnvelope } from './commands';
import { createStudioEngineCommandHandlers, type StudioEngineCommandOptions } from './engine-commands';
import type { StudioCommandEngine, StudioTranscriptionProgress } from './host-contract';

export interface StudioTranscriptionJob {
  id: string;
  status: 'queued' | 'running' | 'applied' | 'cancelled' | 'failed';
  progress?: StudioTranscriptionProgress;
  detail?: string;
}

/** A browser job owns its frame; revocation destroys workers and media even during model download. */
export function createStudioTranscriptionHandlers(
  options: StudioEngineCommandOptions & {
    context: () => StudioBridgeContext;
    ownerId: () => string;
    createRuntime: () => Promise<StudioCommandEngine | null>;
    onChange: (job: StudioTranscriptionJob) => void;
  },
) {
  // ponytail: one browser transcription per host session; native jobs already serialize per media.
  let active: { id: string; runtime?: StudioCommandEngine; cancelled: boolean; current: () => boolean } | null = null;
  const cancel = () => {
    if (!active) {
      return;
    }
    const job = active;
    active = null;
    job.cancelled = true;
    job.runtime?.cancelTranscription?.();
    job.runtime?.dispose();
    options.onChange({ id: job.id, status: 'cancelled' });
  };
  const reconcile = () => {
    if (active && !active.current()) {
      cancel();
    }
  };
  const enqueue: StudioCommandHandler = async (candidate) => {
    reconcile();
    const envelope = candidate as StudioCommandEnvelope<'job.enqueueTranscription'>;
    const payload = envelope.payload;
    if (
      !payload ||
      Object.keys(payload).some((key) => !['sequenceId', 'language', 'destinationId'].includes(key)) ||
      payload.sequenceId !== 'main' ||
      typeof payload.language !== 'string' ||
      payload.language.length > 64
    ) {
      throw new StudioCommandRejectedError(
        'invalid',
        'Browser transcription needs a main sequence and explicit language',
      );
    }
    if (payload.destinationId !== 'browser-local') {
      throw new StudioCommandRejectedError('not-implemented', 'This transcription command supports browser-local only');
    }
    const graph = options.graph();
    const revision = options.revision();
    const projectId = options.projectId?.();
    const ownerId = options.ownerId();
    const assets = options.assets();
    const valid = () => {
      const context = options.context();
      return (
        context.hasAccess &&
        context.hasLease &&
        context.online &&
        context.capabilities.transcriptionWorker &&
        options.graph() === graph &&
        options.revision() === revision &&
        options.projectId?.() === projectId &&
        options.ownerId() === ownerId &&
        options.assets() === assets
      );
    };
    if (envelope.revision !== revision || !valid()) {
      throw new StudioCommandRejectedError('stale-revision', 'The project is no longer writable at this revision');
    }
    if (active) {
      throw new StudioCommandRejectedError('invalid', 'A browser transcription is already running');
    }
    const job = {
      id: envelope.idempotencyKey,
      cancelled: false,
      current: valid,
      runtime: undefined as StudioCommandEngine | undefined,
    };
    active = job;
    options.onChange({ id: job.id, status: 'queued' });
    try {
      const runtime = await options.createRuntime();
      job.runtime = runtime ?? undefined;
      if (job.cancelled || !valid()) {
        runtime?.dispose();
        reconcile();
        throw new StudioCommandRejectedError('stale-revision', 'Transcription was revoked before it started');
      }
      if (!runtime?.transcribe) {
        throw new StudioCommandRejectedError('not-implemented', 'The browser transcription runtime is unavailable');
      }
      const apply = createStudioEngineCommandHandlers({
        ...options,
        stage: (...args) => (!job.cancelled && valid() ? options.stage(...args) : 'ignored'),
      })['captions.set']!;
      void runtime
        .transcribe(graph, envelope, assets, (progress) => {
          reconcile();
          if (active === job) {
            options.onChange({ id: job.id, status: 'running', progress });
          }
        })
        .then(async (outcome) => {
          reconcile();
          if (active !== job) {
            return;
          }
          if (outcome.status === 'cancelled') {
            cancel();
            return;
          }
          if (outcome.status === 'rejected') {
            throw new Error(outcome.detail);
          }
          if (!Array.isArray(outcome.captions) || outcome.captions.length === 0) {
            throw new Error('The transcript has no captions; existing captions were kept');
          }
          await apply(createStudioCommandEnvelope('captions.set', { captions: outcome.captions }, revision));
          if (!job.cancelled) {
            options.onChange({ id: job.id, status: 'applied' });
          }
        })
        .catch((error: unknown) => {
          if (!job.cancelled) {
            options.onChange({
              id: job.id,
              status: 'failed',
              detail: error instanceof Error ? error.message : 'Browser transcription failed',
            });
          }
        })
        .finally(() => {
          runtime.dispose();
          if (active === job) {
            active = null;
          }
        });
      return revision;
    } catch (error) {
      job.runtime?.dispose();
      if (active === job) {
        active = null;
      }
      if (!job.cancelled) {
        options.onChange({ id: job.id, status: 'failed' });
      }
      throw error;
    }
  };
  const handlers: Partial<Record<'job.enqueueTranscription' | 'job.cancel', StudioCommandHandler>> = {
    'job.enqueueTranscription': enqueue,
    'job.cancel': (envelope) => {
      if (!active || (envelope.payload as { jobId?: unknown }).jobId !== active.id) {
        throw new StudioCommandRejectedError('invalid', 'This browser transcription job is not active here');
      }
      cancel();
      return Promise.resolve(options.revision());
    },
  };
  return { handlers, reconcile, dispose: cancel };
}
