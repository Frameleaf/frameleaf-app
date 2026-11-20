import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import {
  DesktopSessionDto,
  DesktopSessionRequestDto,
  DesktopSessionRequestSchema,
  type DesktopWorkerProof,
  DesktopWorkerProofSchema,
  desktopSessionMessage,
  desktopWorkerMessage,
} from 'src/dtos/desktop-worker.dto.js';
import { DesktopWorkerGrant, DesktopWorkerRepository } from 'src/repositories/desktop-worker.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { logDesktopRefusals } from 'src/utils/desktop-refusal-log.js';
import { stableServerId } from 'src/utils/frameleaf-server-identity.js';

const invalid = () => new UnauthorizedException('desktop_worker_credential_invalid');
/**
 * The request's timestamp is more than two minutes from this server's clock. Its own name, so a desktop
 * with a wrong clock is told about the clock and not that the computer is refused.
 */
const expired = () => new UnauthorizedException('desktop_proof_expired');
const MAX_CLOCK_SKEW_MS = 120_000;
/** The worker session a request proof names, for a log line; unverified, and undefined when unreadable. */
export const proofSessionId = (header: string | undefined): string | undefined => {
  try {
    return DesktopWorkerProofSchema.parse(JSON.parse(Buffer.from(header ?? '', 'base64').toString('utf8'))).sessionId;
  } catch {
    return undefined;
  }
};
/** Desktop AI processing is off for this account: the same refusal on every endpoint. */
const policyRequired = () => new ForbiddenException('desktop_pool_policy_required');
const hash = (value: string) => createHash('sha256').update(value).digest();
const validSignature = (publicKey: string, message: string, signature: string): boolean => {
  try {
    const key = createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKey, 'base64')]),
      format: 'der',
      type: 'spki',
    });
    return verify(null, Buffer.from(message), key, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
};

@Injectable()
export class DesktopWorkerAuthService {
  private logger = LoggingRepository.create(DesktopWorkerAuthService.name);

  constructor(
    private repository: DesktopWorkerRepository,
    private systemMetadataRepository: SystemMetadataRepository,
  ) {}

  issue(auth: AuthDto, input: DesktopSessionRequestDto): Promise<DesktopSessionDto> {
    return logDesktopRefusals(
      this.logger,
      'session',
      () => `account ${auth.user?.id}, device ${input?.deviceId}`,
      async () => {
        if (!auth.session || auth.apiKey || auth.sharedLink || auth.system)
          throw new ForbiddenException('desktop_worker_photo_session_required');
        const request = DesktopSessionRequestSchema.parse(input);
        // Who is asking is settled first: only a request signed by this account's own computer is told that
        // Desktop AI processing is off for the account, as on the signed endpoints.
        const identity = await this.repository.identity(auth.user.id, request.deviceId);
        const serverId = await stableServerId({ systemMetadataRepository: this.systemMetadataRepository });
        if (!identity) throw invalid();
        if (Math.abs(Date.now() - request.timestamp) > MAX_CLOCK_SKEW_MS) throw expired();
        if (
          !validSignature(identity.publicKey, desktopSessionMessage(serverId, auth.user.id, request), request.signature)
        )
          throw invalid();
        if (!(await this.repository.allowed(auth.user.id, auth.user.isAdmin))) throw policyRequired();
        const device = await this.repository.device(auth.user.id, request.deviceId);
        if (!device) throw invalid();
        const token = randomBytes(32).toString('hex');
        const session = await this.repository.issue({
          deviceId: device.id,
          authorizationEpoch: device.authorizationEpoch,
          photoSessionId: auth.session.id,
          tokenHash: hash(token),
          modelKeys: [],
        });
        if (!session) throw invalid();
        return this.response(session, token);
      },
    );
  }

  async authenticate(
    authorization: string | undefined,
    header: string | undefined,
    operation: string,
    payload: string,
  ): Promise<DesktopWorkerGrant> {
    const token = this.token(authorization);
    if (typeof header !== 'string' || header.length > 2048 || Buffer.byteLength(payload) > 4 * 1024 * 1024)
      throw invalid();
    const bytes = Buffer.from(header, 'base64');
    if (bytes.toString('base64') !== header) throw invalid();
    let proof: DesktopWorkerProof;
    try {
      proof = DesktopWorkerProofSchema.parse(JSON.parse(bytes.toString('utf8')));
    } catch {
      throw invalid();
    }
    if (Math.abs(Date.now() - proof.timestamp) > MAX_CLOCK_SKEW_MS) throw expired();
    const live = await this.repository.session(proof.sessionId, hash(token));
    // A session whose account turned Desktop AI processing off is told so, once its proof has been checked.
    const off = live ? undefined : await this.repository.policyOff(proof.sessionId, hash(token));
    const session = live ?? off;
    if (!session) throw invalid();
    const serverId = await stableServerId({ systemMetadataRepository: this.systemMetadataRepository });
    if (
      !validSignature(
        session.publicKey,
        desktopWorkerMessage(serverId, session.authorizationEpoch, token, proof, operation, payload),
        proof.signature,
      )
    )
      throw invalid();
    if (off) throw policyRequired();
    const grant = await this.repository.consume(proof.sessionId, hash(token), proof.sequence);
    if (!grant) throw invalid();
    return grant;
  }

  async renew(
    authorization: string | undefined,
    header: string | undefined,
    payload: string,
  ): Promise<DesktopSessionDto> {
    const grant = await this.authenticate(authorization, header, 'renew', payload);
    const token = randomBytes(32).toString('hex');
    const session = await this.repository.rotate(grant, hash(this.token(authorization)), hash(token));
    if (!session) throw invalid();
    return this.response(session, token);
  }

  private token(authorization: string | undefined): string {
    const match = typeof authorization === 'string' ? /^Bearer ([a-f0-9]{64})$/u.exec(authorization) : null;
    if (!match) throw invalid();
    return match[1];
  }

  private response(
    session: { id: string; authorizationEpoch: number; expiresAt: Date; modelKeys: string[] },
    token: string,
  ): DesktopSessionDto {
    return {
      sessionId: session.id,
      workerToken: token,
      authorizationEpoch: session.authorizationEpoch,
      expiresAt: new Date(session.expiresAt).toISOString(),
      scopes: ['library-inference'],
      modelKeys: session.modelKeys,
    };
  }
}
