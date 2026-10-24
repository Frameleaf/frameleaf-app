import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import {
  SourceGrantDto,
  SourceGrantRequestDto,
  SourceGrantTokenSchema,
  SourceResourceProofSchema,
  sourceGrantMessage,
  sourceResourceMessage,
} from 'src/dtos/source-resource.dto.js';
import { SourceResourceGrant, SourceResourceRepository } from 'src/repositories/source-resource.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { stableServerId } from 'src/utils/frameleaf-server-identity.js';

const invalid = () => new UnauthorizedException('source_credential_invalid');
const hash = (value: string) => createHash('sha256').update(value).digest();
const validSignature = (publicKey: string, message: string, signature: string) => {
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
export class SourceResourceAuthService {
  constructor(
    private repository: SourceResourceRepository,
    private metadata: SystemMetadataRepository,
  ) {}

  async issue(auth: AuthDto, input: SourceGrantRequestDto): Promise<SourceGrantDto> {
    if (!auth.session?.id || auth.apiKey || auth.sharedLink || auth.system) {
      throw new ForbiddenException('source_photo_session_required');
    }
    const request = SourceGrantRequestDto.schema.parse(input);
    if (Math.abs(Date.now() - request.timestamp) > 120_000) throw invalid();
    const device = await this.repository.device(auth.user.id, auth.session.id, request);
    const serverId = await stableServerId({ systemMetadataRepository: this.metadata });
    if (
      !device ||
      !validSignature(device.publicKey, sourceGrantMessage(serverId, auth.user.id, request), request.signature)
    )
      throw invalid();
    const token = `flsrc1_${randomBytes(32).toString('hex')}`;
    const grant = await this.repository.issue({
      ownerId: auth.user.id,
      photoSessionId: auth.session.id,
      request,
      authorizationEpoch: device.authorizationEpoch,
      publicKey: device.publicKey,
      tokenHash: hash(token),
    });
    if (!grant) throw invalid();
    return SourceGrantDto.schema.parse({
      grantId: grant.grantId,
      sourceId: grant.sourceId,
      deviceId: grant.deviceId,
      ownerId: grant.ownerId,
      serverId,
      sourceToken: token,
      scopeFingerprint: grant.scopeFingerprint,
      authorizationEpoch: grant.authorizationEpoch,
      expiresAt: new Date(grant.expiresAt).toISOString(),
      scopes: ['source-original-read'],
    });
  }

  async authenticate(
    authorization: string | undefined,
    header: string | undefined,
    operation: string,
    payload: string,
  ): Promise<SourceResourceGrant> {
    const parsedToken = SourceGrantTokenSchema.safeParse(
      authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined,
    );
    if (
      !parsedToken.success ||
      typeof header !== 'string' ||
      header.length > 2048 ||
      Buffer.byteLength(payload) > 65_536 ||
      !['poll', 'deliver', 'heartbeat'].includes(operation)
    )
      throw invalid();
    const bytes = Buffer.from(header, 'base64');
    if (bytes.toString('base64') !== header) throw invalid();
    let raw: unknown;
    try {
      raw = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw invalid();
    }
    const parsedProof = SourceResourceProofSchema.safeParse(raw);
    if (!parsedProof.success || Math.abs(Date.now() - parsedProof.data.timestamp) > 120_000) throw invalid();
    const proof = parsedProof.data;
    const credential = await this.repository.session(proof.grantId, hash(parsedToken.data));
    if (!credential) throw invalid();
    const serverId = await stableServerId({ systemMetadataRepository: this.metadata });
    if (
      !validSignature(
        credential.publicKey,
        sourceResourceMessage({ ...credential, serverId }, parsedToken.data, proof, operation, payload),
        proof.signature,
      )
    )
      throw invalid();
    const grant = await this.repository.consume(credential, proof.sequence);
    if (!grant) throw invalid();
    return grant;
  }
}
