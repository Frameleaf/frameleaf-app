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
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { stableServerId } from 'src/utils/frameleaf-server-identity.js';

const invalid = () => new UnauthorizedException('desktop_worker_credential_invalid');
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
  constructor(
    private repository: DesktopWorkerRepository,
    private systemMetadataRepository: SystemMetadataRepository,
  ) {}

  async issue(auth: AuthDto, input: DesktopSessionRequestDto): Promise<DesktopSessionDto> {
    if (!auth.session || auth.apiKey || auth.sharedLink || auth.system || !auth.user.isAdmin)
      throw new ForbiddenException('desktop_worker_administrator_photo_session_required');
    const request = DesktopSessionRequestSchema.parse(input);
    const device = await this.repository.device(auth.user.id, request.deviceId);
    const serverId = await stableServerId({ systemMetadataRepository: this.systemMetadataRepository });
    if (
      !device ||
      Math.abs(Date.now() - request.timestamp) > 120_000 ||
      !validSignature(device.publicKey, desktopSessionMessage(serverId, auth.user.id, request), request.signature)
    )
      throw invalid();
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
    if (Math.abs(Date.now() - proof.timestamp) > 120_000) throw invalid();
    const session = await this.repository.session(proof.sessionId, hash(token));
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
