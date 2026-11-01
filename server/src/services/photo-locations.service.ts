import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { mkdir, open, opendir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import z from 'zod';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { PhotoLocationPoint } from 'src/utils/photo-locations.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnEvent } from 'src/decorators.js';
import { LocationScanStatusResponseDto, StartLocationScanDto } from 'src/dtos/photo-locations.dto.js';
import { FrameleafWorker } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { FrameleafCloudRepository, type FrameleafCloudRequest } from 'src/repositories/frameleaf-cloud.repository.js';
import { InstanceIdentityRepository } from 'src/repositories/instance-identity.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MetadataRepository } from 'src/repositories/metadata.repository.js';
import { type LocationScan, PhotoLocationsRepository } from 'src/repositories/photo-locations.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { loadInstanceIdentity, readCloudLink } from 'src/utils/frameleaf-cloud-gateway.js';
import { FrameleafCloudError } from 'src/utils/frameleaf-cloud.js';
import {
  LOCATION_UPLOAD_CHUNK_BYTES,
  cloudLocationResultsSchema,
  cloudLocationStatusSchema,
  photoGpsAccuracy,
  writeLocationInput,
} from 'src/utils/photo-locations.js';

const availabilitySchema = z.object({ enabled: z.boolean(), available: z.boolean() });
const emptyResponse = z.unknown();
const summary = (scan?: LocationScan) =>
  scan
    ? {
        id: scan.id,
        status: scan.status,
        total: scan.total,
        processed: scan.processed,
        matched: scan.matched,
        unmatched: scan.unmatched,
        skipped: scan.skipped,
        failed: scan.failed,
        error: scan.error,
        reason: scan.reason,
      }
    : null;

@Injectable()
export class PhotoLocationsService {
  private interval?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  private stopping = false;
  private lastSweepAt = 0;

  constructor(
    private repository: PhotoLocationsRepository,
    private frameleafCloudRepository: FrameleafCloudRepository,
    private configRepository: ConfigRepository,
    private databaseRepository: DatabaseRepository,
    private systemMetadataRepository: SystemMetadataRepository,
    private instanceIdentityRepository: InstanceIdentityRepository,
    private metadataRepository: MetadataRepository,
    private logger: LoggingRepository,
  ) {
    this.logger.setContext(PhotoLocationsService.name);
  }

  private enabled() {
    return process.env.FRAMELEAF_PHOTO_LOCATIONS_ENABLED === 'true';
  }
  private deps() {
    return {
      configRepository: this.configRepository,
      databaseRepository: this.databaseRepository,
      systemMetadataRepository: this.systemMetadataRepository,
      instanceIdentityRepository: this.instanceIdentityRepository,
      frameleafCloudRepository: this.frameleafCloudRepository,
    };
  }

  private async gateway(ownerId: string, expected?: LocationScan) {
    const { cloudUrl, link, linked } = await readCloudLink(this.deps());
    if (!linked || !cloudUrl || !link?.instanceId)
      throw new ServiceUnavailableException('Link this server to Frameleaf Cloud first');
    if (
      expected &&
      (expected.cloudUrl !== cloudUrl ||
        expected.instanceId !== link.instanceId ||
        expected.linkedAt !== (link.linkedAt ?? ''))
    ) {
      throw new ForbiddenException('The Frameleaf Cloud link changed');
    }
    const binding = { cloudUrl, instanceId: link.instanceId, linkedAt: link.linkedAt ?? '' };
    return {
      ...binding,
      request: async <T extends z.ZodType>(
        schema: T,
        path: string,
        options: Omit<FrameleafCloudRequest, 'url' | 'dpop'> = {},
      ) => {
        const current = await readCloudLink(this.deps());
        if (
          !current.linked ||
          current.cloudUrl !== binding.cloudUrl ||
          current.link?.instanceId !== binding.instanceId ||
          (current.link?.linkedAt ?? '') !== binding.linkedAt
        ) {
          throw new ForbiddenException('The Frameleaf Cloud link changed');
        }
        await loadInstanceIdentity(this.deps());
        const document = await this.frameleafCloudRepository.discovery(cloudUrl);
        const token = await this.frameleafCloudRepository.accessToken(
          document,
          binding.instanceId,
          document.api,
          this.instanceIdentityRepository.currentSigner(),
        );
        return this.frameleafCloudRepository.requestJson(schema, {
          ...options,
          url: `${document.api.replace(/\/+$/, '')}${path}`,
          dpop: token,
          headers: {
            ...options.headers,
            'X-Frameleaf-User-Fingerprint': createHash('sha256')
              .update(`${binding.instanceId}${ownerId}`)
              .digest('hex'),
          },
        });
      },
    };
  }

  async status(auth: AuthDto): Promise<LocationScanStatusResponseDto> {
    const scan = summary(await this.repository.latest(auth.user.id));
    if (!this.enabled()) return { enabled: false, available: false, scan };
    try {
      const gateway = await this.gateway(auth.user.id);
      const status = await gateway.request(availabilitySchema, '/v1/locations/status');
      return { enabled: status.enabled, available: status.available, scan };
    } catch {
      return { enabled: true, available: false, scan };
    }
  }

  async start(auth: AuthDto, body: StartLocationScanDto): Promise<LocationScanStatusResponseDto> {
    if (auth.sharedLink || !body.consent) throw new BadRequestException('Explicit owner permission is required');
    if (!this.enabled()) throw new ServiceUnavailableException('Photo location identification is not enabled');
    const gateway = await this.gateway(auth.user.id);
    const available = await gateway.request(availabilitySchema, '/v1/locations/status');
    if (!available.enabled || !available.available)
      throw new ForbiddenException('A paid Frameleaf Cloud plan covering this user and server is required');
    try {
      const scan = await this.repository.create(auth.user.id, body.refresh ?? false, gateway);
      return { enabled: true, available: true, scan: summary(scan) };
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        throw new ConflictException('A photo location scan is already active');
      throw error;
    }
  }

  async cancel(auth: AuthDto, id: string): Promise<void> {
    const scan = await this.repository.get(id, auth.user.id);
    if (!scan || auth.sharedLink) throw new NotFoundException('Location scan not found');
    await this.repository.cancel(id, auth.user.id);
    // Durable cleanup is performed by the worker; cancellation fences adoption before it contacts Cloud.
  }

  async dismiss(auth: AuthDto, id: string): Promise<void> {
    if (auth.sharedLink || !(await this.repository.dismiss(id, auth.user.id)))
      throw new NotFoundException('Photo location suggestion not found');
  }

  @OnEvent({ name: 'AppBootstrap', workers: [FrameleafWorker.Microservices] })
  onBootstrap() {
    this.stopping = false;
    this.interval ??= setInterval(() => {
      void this.tick();
    }, 15_000);
    void this.tick();
  }

  @OnEvent({ name: 'AppShutdown' })
  async onShutdown() {
    this.stopping = true;
    clearInterval(this.interval);
    this.interval = undefined;
    await this.active;
  }

  tick(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    return (this.active ??= this.step()
      .catch(() => this.logger.warn('Photo location scan worker unavailable'))
      .finally(() => {
        this.active = undefined;
      }));
  }

  private path(id: string) {
    return join(StorageCore.getMediaLocation(), 'frameleaf', 'location-scans', `${id}.json.gz`);
  }

  private async step() {
    if (Date.now() - this.lastSweepAt > 3_600_000) {
      await this.sweepOrphans();
      this.lastSweepAt = Date.now();
    }
    const scan = await this.repository.claim();
    if (!scan?.leaseToken) return;
    const token = scan.leaseToken;
    const heartbeat = setInterval(() => {
      void this.repository.renew(scan.id, token).catch(() => {});
    }, 30_000);
    let delay = 15;
    try {
      if (scan.state.cleanupPending) {
        try {
          await this.cleanup(scan);
        } catch {
          delay = 300;
          this.logger.warn('Photo location Cloud purge will retry');
        }
        return;
      }
      if (!(await this.repository.ownerActive(scan.ownerId))) {
        await this.repository.patch(scan.id, token, {
          status: 'cancelled',
          state: { ...scan.state, cleanupPending: true },
        });
        return;
      }
      if (Date.now() - new Date(scan.createdAt).getTime() > 7 * 86_400_000) {
        await this.repository.patch(scan.id, token, {
          status: 'failed',
          error: 'This scan expired; start another scan',
          state: { ...scan.state, cleanupPending: true },
        });
        return;
      }
      if (!this.enabled()) {
        await this.repository.patch(scan.id, token, {
          status: 'paused',
          reason: 'Location identification is paused on this server',
        });
        return;
      }
      const gateway = await this.gateway(scan.ownerId, scan);
      if (!scan.state.sha256) {
        const frozenCount = await this.repository.freeze(scan);
        await mkdir(join(StorageCore.getMediaLocation(), 'frameleaf', 'location-scans'), {
          recursive: true,
          mode: 0o700,
        });
        const prepared = await writeLocationInput(this.path(scan.id), scan.id, this.inputPoints(scan));
        if (prepared.pointCount !== frozenCount)
          throw new ForbiddenException('Photo locations or privacy changed during preparation');
        Object.assign(scan.state, prepared);
        await this.repository.patch(scan.id, token, { status: 'uploading', state: scan.state });
        if (prepared.pointCount === 0) {
          await this.repository.finish(scan.id, token);
          return;
        }
      }
      if (!(await this.repository.active(scan.id, token))) return;
      if (!scan.state.cloudStarted && !(await this.repository.inputStillEligible(scan))) {
        await this.repository.patch(scan.id, token, {
          status: 'failed',
          error: 'Photo locations or privacy changed while preparing the scan; start another scan',
          state: { ...scan.state, cleanupPending: true },
        });
        return;
      }
      const base = `/v1/locations/scans/${scan.id}`;
      if (!scan.state.cloudCreated) {
        scan.state.cloudCreateAttempted = true;
        await this.repository.patch(scan.id, token, { state: scan.state });
        if (!(await this.repository.active(scan.id, token))) return;
      }
      const remote = scan.state.cloudCreated
        ? await gateway.request(cloudLocationStatusSchema, base)
        : await gateway.request(cloudLocationStatusSchema, '/v1/locations/scans', {
            method: 'POST',
            body: {
              scanId: scan.id,
              locale: 'en',
              compressedBytes: scan.state.compressedBytes,
              pointCount: scan.state.pointCount,
              sha256: scan.state.sha256,
              refresh: scan.refresh,
            },
          });
      scan.state.cloudCreated = true;
      await this.repository.patch(scan.id, token, { state: scan.state });
      if (remote.scanId !== scan.id) throw new Error('Location scan identity mismatch');
      if (remote.state === 'uploading') {
        await this.upload(scan, gateway, remote.uploadOffset);
        if (this.stopping || !(await this.repository.active(scan.id, token))) return;
        if (!(await this.repository.inputStillEligible(scan)))
          throw new ForbiddenException('Photo locations or privacy changed before processing');
        await gateway.request(cloudLocationStatusSchema, `${base}/start`, { method: 'POST', body: {} });
        scan.state.cloudStarted = true;
        await this.repository.patch(scan.id, token, { status: 'running', state: scan.state });
        return;
      }
      scan.state.cloudStarted = true;
      await this.repository.patch(scan.id, token, { state: scan.state });
      const status = remote;
      if (status.scanId !== scan.id) throw new Error('Location scan identity mismatch');
      if (status.state === 'paused') {
        await this.repository.patch(scan.id, token, {
          status: 'paused',
          reason: status.pauseReason ?? 'Waiting for the Cloud request allowance',
        });
        // Cloud resumes retryable pauses at its own deadline; permanent pauses never refill retries.
        delay = Math.max(15, Math.min(3600, status.retryAfter ?? 300));
        return;
      }
      if (['failed', 'expired', 'cancelled', 'acknowledged'].includes(status.state)) {
        await this.repository.patch(scan.id, token, {
          status: 'failed',
          error: 'Cloud could not complete this scan; start another scan',
          state: { ...scan.state, cleanupPending: true },
        });
        return;
      }
      await this.repository.patch(scan.id, token, { status: 'running', reason: null });
      if (status.state !== 'completed') return;
      const offset = scan.state.resultOffset ?? 0;
      const page = await gateway.request(cloudLocationResultsSchema, `${base}/results?offset=${offset}&limit=500`, {
        maxBodyBytes: 8 * 1024 * 1024,
      });
      if (
        page.scanId !== scan.id ||
        (page.nextOffset !== null && page.nextOffset <= offset) ||
        new Set(page.items.map((r) => r.itemKey)).size !== page.items.length
      ) {
        throw new Error('Invalid location results');
      }
      if (!(await this.repository.adopt(scan.id, token, page.items))) return;
      if (page.nextOffset !== null) {
        scan.state.resultOffset = page.nextOffset;
        await this.repository.patch(scan.id, token, { state: scan.state });
      } else await this.repository.finish(scan.id, token);
    } catch (error) {
      if (!(await this.repository.active(scan.id, token))) return;
      const fatal =
        error instanceof ForbiddenException ||
        error instanceof RangeError ||
        error instanceof z.ZodError ||
        (error instanceof FrameleafCloudError &&
          error.status !== null &&
          [400, 401, 403, 404, 410, 413, 422].includes(error.status));
      await this.repository.patch(
        scan.id,
        token,
        fatal
          ? {
              status: 'failed',
              error:
                error instanceof RangeError
                  ? 'Photo location input exceeds the 128 MiB compressed or 1 GiB expanded limit'
                  : 'Location identification could not complete; check the Cloud plan and try again',
              state: { ...scan.state, cleanupPending: true },
            }
          : { status: 'paused', reason: 'Location identification is temporarily unavailable; this scan will retry' },
      );
      delay = 60;
    } finally {
      clearInterval(heartbeat);
      await this.repository.release(scan.id, token, delay);
    }
  }

  private async *inputPoints(scan: LocationScan): AsyncGenerator<PhotoLocationPoint> {
    let after = '';
    while (!this.stopping) {
      if (!(await this.repository.active(scan.id, scan.leaseToken!))) throw new Error('Location scan cancelled');
      const points = await this.repository.points(scan, after);
      if (points.length === 0) return;
      for (const point of points) {
        let accuracyM = photoGpsAccuracy(point.accuracyM);
        if (accuracyM === null && !point.lockedProperties?.includes('latitude')) {
          try {
            const tags = await this.metadataRepository.readTags(point.originalPath);
            if (Number(tags.GPSLatitude) === point.latitude && Number(tags.GPSLongitude) === point.longitude) {
              accuracyM = photoGpsAccuracy(tags.GPSHPositioningError);
            }
          } catch {
            /* Missing optional accuracy leaves the match conservative. */
          }
        }
        yield {
          itemKey: point.itemKey,
          latitude: point.latitude!,
          longitude: point.longitude!,
          ...(accuracyM === null ? {} : { accuracyM }),
        };
        after = point.assetId;
      }
    }
    throw new Error('Location scan worker stopping');
  }

  private async upload(
    scan: LocationScan,
    gateway: Awaited<ReturnType<PhotoLocationsService['gateway']>>,
    offset: number,
  ) {
    if (offset > scan.state.compressedBytes!) throw new Error('Invalid location upload offset');
    const file = await open(this.path(scan.id), 'r');
    try {
      while (offset < scan.state.compressedBytes!) {
        if (this.stopping || !(await this.repository.active(scan.id, scan.leaseToken!)))
          throw new Error('Location scan cancelled');
        if (!(await this.repository.inputStillEligible(scan)))
          throw new ForbiddenException('Photo locations or privacy changed before upload');
        const size = Math.min(LOCATION_UPLOAD_CHUNK_BYTES, scan.state.compressedBytes! - offset);
        const chunk = new Uint8Array(size);
        const { bytesRead } = await file.read(chunk, 0, size, offset);
        if (bytesRead !== size) throw new Error('Photo location input changed');
        const next = await gateway.request(
          z.object({ scanId: z.uuid(), uploadOffset: z.number().int(), compressedBytes: z.number().int() }),
          `/v1/locations/scans/${scan.id}/upload`,
          {
            method: 'PUT',
            raw: { contentType: 'application/gzip', body: chunk },
            headers: { 'Upload-Offset': String(offset) },
          },
        );
        if (
          next.scanId !== scan.id ||
          next.compressedBytes !== scan.state.compressedBytes ||
          next.uploadOffset !== offset + size
        )
          throw new Error('Invalid location upload receipt');
        offset = next.uploadOffset;
      }
    } finally {
      await file.close();
    }
  }

  private async cleanup(scan: LocationScan) {
    await rm(this.path(scan.id), { force: true });
    await this.repository.clearItems(scan.id);
    if (scan.state.cloudCreated || scan.state.cloudCreateAttempted) {
      try {
        const gateway = await this.gateway(scan.ownerId, scan);
        await gateway.request(
          emptyResponse,
          `/v1/locations/scans/${scan.id}/${scan.status === 'completed' ? 'ack' : 'cancel'}`,
          { method: 'POST', body: {} },
        );
      } catch (error) {
        const oldBindingGone = error instanceof ForbiddenException || error instanceof ServiceUnavailableException;
        const remoteGone = error instanceof FrameleafCloudError && [404, 410].includes(error.status ?? 0);
        const retentionElapsed = Date.now() - new Date(scan.createdAt).getTime() > 8 * 86_400_000;
        if (!oldBindingGone && !remoteGone && !retentionElapsed) throw error;
      }
    }
    await this.repository.patch(scan.id, scan.leaseToken!, { state: {} });
  }

  private async sweepOrphans() {
    let directory;
    try {
      directory = await opendir(join(StorageCore.getMediaLocation(), 'frameleaf', 'location-scans'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for await (const entry of directory) {
      if (!entry.isFile() || !entry.name.endsWith('.json.gz')) continue;
      const id = entry.name.slice(0, -8);
      if (!z.uuid().safeParse(id).success) continue;
      if (!(await this.repository.inputExists(id))) await rm(this.path(id), { force: true });
    }
  }
}
