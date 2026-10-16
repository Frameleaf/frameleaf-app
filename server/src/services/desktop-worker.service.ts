import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
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
import { DesktopWorkerRepository } from 'src/repositories/desktop-worker.repository.js';
import { DesktopWorkerAuthService } from 'src/services/desktop-worker-auth.service.js';
import { canonicalJson } from 'src/utils/object.js';

const parse = <T>(schema: z.ZodType<T>, payload: string): T => {
  try {
    if (Buffer.byteLength(payload) > 4 * 1024 * 1024) throw new Error('desktop_payload_too_large');
    return schema.parse(JSON.parse(payload));
  } catch {
    throw new BadRequestException('desktop_worker_payload_invalid');
  }
};

@Injectable()
export class DesktopWorkerService {
  constructor(
    private auth: DesktopWorkerAuthService,
    private broker: DesktopMlRepository,
    private sessions: DesktopWorkerRepository,
  ) {}

  async claim(
    authorization: string | undefined,
    proof: string | undefined,
    payload: string,
    signal: AbortSignal,
  ): Promise<DesktopWorkerClaimDto> {
    signal.throwIfAborted();
    const grant = await this.auth.authenticate(authorization, proof, 'claim', payload);
    const request = parse(DesktopClaimRequestSchema, payload);
    if (request.modelKeys.length === 0) return { task: null };
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
            qualificationId: claim.attempt.qualificationId!,
            qualificationExpiresAt: claim.qualificationExpiresAt.toISOString(),
            modelKey: claim.task.modelKey,
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
  }

  async input(authorization: string | undefined, proof: string | undefined, id: string): Promise<Buffer> {
    const grant = await this.auth.authenticate(authorization, proof, `input:${id}`, '');
    const bytes = await this.broker.input(grant, id);
    if (!bytes) throw new UnauthorizedException('desktop_lease_invalid');
    return bytes;
  }

  async heartbeat(
    authorization: string | undefined,
    proof: string | undefined,
    payload: string,
  ): Promise<DesktopWorkerHeartbeatDto> {
    const grant = await this.auth.authenticate(authorization, proof, 'heartbeat', payload);
    const request = parse(DesktopHeartbeatSchema, payload);
    const expiresAt = await this.broker.heartbeatLease(grant, request.id);
    return { accepted: !!expiresAt, expiresAt: expiresAt?.toISOString() ?? null };
  }

  async complete(
    authorization: string | undefined,
    proof: string | undefined,
    id: string,
    payload: string,
  ): Promise<DesktopWorkerAckDto> {
    const grant = await this.auth.authenticate(authorization, proof, `result:${id}`, payload);
    const request = parse(DesktopResultSchema, payload);
    return { accepted: await this.broker.complete(grant, id, request.result) };
  }

  async fail(
    authorization: string | undefined,
    proof: string | undefined,
    id: string,
    payload: string,
  ): Promise<DesktopWorkerAckDto> {
    const grant = await this.auth.authenticate(authorization, proof, `fail:${id}`, payload);
    parse(DesktopFailureSchema, payload);
    return { accepted: await this.broker.fail(grant, id) };
  }

  renew(authorization: string | undefined, proof: string | undefined, payload: string): Promise<DesktopSessionDto> {
    parse(DesktopEmptySchema, payload);
    return this.auth.renew(authorization, proof, payload);
  }

  async revoke(authorization: string | undefined, proof: string | undefined): Promise<DesktopWorkerAckDto> {
    const grant = await this.auth.authenticate(authorization, proof, 'revoke', '');
    return { accepted: await this.sessions.revoke(grant) };
  }
}
