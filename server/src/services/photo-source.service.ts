import {
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import {
  PhotoSourceCreateDto,
  PhotoSourceItemDto,
  PhotoSourceItemResponseDto,
  PhotoSourceReceiptDto,
  PhotoSourceResponseDto,
  PhotoSourceRunDto,
  PhotoSourceRunResponseDto,
  PhotoSourceRunStateDto,
  PhotoSourceSnapshotDto,
  PhotoSourceVerifyDto,
} from 'src/dtos/photo-source.dto.js';
import { Permission } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PhotoSourceRepository, type SourceAuthority } from 'src/repositories/photo-source.repository.js';
import { type RateLimitHit, RateLimitRepository } from 'src/repositories/rate-limit.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { requireAccess } from 'src/utils/access.js';
import { operationExecution } from 'src/utils/execution-signal.js';
import { fileIdentity, verifyStoredCopy } from 'src/utils/file-trash.js';
import { stableServerId } from 'src/utils/frameleaf-server-identity.js';

const iso = (value: Date | string | number) => new Date(value).toISOString();
@Injectable()
export class PhotoSourceService {
  constructor(
    private repository: PhotoSourceRepository,
    private access: AccessRepository,
    private storage: StorageRepository,
    private crypto: CryptoRepository,
    private metadata: SystemMetadataRepository,
    private limits: RateLimitRepository,
    private logger: LoggingRepository,
  ) {}
  private authority(auth: AuthDto): SourceAuthority {
    if (!auth.session || auth.apiKey || auth.sharedLink || auth.system)
      throw new ForbiddenException('photo_source_photo_session_required');
    return { ownerId: auth.user.id, sessionId: auth.session.id };
  }
  async create(auth: AuthDto, input: PhotoSourceCreateDto): Promise<PhotoSourceResponseDto> {
    const row = await this.repository.create(this.authority(auth), PhotoSourceCreateDto.schema.parse(input));
    return PhotoSourceResponseDto.schema.parse({
      ...row,
      createdAt: iso(row.createdAt),
      revokedAt: row.revokedAt ? iso(row.revokedAt) : null,
    });
  }
  async revoke(auth: AuthDto, id: string): Promise<void> {
    await this.repository.revoke(this.authority(auth), id);
  }
  async run(auth: AuthDto, sourceId: string, input: PhotoSourceRunDto): Promise<PhotoSourceRunResponseDto> {
    const row = await this.repository.run(this.authority(auth), sourceId, PhotoSourceRunDto.schema.parse(input));
    return PhotoSourceRunResponseDto.schema.parse({
      ...row,
      maxBytes: Number(row.maxBytes),
      createdAt: iso(row.createdAt),
    });
  }
  async plan(
    auth: AuthDto,
    sourceId: string,
    runId: string,
    input: PhotoSourceItemDto,
  ): Promise<PhotoSourceItemResponseDto> {
    const row = await this.repository.plan(
      this.authority(auth),
      sourceId,
      runId,
      PhotoSourceItemDto.schema.parse(input),
    );
    return PhotoSourceItemResponseDto.schema.parse({
      ...row,
      sha256: row.checksum.toString('hex'),
      bytes: Number(row.bytes),
      verifiedAt: row.verifiedAt ? iso(row.verifiedAt) : null,
    });
  }
  async setState(
    auth: AuthDto,
    sourceId: string,
    runId: string,
    input: PhotoSourceRunStateDto,
  ): Promise<PhotoSourceRunResponseDto> {
    const row = await this.repository.setState(
      this.authority(auth),
      sourceId,
      runId,
      PhotoSourceRunStateDto.schema.parse(input),
    );
    return PhotoSourceRunResponseDto.schema.parse({
      ...row,
      maxBytes: Number(row.maxBytes),
      createdAt: iso(row.createdAt),
    });
  }
  async snapshot(auth: AuthDto, sourceId: string, runId: string, after?: string): Promise<PhotoSourceSnapshotDto> {
    const { run, items, nextCursor } = await this.repository.snapshot(this.authority(auth), sourceId, runId, after);
    return PhotoSourceSnapshotDto.schema.parse({
      run: { ...run, maxBytes: Number(run.maxBytes), createdAt: iso(run.createdAt) },
      items: items.map((row) => ({
        ...row,
        bytes: Number(row.bytes),
        verifiedAt: row.verifiedAt ? iso(row.verifiedAt) : null,
      })),
      nextCursor,
    });
  }
  async verify(
    auth: AuthDto,
    sourceId: string,
    runId: string,
    itemId: string,
    input: PhotoSourceVerifyDto,
    cancelled?: AbortSignal,
  ): Promise<PhotoSourceReceiptDto> {
    const authority = this.authority(auth);
    const dto = PhotoSourceVerifyDto.schema.parse(input);
    const signal = cancelled
      ? AbortSignal.any([cancelled, AbortSignal.timeout(10 * 60_000)])
      : AbortSignal.timeout(10 * 60_000);
    signal.throwIfAborted();
    const target = await this.repository.target(authority, sourceId, runId, itemId, dto.uploadResourceId);
    await requireAccess(this.access, { auth, permission: Permission.AssetRead, ids: [target.assetId] });
    const key = `photo-source-verify:${authority.ownerId}`;
    let hit: RateLimitHit;
    try {
      hit = await this.limits.hit(key, 900);
    } catch {
      throw new ServiceUnavailableException('photo_source_verification_admission_unavailable');
    }
    try {
      if (hit.count > 1) throw new HttpException('photo_source_verification_busy', 429);
      return await operationExecution.run(
        { signal, settled: false, completed: new Map(), progress: () => {}, settle: async () => {} },
        async () => {
          signal.throwIfAborted();
          const proof = await verifyStoredCopy(this.storage, this.crypto, target.path, {
            checksum: target.item.checksum,
            sizeInBytes: Number(target.item.bytes),
          });
          signal.throwIfAborted();
          if (!proof) throw new ConflictException('photo_source_managed_original_unhealthy');
          await requireAccess(this.access, { auth, permission: Permission.AssetRead, ids: [target.assetId] });
          const row = await this.repository.complete(authority, sourceId, runId, target, proof, async (path) => {
            signal.throwIfAborted();
            const identity = await fileIdentity(this.storage, path);
            signal.throwIfAborted();
            return identity?.key ?? null;
          });
          signal.throwIfAborted();
          return PhotoSourceReceiptDto.schema.parse({
            sourceId,
            runId,
            itemId,
            uploadResourceId: dto.uploadResourceId,
            assetId: row.assetId,
            ownerId: authority.ownerId,
            serverId: await stableServerId({ systemMetadataRepository: this.metadata }),
            sha256: row.checksum.toString('hex'),
            bytes: Number(row.bytes),
            verifiedAt: iso(row.verifiedAt!),
            storage: 'managed',
          });
        },
      );
    } finally {
      if (hit.windowExpiresAt) {
        await this.limits
          .release(key, hit.windowExpiresAt)
          .catch(() => this.logger.warn('Photo source verification admission release failed'));
      }
    }
  }
}
