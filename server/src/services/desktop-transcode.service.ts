import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { OnEvent } from 'src/decorators.js';
import {
  DesktopTranscodeClaimDto,
  DesktopTranscodeFailureSchema,
  DesktopTranscodeLeaseSchema,
  DesktopTranscodeUploadGrantDto,
  DesktopTranscodeUploadRequestSchema,
} from 'src/dtos/desktop-transcode.dto.js';
import { DesktopWorkerAckDto, DesktopWorkerHeartbeatDto } from 'src/dtos/desktop-worker-job.dto.js';
import { CacheControl, FrameleafWorker } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { DesktopTranscodeRepository, DesktopTranscodeUpload } from 'src/repositories/desktop-transcode.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { DesktopWorkerAuthService } from 'src/services/desktop-worker-auth.service.js';
import {
  DESKTOP_TRANSCODE_LEASE_MS,
  DESKTOP_TRANSCODE_PRESENCE_KEY,
  desktopTranscodeMaxOutputBytes,
  desktopTranscodeStagingFolder,
} from 'src/utils/desktop-transcode.js';
import { FileDownloadResponse } from 'src/utils/file.js';
import { isLockedPath } from 'src/utils/locked-read.js';
import { mimeTypes } from 'src/utils/mime-types.js';
import { receiveRenderArtifact } from 'src/utils/render-artifact.js';

const PRESENCE_WRITE_MS = 30_000;
const STAGING_SWEEP_MS = 60 * 60 * 1000;

type TranscodeSnapshot = {
  assetId: string;
  checksum: string;
  sourceBytes: number;
  command: { inputOptions: string[]; outputOptions: string[]; twoPass: boolean; frameCount: number };
};

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const leaseLost = () => new ForbiddenException('desktop_lease_invalid');

@Injectable()
export class DesktopTranscodeService {
  private presence = new Map<string, number>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private auth: DesktopWorkerAuthService,
    private repository: DesktopTranscodeRepository,
    private operations: MediaOperationRepository,
    private assets: AssetRepository,
    private metadata: SystemMetadataRepository,
    private storage: StorageRepository,
  ) {}

  @OnEvent({ name: 'AppBootstrap', workers: [FrameleafWorker.Microservices] })
  onBootstrap() {
    this.timer ??= setInterval(() => void this.sweepStaged().catch(() => {}), STAGING_SWEEP_MS);
  }

  @OnEvent({ name: 'AppShutdown' })
  onShutdown() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Removes uploaded files whose conversion ended without its job cleaning up. */
  async sweepStaged() {
    for (const { id, ownerId } of await this.repository.listFinishedStaged(100)) {
      try {
        await this.storage.unlinkDir(desktopTranscodeStagingFolder(ownerId, id), { recursive: true, force: true });
        await this.repository.clearStaged(id);
      } catch {
        // Kept for the next sweep; one folder that cannot be removed does not hold up the others.
      }
    }
  }

  async claim(authorization: string | undefined, proof: string | undefined): Promise<DesktopTranscodeClaimDto> {
    const grant = await this.auth.authenticate(authorization, proof, 'transcode-claim', '');
    const operation = await this.repository.claim(grant, DESKTOP_TRANSCODE_LEASE_MS);
    const owner = operation?.workerOwnerId ?? (await this.repository.ownerOf(grant));
    if (owner) await this.notePresent(grant.deviceId, owner);
    if (!operation) return { task: null };
    const { sourceBytes, command } = operation.snapshot as TranscodeSnapshot;
    return {
      task: {
        id: operation.id,
        claimToken: operation.claimToken!,
        ...command,
        sourceBytes,
        maxOutputBytes: desktopTranscodeMaxOutputBytes(sourceBytes),
        expiresAt: new Date(operation.claimExpiresAt as unknown as string).toISOString(),
      },
    };
  }

  /** The original, only while the claim holds and the file is still the one the job was planned from. */
  async input(
    authorization: string | undefined,
    proof: string | undefined,
    id: string,
    claimToken: string,
  ): Promise<FileDownloadResponse> {
    const grant = await this.auth.authenticate(authorization, proof, `transcode-input:${id}:${claimToken}`, '');
    const operation = await this.repository.getClaimed(grant, id, claimToken);
    if (!operation) throw leaseLost();
    const snapshot = operation.snapshot as TranscodeSnapshot;
    const asset = await this.assets.getById(snapshot.assetId);
    if (
      !asset ||
      asset.deletedAt ||
      asset.ownerId !== operation.ownerId ||
      asset.checksum.toString('hex') !== snapshot.checksum
    ) {
      throw new NotFoundException('Input not available');
    }
    // Moved to Locked after the job was offered
    if ((await this.repository.isLockedAsset(asset.id)) || (await isLockedPath(asset.originalPath))) throw leaseLost();
    return new FileDownloadResponse({
      path: asset.originalPath,
      contentType: mimeTypes.lookup(asset.originalPath),
      cacheControl: CacheControl.PrivateWithoutCache,
    });
  }

  async heartbeat(
    authorization: string | undefined,
    proof: string | undefined,
    id: string,
    payload: string,
  ): Promise<DesktopWorkerHeartbeatDto> {
    const grant = await this.auth.authenticate(authorization, proof, `transcode-heartbeat:${id}`, payload);
    const { claimToken } = this.parse(DesktopTranscodeLeaseSchema, payload);
    const operation = await this.repository.getClaimed(grant, id, claimToken);
    const accepted =
      !!operation &&
      (await this.operations.heartbeat(id, claimToken, DESKTOP_TRANSCODE_LEASE_MS, { requireActiveClaim: true }));
    return {
      accepted,
      expiresAt: accepted ? new Date(Date.now() + DESKTOP_TRANSCODE_LEASE_MS).toISOString() : null,
    };
  }

  /** The size and checksum are signed here, and the upload that follows must match them. */
  async grantUpload(
    authorization: string | undefined,
    proof: string | undefined,
    id: string,
    payload: string,
  ): Promise<DesktopTranscodeUploadGrantDto> {
    const grant = await this.auth.authenticate(authorization, proof, `transcode-upload-grant:${id}`, payload);
    const { claimToken, checksum, sizeInBytes } = this.parse(DesktopTranscodeUploadRequestSchema, payload);
    const operation = await this.repository.getClaimed(grant, id, claimToken);
    if (!operation) throw leaseLost();
    const { sourceBytes } = operation.snapshot as TranscodeSnapshot;
    if (Number(sizeInBytes) > desktopTranscodeMaxOutputBytes(sourceBytes)) {
      throw new BadRequestException('desktop_transcode_too_large');
    }
    const uploadToken = randomBytes(32).toString('base64url');
    const stored = await this.repository.setUploadGrant(id, claimToken, {
      tokenHash: tokenHash(uploadToken),
      checksum,
      sizeInBytes,
    });
    if (!stored) throw leaseLost();
    return { uploadToken };
  }

  /** The file is staged, never published here. */
  async upload(uploadToken: string | undefined, id: string, body: Readable): Promise<DesktopWorkerAckDto> {
    if (!uploadToken || uploadToken.length > 128) throw leaseLost();
    const hash = tokenHash(uploadToken);
    const operation = await this.repository.getByUploadToken(id, hash);
    if (!operation?.claimToken) throw leaseLost();
    const claimToken = operation.claimToken;
    const { checksum, sizeInBytes } = (operation.settings as { upload: DesktopTranscodeUpload }).upload;
    const accepted = await receiveRenderArtifact(
      desktopTranscodeStagingFolder(operation.ownerId, id),
      body,
      { checksum, sizeInBytes },
      async () => {
        if (!(await this.repository.getByUploadToken(id, hash))) throw leaseLost();
      },
      (artifact) =>
        this.repository.stageResult(id, claimToken, hash, {
          outputPath: artifact.outputPath,
          checksum: artifact.outputChecksum.toString('hex'),
          sizeInBytes: artifact.sizeInBytes,
        }),
    );
    return { accepted };
  }

  /** The job waiting on this operation sees it failed and encodes the video on the server. */
  async fail(
    authorization: string | undefined,
    proof: string | undefined,
    id: string,
    payload: string,
  ): Promise<DesktopWorkerAckDto> {
    const grant = await this.auth.authenticate(authorization, proof, `transcode-fail:${id}`, payload);
    const { claimToken, code } = this.parse(DesktopTranscodeFailureSchema, payload);
    if (!(await this.repository.getClaimed(grant, id, claimToken))) return { accepted: false };
    const outcome = await this.operations.fail(
      id,
      claimToken,
      { error: `The desktop could not convert this video (${code})`, errorCode: `desktop_transcode_${code}` },
      { retry: false, requireActiveClaim: true },
    );
    return { accepted: outcome === 'failed' };
  }

  private parse<T>(schema: { safeParse: (value: unknown) => { success: boolean; data?: T } }, payload: string): T {
    let value: unknown;
    try {
      value = JSON.parse(payload);
    } catch {
      throw new BadRequestException('desktop_payload_invalid');
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new BadRequestException('desktop_payload_invalid');
    return parsed.data as T;
  }

  /** Asking for a conversion is what says a desktop can do them: older desktops never appear here. */
  private async notePresent(deviceId: string, ownerId: string) {
    const now = Date.now();
    if (now - (this.presence.get(deviceId) ?? 0) < PRESENCE_WRITE_MS) return;
    this.presence.set(deviceId, now);
    await this.metadata.setEntry(DESKTOP_TRANSCODE_PRESENCE_KEY, 'devices', deviceId, {
      ownerId,
      at: new Date(now).toISOString(),
    });
  }
}
