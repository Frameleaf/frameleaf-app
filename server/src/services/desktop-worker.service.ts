import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { setTimeout } from 'node:timers/promises';
import z from 'zod';
import {
  DesktopClaimRequestSchema,
  DesktopEmptySchema,
  DesktopFailureSchema,
  DesktopHeartbeatSchema,
  DesktopResultSchema,
  DesktopWorkerAckDto,
  DesktopWorkerClaimDto,
  DesktopWorkerHeartbeatDto,
} from 'src/dtos/desktop-worker-job.dto.js';
import { DesktopSessionDto } from 'src/dtos/desktop-worker.dto.js';
import { DesktopMlRepository } from 'src/repositories/desktop-ml.repository.js';
import { type DesktopWorkerGrant, DesktopWorkerRepository } from 'src/repositories/desktop-worker.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DesktopMlService } from 'src/services/desktop-ml.service.js';
import { DesktopWorkerAuthService, proofSessionId } from 'src/services/desktop-worker-auth.service.js';
import { logDesktopNotAccepted, logDesktopRefusals } from 'src/utils/desktop-refusal-log.js';
import { assertDesktopResult } from 'src/utils/desktop-result.js';
import { DESKTOP_FAILURES_BEFORE_WITHDRAWAL } from 'src/utils/desktop-worker-timing.js';
import { canonicalJson } from 'src/utils/object.js';

const parse = <T>(schema: z.ZodType<T>, payload: string): T => {
  try {
    if (Buffer.byteLength(payload) > 4 * 1024 * 1024) throw new Error('desktop_payload_too_large');
    return schema.parse(JSON.parse(payload));
  } catch {
    throw new BadRequestException('desktop_worker_payload_invalid');
  }
};

/**
 * What the input authority throws when the lease can no longer be served: the job ended, or the photo,
 * destination, model, settings, index or approval behind it changed while the desktop was asking. Anything
 * else it throws is a server fault and stays a 500.
 */
const LEASE_LOST = new Set([
  'desktop_input_owner_changed',
  'desktop_pool_destination_changed',
  'desktop_pool_profile_changed',
  'desktop_pool_config_changed',
  'desktop_pool_model_unavailable',
  'desktop_pool_policy_changed',
  'desktop_pool_queue_changed',
  'desktop_clip_index_changed',
  'desktop_clip_profile_unavailable',
  'Asset inputs changed before publication',
]);

@Injectable()
export class DesktopWorkerService {
  private logger = LoggingRepository.create(DesktopWorkerService.name);

  constructor(
    private auth: DesktopWorkerAuthService,
    private broker: DesktopMlRepository,
    private sessions: DesktopWorkerRepository,
    private authority: DesktopMlService,
  ) {}

  /** Runs one endpoint; every refusal it gives is logged with the device and, when known, the model key. */
  private async logged<T>(
    step: string,
    authorization: string | undefined,
    proof: string | undefined,
    operation: string,
    payload: string,
    work: (grant: DesktopWorkerGrant, note: (detail: string) => void) => Promise<T>,
  ): Promise<T> {
    // Until the request is authenticated, the session its proof names (unverified) is all that is known.
    const session = proofSessionId(proof);
    let subject = session ? `unauthenticated, session ${session}` : 'unauthenticated';
    return logDesktopRefusals(
      this.logger,
      step,
      () => subject,
      async () => {
        const grant = await this.auth.authenticate(authorization, proof, operation, payload);
        subject = `device ${grant.deviceId}`;
        return work(grant, (detail) => (subject = `device ${grant.deviceId}, ${detail}`));
      },
    );
  }

  /** `attempt <id>` and the model key of the task behind it, for a log line. */
  private async attempt(grant: DesktopWorkerGrant, id: string): Promise<{ label: string; modelKey?: string }> {
    let modelKey: string | undefined;
    try {
      modelKey = await this.broker.attemptModelKey(grant, id);
    } catch {
      // The log line goes without the model key; the refusal itself is unchanged.
    }
    return { label: `attempt ${id}${modelKey ? `, ${modelKey}` : ''}`, modelKey };
  }

  async claim(
    authorization: string | undefined,
    proof: string | undefined,
    payload: string,
    signal: AbortSignal,
  ): Promise<DesktopWorkerClaimDto> {
    signal.throwIfAborted();
    return this.logged('claim', authorization, proof, 'claim', payload, async (grant, note) => {
      const request = parse(DesktopClaimRequestSchema, payload);
      if (request.modelKeys.length === 0) return { task: null };
      note(`models ${request.modelKeys.slice(0, 8).join(', ')}`);
      // A desktop that asks is told when one of these models was taken away from it for failing: it may
      // still believe it holds it, and would otherwise wait for work that will not come.
      if (request.reportWithdrawn) {
        const withdrawn = await this.broker.withdrawnModels(grant.deviceId, request.modelKeys);
        if (withdrawn.length > 0) {
          note(`withdrawn ${withdrawn.join(', ')}`);
          throw new ConflictException('desktop_qualification_hold');
        }
      }
      const deadline = performance.now() + request.waitMs;
      do {
        signal.throwIfAborted();
        const claim = await this.broker.claim(grant, request.modelKeys);
        signal.throwIfAborted();
        if (claim)
          return {
            task: {
              id: claim.attempt.id,
              taskId: claim.task.id,
              deviceId: grant.deviceId,
              sessionId: grant.sessionId,
              authorizationEpoch: grant.authorizationEpoch,
              generation: claim.attempt.generation,
              qualificationId: claim.qualificationId,
              qualificationExpiresAt: claim.qualificationExpiresAt.toISOString(),
              // The key this desktop holds the model under (its own runtime revision's key for the same model).
              modelKey: claim.workerModelKey,
              configJson: canonicalJson(claim.task.config),
              configSha256: claim.task.configSha256,
              inputSha256: claim.task.inputSha256,
              inputKind: claim.task.inputKind,
              maxInputBytes: 16 * 1024 * 1024,
              expiresAt: new Date(claim.attempt.expiresAt).toISOString(),
              executionDeadline: new Date(claim.task.deadlineAt).toISOString(),
            },
          };
        const remaining = deadline - performance.now();
        if (remaining <= 0) break;
        await setTimeout(Math.min(1000, remaining), undefined, { signal });
      } while (performance.now() < deadline);
      return { task: null };
    });
  }

  input(authorization: string | undefined, proof: string | undefined, id: string): Promise<Buffer> {
    return this.logged('input', authorization, proof, `input:${id}`, '', async (grant, note) => {
      note((await this.attempt(grant, id)).label);
      let bytes: Buffer | undefined;
      try {
        bytes = await this.authority.input(grant, id);
      } catch (error) {
        // The lease can no longer be served: the job, photo, settings or approval behind it changed while
        // the desktop was asking. That is a lost lease to the desktop, not a server error.
        if (!(error instanceof HttpException) && error instanceof Error && LEASE_LOST.has(error.message))
          throw new UnauthorizedException('desktop_lease_invalid', { cause: error });
        throw error;
      }
      if (!bytes) throw new UnauthorizedException('desktop_lease_invalid');
      return bytes;
    });
  }

  heartbeat(
    authorization: string | undefined,
    proof: string | undefined,
    payload: string,
  ): Promise<DesktopWorkerHeartbeatDto> {
    return this.logged('heartbeat', authorization, proof, 'heartbeat', payload, async (grant) => {
      const request = parse(DesktopHeartbeatSchema, payload);
      const expiresAt = await this.broker.heartbeatLease(grant, request.id);
      if (!expiresAt)
        logDesktopNotAccepted(
          this.logger,
          'heartbeat',
          `device ${grant.deviceId}, ${(await this.attempt(grant, request.id)).label}`,
        );
      return { accepted: !!expiresAt, expiresAt: expiresAt?.toISOString() ?? null };
    });
  }

  complete(
    authorization: string | undefined,
    proof: string | undefined,
    id: string,
    payload: string,
  ): Promise<DesktopWorkerAckDto> {
    return this.logged('result', authorization, proof, `result:${id}`, payload, async (grant, note) => {
      const request = parse(DesktopResultSchema, payload);
      const { label, modelKey } = await this.attempt(grant, id);
      note(label);
      let accepted: boolean;
      try {
        accepted = await this.broker.complete(grant, id, request.result, assertDesktopResult);
      } catch (error) {
        if (error instanceof Error && ['desktop_result_too_large', 'desktop_result_invalid'].includes(error.message))
          throw new BadRequestException(error.message, { cause: error.cause });
        throw error;
      }
      if (!accepted) logDesktopNotAccepted(this.logger, 'result', `device ${grant.deviceId}, ${label}`);
      else if (modelKey) await this.broker.clearFailures(grant, modelKey);
      return { accepted };
    });
  }

  fail(
    authorization: string | undefined,
    proof: string | undefined,
    id: string,
    payload: string,
  ): Promise<DesktopWorkerAckDto> {
    return this.logged('fail', authorization, proof, `fail:${id}`, payload, async (grant, note) => {
      const { code } = parse(DesktopFailureSchema, payload);
      const { label, modelKey } = await this.attempt(grant, id);
      note(label);
      const accepted = await this.broker.fail(grant, id, code);
      this.logger.warn(
        `Desktop worker reported a failed task (device ${grant.deviceId}, ${label}): ${code}` +
          (accepted ? '' : ', 200 accepted:false'),
      );
      // A desktop whose model keeps failing stops being offered that work until it qualifies again.
      if (accepted && modelKey && (code === 'inference-failed' || code === 'model-unavailable')) {
        const failures = await this.broker.countFailure(grant, modelKey);
        if (failures >= DESKTOP_FAILURES_BEFORE_WITHDRAWAL && (await this.broker.withdraw(grant, modelKey)))
          this.logger.warn(
            `Desktop worker lost ${modelKey} after ${failures} failures in a row (device ${grant.deviceId}): it must qualify again`,
          );
      }
      return { accepted };
    });
  }

  renew(authorization: string | undefined, proof: string | undefined, payload: string): Promise<DesktopSessionDto> {
    return logDesktopRefusals(
      this.logger,
      'session renewal',
      () => 'worker session',
      async () => {
        parse(DesktopEmptySchema, payload);
        return this.auth.renew(authorization, proof, payload);
      },
    );
  }

  revoke(authorization: string | undefined, proof: string | undefined): Promise<DesktopWorkerAckDto> {
    return this.logged('session revoke', authorization, proof, 'revoke', '', async (grant) => ({
      accepted: await this.sessions.revoke(grant),
    }));
  }
}
