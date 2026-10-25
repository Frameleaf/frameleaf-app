import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import z from 'zod';
import {
  SourceReadHeartbeatDto,
  SourceReadHeartbeatSchema,
  SourceReadPollDto,
  SourceReadPollSchema,
} from 'src/dtos/source-resource-read.dto.js';
import { SourceResourceReadRepository } from 'src/repositories/source-resource-read.repository.js';
import { SourceResourceAuthService } from 'src/services/source-resource-auth.service.js';

const hash = (value: string) => createHash('sha256').update(value).digest();
const parse = <T>(schema: z.ZodType<T>, payload: string): T => {
  try {
    if (typeof payload !== 'string' || Buffer.byteLength(payload) > 65_536)
      throw new Error('source_read_payload_invalid');
    return schema.parse(JSON.parse(payload));
  } catch {
    throw new BadRequestException('source_read_payload_invalid');
  }
};

@Injectable()
export class SourceResourceReadService {
  constructor(
    private auth: SourceResourceAuthService,
    private reads: SourceResourceReadRepository,
  ) {}

  async poll(
    authorization: string | undefined,
    proof: string | undefined,
    payload: string,
  ): Promise<SourceReadPollDto> {
    const input = parse(SourceReadPollSchema, payload);
    const grant = await this.auth.authenticate(authorization, proof, 'poll', payload);
    const token = randomBytes(32).toString('hex');
    const row = await this.reads.claim(grant, hash(token), input.maxBytes);
    if (!row) return { request: null };
    return SourceReadPollDto.schema.parse({
      request: {
        id: row.id,
        sourceId: row.sourceId,
        scopeFingerprint: row.scopeFingerprint,
        authorizationEpoch: row.authorizationEpoch,
        resourceKey: row.resourceKey,
        version: row.version,
        sha256: row.sha256,
        bytes: row.bytes,
        claimFence: row.claimFence,
        claimToken: token,
        leaseUntil: row.leaseUntil.toISOString(),
        deadline: row.deadline.toISOString(),
      },
    });
  }

  async heartbeat(
    authorization: string | undefined,
    proof: string | undefined,
    payload: string,
  ): Promise<SourceReadHeartbeatDto> {
    const input = parse(SourceReadHeartbeatSchema, payload);
    const grant = await this.auth.authenticate(authorization, proof, 'heartbeat', payload);
    const row = await this.reads.heartbeat(grant, input.requestId, input.claimFence, hash(input.claimToken));
    if (!row) throw new ConflictException('source_read_lease_invalid');
    return { leaseUntil: row.leaseUntil.toISOString(), deadline: row.deadline.toISOString() };
  }
}
