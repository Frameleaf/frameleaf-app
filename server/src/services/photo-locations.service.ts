import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { mkdir, open, opendir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import z from 'zod';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { LocationBilling, PhotoLocationPoint } from 'src/utils/photo-locations.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnEvent } from 'src/decorators.js';
import {
  LocationScanEstimateRequestDto,
  LocationScanEstimateResponseDto,
  LocationScanStatusResponseDto,
  StartLocationScanDto,
} from 'src/dtos/photo-locations.dto.js';
import { DatabaseLock, FrameleafWorker } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { FrameleafCloudRepository, type FrameleafCloudRequest } from 'src/repositories/frameleaf-cloud.repository.js';
import { InstanceIdentityRepository } from 'src/repositories/instance-identity.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MetadataRepository } from 'src/repositories/metadata.repository.js';
import { type LocationScan, PhotoLocationsRepository } from 'src/repositories/photo-locations.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { CloudMlJobService } from 'src/services/cloud-ml-job.service.js';
import { loadInstanceIdentity, readCloudLink } from 'src/utils/frameleaf-cloud-gateway.js';
import { FrameleafCloudError } from 'src/utils/frameleaf-cloud.js';
import {
  LOCATION_UNIT_PRICE_MICROS,
  LOCATION_UPLOAD_CHUNK_BYTES,
  cloudLocationEstimateSchema,
  cloudLocationResultsSchema,
  cloudLocationStatusSchema,
  locationBillingFinal,
  locationBillingSchema,
  locationNoCharge,
  photoGpsAccuracy,
  writeLocationInput,
} from 'src/utils/photo-locations.js';

const availabilitySchema = z.object({ enabled: z.boolean(), available: z.boolean() });
const emptyResponse = z.unknown();
const billingReceiptSchema = z.object({ scanId: z.uuid(), billing: locationBillingSchema });
const remoteGone = (error: unknown) => error instanceof FrameleafCloudError && [404, 410].includes(error.status ?? 0);
const LOCATION_INPUT_READ_CONCURRENCY = 4;
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
        eligiblePhotos: scan.eligiblePhotos,
        selectedPhotos: scan.selectedPhotos,
        remainingPhotos: Math.max(0, scan.eligiblePhotos - scan.selectedPhotos),
        estimatedMicros: scan.estimatedMicros,
        billing: scan.billing,
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
    private cloudMlJobService: CloudMlJobService,
  ) {
    this.logger.setContext(PhotoLocationsService.name);
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

  private async gateway(ownerId: string, expected?: Pick<LocationScan, 'cloudUrl' | 'instanceId' | 'linkedAt'>) {
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
    try {
      const gateway = await this.gateway(auth.user.id);
      const status = await gateway.request(availabilitySchema, '/v1/locations/status');
      return { enabled: true, available: status.available, scan };
    } catch {
      return { enabled: true, available: false, scan };
    }
  }

  async start(auth: AuthDto, body: StartLocationScanDto): Promise<LocationScanStatusResponseDto> {
    if (auth.sharedLink || !body.consent) throw new BadRequestException('Explicit owner permission is required');
    const existing = await this.repository.getByEstimate(body.estimateId, auth.user.id);
    if (existing) return { enabled: true, available: true, scan: summary(existing) };
    const kept = await this.repository.getEstimate(body.estimateId, auth.user.id);
    if (!kept || new Date(kept.expiresAt).getTime() <= Date.now()) {
      throw new ConflictException({ code: 'estimate-expired', message: 'This estimate expired; estimate again' });
    }
    const approved = kept.record;
    const gateway = await this.gateway(auth.user.id, approved);
    const quote = await this.quote(gateway, approved.quote.eligiblePhotos, {
      refresh: approved.refresh,
      maxPhotos: approved.quote.selectedPhotos,
      maxSpendMicros: approved.quote.holdMicros,
    });
    return this.databaseRepository.withLock(DatabaseLock.FrameleafCloudMlJobEstimates, async () => {
      const existing = await this.repository.getByEstimate(body.estimateId, auth.user.id);
      if (existing) return { enabled: true, available: true, scan: summary(existing) };
      const kept = await this.repository.getEstimate(body.estimateId, auth.user.id);
      if (!kept || new Date(kept.expiresAt).getTime() <= Date.now()) {
        throw new ConflictException({ code: 'estimate-expired', message: 'This estimate expired; estimate again' });
      }
      await this.gateway(auth.user.id, approved);
      if (quote.holdMicros > approved.quote.holdMicros)
        throw new ConflictException('The price changed; estimate again');
      if (quote.availableMicros < quote.holdMicros)
        throw new HttpException(
          { code: 'insufficient-credits', message: 'Add AI credit before starting this scan' },
          402,
        );
      await this.requirePermission(auth, approved.quote.holdMicros);
      try {
        const scan = await this.repository.create(auth.user.id, approved.refresh, gateway, approved.quote, quote);
        return { enabled: true, available: true, scan: summary(scan) };
      } catch (error) {
        if ((error as { code?: string }).code === '23505')
          throw new ConflictException('A photo location scan is already active');
        throw error;
      }
    });
  }

  async estimate(auth: AuthDto, body: LocationScanEstimateRequestDto): Promise<LocationScanEstimateResponseDto> {
    if (auth.sharedLink) throw new ForbiddenException('Only the library owner can estimate a scan');
    if (body.maxPhotos === undefined && body.maxSpendMicros === undefined)
      throw new BadRequestException('Choose a photo or spending limit');
    const gateway = await this.gateway(auth.user.id);
    const available = await gateway.request(availabilitySchema, '/v1/locations/status');
    if (!available.available)
      throw new ForbiddenException('A live Frameleaf licence covering this user and server is required');
    const count = await this.repository.countEligible(auth.user.id, body.refresh);
    if (count === 0)
      return {
        estimateId: null,
        expiresAt: null,
        currency: 'USD',
        unitPriceMicros: 5000,
        eligiblePhotos: 0,
        selectedPhotos: 0,
        remainingPhotos: 0,
        estimatedMicros: 0,
        holdMicros: 0,
        availableMicros: null,
        canStart: false,
        refusal: 'No eligible photos need location identification',
        topUpUrl: null,
      };
    const quote = await this.quote(gateway, count, body);
    const permission = await this.cloudMlJobService.spendPermission(auth, quote.holdMicros / 1_000_000, new Date(), {
      exactHold: true,
    });
    await this.repository.keepEstimate(auth.user.id, {
      quote,
      refresh: body.refresh,
      maxPhotos: body.maxPhotos,
      maxSpendMicros: body.maxSpendMicros,
      cloudUrl: gateway.cloudUrl,
      instanceId: gateway.instanceId,
      linkedAt: gateway.linkedAt,
    });
    const refusal = !permission.canConfirm
      ? permission.reason === 'monthly-cap'
        ? 'This scan exceeds your monthly AI spending limit'
        : 'An administrator must allow you to spend AI credit'
      : quote.availableMicros < quote.holdMicros
        ? 'Add AI credit before starting this scan'
        : null;
    return { ...quote, estimatedMicros: quote.holdMicros, canStart: refusal === null, refusal, topUpUrl: null };
  }

  private async quote(
    gateway: Awaited<ReturnType<PhotoLocationsService['gateway']>>,
    count: number,
    caps: Pick<LocationScanEstimateRequestDto, 'refresh' | 'maxPhotos' | 'maxSpendMicros'>,
  ) {
    const quote = await gateway.request(cloudLocationEstimateSchema, '/v1/locations/estimates', {
      method: 'POST',
      body: {
        photoCount: count,
        locale: 'en',
        refresh: caps.refresh,
        ...(caps.maxPhotos === undefined ? {} : { maxPhotos: caps.maxPhotos }),
        ...(caps.maxSpendMicros === undefined ? {} : { maxSpendMicros: caps.maxSpendMicros }),
      },
    });
    const selected = Math.min(
      count,
      caps.maxPhotos ?? count,
      caps.maxSpendMicros === undefined ? count : Math.floor(caps.maxSpendMicros / LOCATION_UNIT_PRICE_MICROS),
    );
    if (
      quote.eligiblePhotos !== count ||
      quote.selectedPhotos !== selected ||
      quote.holdMicros !== selected * LOCATION_UNIT_PRICE_MICROS ||
      quote.remainingPhotos !== count - selected ||
      Date.parse(quote.expiresAt) <= Date.now()
    )
      throw new Error('Invalid Cloud location estimate');
    return quote;
  }

  private async requirePermission(auth: AuthDto, micros: number, excludeLocationScanId?: string) {
    const permission = await this.cloudMlJobService.spendPermission(auth, micros / 1_000_000, new Date(), {
      exactHold: true,
      excludeLocationScanId,
    });
    if (!permission.canConfirm)
      throw new ForbiddenException(
        permission.reason === 'monthly-cap'
          ? 'This scan exceeds your monthly AI spending limit'
          : 'An administrator must allow you to spend AI credit',
      );
  }

  async cancel(auth: AuthDto, id: string): Promise<void> {
    const scan = await this.repository.get(id, auth.user.id);
    if (!scan || auth.sharedLink) throw new NotFoundException('Location scan not found');
    await this.repository.cancel(id, auth.user.id);
    // Cancellation fences normal processing; cleanup retains only work already checked when Cloud stops.
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
      const gateway = await this.gateway(scan.ownerId, scan);
      if (!scan.estimateId) throw new ForbiddenException('Approve a paid location estimate before starting a scan');
      if (!scan.state.sha256) {
        const frozenCount = await this.repository.freeze(scan);
        Object.assign(scan, {
          total: frozenCount,
          selectedPhotos: frozenCount,
          estimatedMicros: frozenCount * LOCATION_UNIT_PRICE_MICROS,
        });
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
        await this.databaseRepository.withLock(DatabaseLock.FrameleafCloudMlJobEstimates, async () => {
          const user = await this.repository.owner(scan.ownerId);
          await this.requirePermission({ user } as AuthDto, scan.estimatedMicros, scan.id);
        });
        if (
          !scan.state.cloudCreateAttempted &&
          (!scan.state.quoteExpiresAt || Date.parse(scan.state.quoteExpiresAt) <= Date.now())
        ) {
          const quote = await this.quote(gateway, scan.state.pointCount!, {
            refresh: scan.refresh,
            maxPhotos: scan.state.pointCount!,
            maxSpendMicros: scan.estimatedMicros,
          });
          if (quote.holdMicros > scan.estimatedMicros)
            throw new ForbiddenException('The estimate exceeds the approved limit');
          scan.state.cloudEstimateId = quote.estimateId;
          scan.state.quoteExpiresAt = quote.expiresAt;
        }
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
              estimateId: scan.state.cloudEstimateId ?? scan.estimateId,
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
      await this.recordBilling(scan, remote.billing);
      if (remote.state === 'uploading') {
        if (remote.billing.state === 'pending_hold') return;
        if (
          remote.billing.state !== 'held' ||
          remote.billing.heldMicros !== scan.state.pointCount! * LOCATION_UNIT_PRICE_MICROS
        ) {
          throw new Error('Cloud has not reserved the approved location credit');
        }
        await this.upload(scan, gateway, remote.uploadOffset);
        if (this.stopping || !(await this.repository.active(scan.id, token))) return;
        if (!(await this.repository.inputStillEligible(scan)))
          throw new ForbiddenException('Photo locations or privacy changed before processing');
        const started = await gateway.request(cloudLocationStatusSchema, `${base}/start`, { method: 'POST', body: {} });
        await this.recordBilling(scan, started.billing);
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
      } else if (status.state === 'acknowledged') {
        await this.repository.patch(scan.id, token, {
          status: 'failed',
          error: 'Cloud could not complete this scan; start another scan',
          state: { ...scan.state, cleanupPending: true },
        });
        return;
      }
      if (status.state !== 'paused') await this.repository.patch(scan.id, token, { status: 'running', reason: null });
      const page = await this.resultPage(scan, gateway);
      if (page.items.length > 0 && !(await this.repository.adopt(scan.id, token, page.items))) return;
      if (page.nextOffset !== null) {
        scan.state.resultOffset = page.nextOffset;
        await this.repository.patch(scan.id, token, { state: scan.state });
      } else {
        if (!['completed', 'failed', 'expired', 'cancelled'].includes(status.state))
          throw new Error('Location results ended before the scan');
        const failed = Math.max(0, scan.total - status.billing.checkedPhotos);
        if (status.state === 'completed') await this.repository.finish(scan.id, token, failed);
        else
          await this.repository.patch(scan.id, token, {
            status: 'failed',
            failed,
            error: 'Cloud stopped this scan; completed suggestions were retained',
            state: { ...scan.state, cleanupPending: true },
          });
      }
    } catch (error) {
      if (!(await this.repository.active(scan.id, token))) return;
      const fatal =
        error instanceof ForbiddenException ||
        error instanceof RangeError ||
        error instanceof z.ZodError ||
        (error instanceof FrameleafCloudError &&
          error.status !== null &&
          [400, 401, 402, 403, 404, 409, 410, 413, 422].includes(error.status));
      if (error instanceof FrameleafCloudError && error.status === 402 && !scan.state.cloudCreated) {
        scan.state.cloudCreateAttempted = false;
        scan.billing = locationNoCharge();
      }
      await this.repository.patch(
        scan.id,
        token,
        fatal
          ? {
              status: 'failed',
              ...(scan.billing ? { billing: scan.billing } : {}),
              error:
                error instanceof RangeError
                  ? 'Photo location input exceeds the 128 MiB compressed or 1 GiB expanded limit'
                  : error instanceof FrameleafCloudError && error.status === 402
                    ? 'Add AI credit before starting another scan'
                    : 'Location identification could not complete; check Cloud availability and try again',
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
      for (let index = 0; index < points.length; index += LOCATION_INPUT_READ_CONCURRENCY) {
        if (this.stopping || !(await this.repository.active(scan.id, scan.leaseToken!))) {
          throw new Error('Location scan cancelled');
        }
        const batch = points.slice(index, index + LOCATION_INPUT_READ_CONCURRENCY);
        const prepared = await Promise.all(
          batch.map(async (point) => {
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
            return {
              itemKey: point.itemKey,
              latitude: point.latitude!,
              longitude: point.longitude!,
              ...(accuracyM === null ? {} : { accuracyM }),
            };
          }),
        );
        if (this.stopping || !(await this.repository.active(scan.id, scan.leaseToken!))) {
          throw new Error('Location scan cancelled');
        }
        yield* prepared;
        after = batch.at(-1)!.assetId;
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
    const token = scan.leaseToken!;
    if (this.stopping || !(await this.repository.cleanupActive(scan.id, token))) return;
    if (scan.state.cloudCreated || scan.state.cloudCreateAttempted) {
      try {
        const gateway = await this.gateway(scan.ownerId, scan);
        const base = `/v1/locations/scans/${scan.id}`;
        let privateGone = false;
        let terminal = scan.status === 'completed';
        if (!terminal) {
          try {
            await gateway.request(emptyResponse, `${base}/cancel`, { method: 'POST', body: {} });
          } catch (error) {
            if (!remoteGone(error)) throw error;
          }
          try {
            const remote = await gateway.request(cloudLocationStatusSchema, base);
            if (remote.scanId !== scan.id) throw new Error('Location scan identity mismatch');
            terminal = ['completed', 'failed', 'expired', 'cancelled', 'acknowledged'].includes(remote.state);
          } catch (error) {
            if (!remoteGone(error)) throw error;
            privateGone = true;
          }
        }
        // Receipts outlive the private scan; absence of private input cannot prove that no credit was charged.
        const billing = await this.readBilling(scan, gateway);
        if (!privateGone && !terminal) throw new Error('Location scan cancellation is pending');
        if (!privateGone && scan.status !== 'completed' && billing.checkedPhotos > 0) {
          try {
            const page = await this.resultPage(scan, gateway);
            if (this.stopping || !(await this.repository.cleanupActive(scan.id, token))) return;
            if (
              page.items.length > 0 &&
              !(await this.repository.adoptCompleted(scan.id, token, page.items, billing.checkedPhotos))
            )
              return;
            if (page.nextOffset !== null) {
              scan.state.resultOffset = page.nextOffset;
              await this.repository.patch(scan.id, token, { state: scan.state });
            }
            if (!page.complete) return;
          } catch (error) {
            if (!remoteGone(error)) throw error;
            privateGone = true;
          }
        }
        if (!locationBillingFinal(billing)) throw new Error('Location credit settlement is pending');
        if (this.stopping || !(await this.repository.cleanupActive(scan.id, token))) return;
        if (!privateGone) {
          try {
            await gateway.request(emptyResponse, `${base}/ack`, { method: 'POST', body: {} });
          } catch (error) {
            if (!remoteGone(error)) throw error;
          }
        }
      } catch (error) {
        const oldBindingGone = error instanceof ForbiddenException || error instanceof ServiceUnavailableException;
        const retentionElapsed = Date.now() - new Date(scan.createdAt).getTime() > 8 * 86_400_000;
        if (oldBindingGone || retentionElapsed) await this.repository.clearItems(scan.id, token);
        if (!oldBindingGone) throw error;
        const current = await this.gateway(scan.ownerId);
        if (current.cloudUrl !== scan.cloudUrl || current.instanceId !== scan.instanceId) throw error;
        // Relinking the same instance permits financial recovery, never replaying its old GPS input or results.
        const billing = await this.readBilling(scan, current);
        if (!locationBillingFinal(billing)) throw new Error('Location credit settlement is pending', { cause: error });
      }
    } else {
      await this.recordBilling(scan, locationNoCharge());
    }
    await this.repository.clearItems(scan.id, token);
    await this.repository.patch(scan.id, token, { state: {} });
  }

  private async resultPage(scan: LocationScan, gateway: Awaited<ReturnType<PhotoLocationsService['gateway']>>) {
    const offset = scan.state.resultOffset ?? 0;
    const page = await gateway.request(
      cloudLocationResultsSchema,
      `/v1/locations/scans/${scan.id}/results?offset=${offset}&limit=500`,
      { maxBodyBytes: 8 * 1024 * 1024 },
    );
    if (
      page.scanId !== scan.id ||
      (page.complete ? page.nextOffset !== null : page.nextOffset === null) ||
      (page.nextOffset !== null &&
        (page.nextOffset < offset || (page.items.length > 0 && page.nextOffset === offset))) ||
      (!page.complete && page.items.length === 0 && page.nextOffset !== offset) ||
      new Set(page.items.map((r) => r.itemKey)).size !== page.items.length
    ) {
      throw new Error('Invalid location results');
    }
    return page;
  }

  private async recordBilling(scan: LocationScan, billing: LocationBilling) {
    if (
      billing.heldMicros > scan.estimatedMicros ||
      billing.checkedPhotos > scan.total ||
      (billing.chargedMicros !== null &&
        billing.chargedMicros !== billing.checkedPhotos * LOCATION_UNIT_PRICE_MICROS) ||
      (locationBillingFinal(billing) && billing.chargedMicros! + billing.releasedMicros! !== billing.heldMicros)
    ) {
      throw new Error('Invalid location billing receipt');
    }
    scan.billing = billing;
    await this.repository.patch(scan.id, scan.leaseToken!, { billing });
  }

  private async readBilling(scan: LocationScan, gateway: Awaited<ReturnType<PhotoLocationsService['gateway']>>) {
    const receipt = await gateway.request(billingReceiptSchema, `/v1/locations/scans/${scan.id}/billing`);
    if (receipt.scanId !== scan.id) throw new Error('Location billing identity mismatch');
    await this.recordBilling(scan, receipt.billing);
    return receipt.billing;
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
