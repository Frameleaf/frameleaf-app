import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { ArgOf } from 'src/repositories/event.repository.js';
import type { PushDeviceWithActivities } from 'src/repositories/push-device.repository.js';
import type { JobOf } from 'src/types.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import {
  PushActivityTokenDto,
  PushDeviceListResponseDto,
  PushDeviceRegisterDto,
  PushDeviceResponseDto,
  PushDeviceUpdateDto,
  PushPreferencesDto,
  PushStatusResponseDto,
} from 'src/dtos/push.dto.js';
import { JobName, JobStatus, PushEventType, PushPlatform, PushUnavailableReason, QueueName } from 'src/enum.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { FrameleafCloudPushRepository } from 'src/repositories/frameleaf-cloud-push.repository.js';
import { FrameleafCloudRepository } from 'src/repositories/frameleaf-cloud.repository.js';
import { InstanceIdentityRepository } from 'src/repositories/instance-identity.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PushDeviceRepository } from 'src/repositories/push-device.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { loadInstanceIdentity, readCloudLink } from 'src/utils/frameleaf-cloud-gateway.js';
import { FrameleafCloudError } from 'src/utils/frameleaf-cloud.js';
import {
  CLOUD_BACKUP_ACTIVITY_KIND,
  CLOUD_BACKUP_ATTRIBUTES_TYPE,
  PUSH_GATEWAY_CONCURRENCY,
  PUSH_GATEWAY_MAX_ATTEMPTS,
  PushNotice,
  PushSendRequest,
  PushSendResult,
  PushTargetKind,
  buildPushPayload,
  collapseIdOf,
  isGatewayToken,
  liveActivityStateOf,
  pushTtlSec,
} from 'src/utils/frameleaf-push.js';
import { type HiddenContentFilter, hasHiddenContentFilter } from 'src/utils/hidden-content.js';
import { notificationLocaleOf } from 'src/utils/notification-locale.js';
import { getPreferences } from 'src/utils/preferences.js';
import { parsePushPublicKey, pushKeyFingerprint, sealPushEnvelope } from 'src/utils/push-crypto.js';

/** How long a phone backup may go without a reported success before the device is woken. */
export const PUSH_BACKUP_STALE_AFTER_MS = 48 * 60 * 60 * 1000;
/** At most one stale-backup wake-up per device in this window (the nightly job runs once a day). */
export const PUSH_BACKUP_WAKE_INTERVAL_MS = 20 * 60 * 60 * 1000;
/** Album additions wait this long, so photos added one by one become one notice. */
export const PUSH_ALBUM_UPDATE_DELAY_MS = 60_000;

/** The API's preference names and the event each one switches. */
const PREFERENCE_EVENTS: Record<keyof PushPreferencesDto, PushEventType> = {
  backupNeedsAttention: PushEventType.BackupNeedsAttention,
  backupStale: PushEventType.BackupStale,
  cloudBackupActivation: PushEventType.CloudBackupActivation,
  sharedActivity: PushEventType.SharedActivity,
  memories: PushEventType.Memories,
  renderFinished: PushEventType.RenderFinished,
  accessChanged: PushEventType.AccessChanged,
};

const disabledEventsOf = (preferences: PushPreferencesDto | undefined, current: string[] = []): string[] => {
  const disabled = new Set(current);
  for (const [name, event] of Object.entries(PREFERENCE_EVENTS) as Array<[keyof PushPreferencesDto, PushEventType]>) {
    const value = preferences?.[name];
    if (value === true) {
      disabled.delete(event);
    } else if (value === false) {
      disabled.add(event);
    }
  }
  return Object.values(PushEventType).filter((event) => disabled.has(event));
};

const mapDevice = (device: PushDeviceWithActivities, currentSessionId?: string): PushDeviceResponseDto => ({
  id: device.id,
  platform: device.platform,
  current: device.sessionId === currentSessionId,
  publicKeyFingerprint: pushKeyFingerprint(device.publicKey),
  hasPushToStartToken: !!device.pushToStartToken,
  apnsEnvironment: device.platform === PushPlatform.Ios ? (device.apnsEnvironment ?? 'production') : null,
  backupDeviceKey: device.backupDeviceKey,
  preferences: Object.fromEntries(
    Object.entries(PREFERENCE_EVENTS).map(([name, event]) => [name, !device.disabledEvents.includes(event)]),
  ) as PushDeviceResponseDto['preferences'],
  activities: device.activities.map(({ activityId, kind, updatedAt }) => ({
    activityId,
    kind,
    updatedAt: new Date(updatedAt).toISOString(),
  })),
  createdAt: new Date(device.createdAt).toISOString(),
  updatedAt: new Date(device.updatedAt).toISOString(),
  lastDeliveredAt: device.lastDeliveredAt ? new Date(device.lastDeliveredAt).toISOString() : null,
});

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

type PlannedMessage = {
  request: PushSendRequest;
  deviceId: string;
  kind: PushTargetKind;
  activityRowId?: string;
};

/** One target of a notice: which device, which of its tokens. A retry names the targets it is for. */
const deliveryKeyOf = ({ deviceId, kind, activityRowId }: Omit<PlannedMessage, 'request'>) =>
  `${deviceId}:${kind}:${activityRowId ?? ''}`;

/** The collapse id of a notice: from its dedupe key, or the one its first attempt had. */
const collapseIdOfNotice = (notice: Pick<PushNotice, 'dedupeKey' | 'retry'>) =>
  notice.retry?.collapseId ?? collapseIdOf(notice.dedupeKey);

/** A 429 or 503 from the gateway may say when to come back (`Retry-After`, or the error's `retryAfterSec`). */
const retryAfterOf = (error: unknown): { retryAfterSec?: number } => {
  if (!(error instanceof FrameleafCloudError)) {
    return {};
  }
  const fromData = error.envelope?.data?.retryAfterSec;
  const seconds = error.retryAfterSeconds ?? (typeof fromData === 'number' ? fromData : null);
  return seconds && Number.isFinite(seconds) && seconds > 0 ? { retryAfterSec: Math.ceil(seconds) } : {};
};

/** Wait before retry `attempt` (2, 3, …): 30 s, 2 min, 8 min, …, or the gateway's own `retryAfterSec` when longer. */
const retryDelayMs = (attempt: number, retryAfterSec?: number) =>
  Math.max(30_000 * 4 ** (attempt - 2), (retryAfterSec ?? 0) * 1000);

/**
 * FL-228: push notifications for the native apps. Devices register a push token and a per-device key;
 * events become notices, and each notice is delivered as an encrypted blob per device through the
 * Frameleaf push gateway. Only a linked server delivers; an unlinked one reports push as unavailable.
 */
@Injectable()
export class PushService {
  constructor(
    private logger: LoggingRepository,
    private configRepository: ConfigRepository,
    private systemMetadataRepository: SystemMetadataRepository,
    private databaseRepository: DatabaseRepository,
    private instanceIdentityRepository: InstanceIdentityRepository,
    private frameleafCloudRepository: FrameleafCloudRepository,
    private devices: PushDeviceRepository,
    private gateway: FrameleafCloudPushRepository,
    private jobRepository: JobRepository,
    private userRepository: UserRepository,
    private albumRepository: AlbumRepository,
  ) {
    this.logger.setContext(PushService.name);
  }

  /* ------------------------------------------------------------------ */
  /* API                                                                 */
  /* ------------------------------------------------------------------ */

  async getStatus(auth: AuthDto): Promise<PushStatusResponseDto> {
    const { reason } = await this.availability();
    const registered = auth.session ? !!(await this.devices.getBySession(auth.session.id)) : false;
    return {
      available: reason === null,
      reason,
      encryption: { scheme: 'frameleaf-push-v1', keyAgreement: 'X25519', kdf: 'HKDF-SHA256', cipher: 'AES-256-GCM' },
      events: Object.values(PushEventType),
      registered,
    };
  }

  async listDevices(auth: AuthDto): Promise<PushDeviceListResponseDto> {
    this.requireUser(auth);
    const devices = await this.devices.getByUser(auth.user.id);
    return { devices: devices.map((device) => mapDevice(device, auth.session?.id)) };
  }

  async register(auth: AuthDto, dto: PushDeviceRegisterDto): Promise<PushDeviceResponseDto> {
    const sessionId = this.requireSession(auth);
    const pushToStartToken = dto.pushToStartToken ?? null;
    if (dto.platform !== PushPlatform.Ios && (pushToStartToken || dto.apnsEnvironment)) {
      throw new BadRequestException('Only iOS devices have an ActivityKit push-to-start token or an APNs environment');
    }
    this.requireTokens(dto.pushToken, pushToStartToken);
    const publicKey = this.parseKey(dto.publicKey);
    const current = await this.devices.getBySession(sessionId);
    const device = await this.devices.upsert({
      userId: auth.user.id,
      sessionId,
      platform: dto.platform,
      pushToken: dto.pushToken,
      pushToStartToken,
      apnsEnvironment: dto.apnsEnvironment === 'sandbox' ? 'sandbox' : null,
      publicKey,
      backupDeviceKey: dto.backupDeviceKey ?? null,
      disabledEvents: disabledEventsOf(dto.preferences, current?.disabledEvents),
    });
    this.logger.log(`Push device ${device.id} (${device.platform}) registered for user ${auth.user.id}`);
    return mapDevice({ ...device, activities: current?.activities ?? [] }, sessionId);
  }

  async update(auth: AuthDto, dto: PushDeviceUpdateDto): Promise<PushDeviceResponseDto> {
    const sessionId = this.requireSession(auth);
    const current = await this.devices.getBySession(sessionId);
    if (!current) {
      throw new NotFoundException('This device is not registered for push notifications');
    }
    if (current.platform !== PushPlatform.Ios && (dto.pushToStartToken || dto.apnsEnvironment)) {
      throw new BadRequestException('Only iOS devices have an ActivityKit push-to-start token or an APNs environment');
    }
    this.requireTokens(dto.pushToken, dto.pushToStartToken);
    const changes = {
      ...(dto.apnsEnvironment !== undefined && {
        apnsEnvironment: dto.apnsEnvironment === 'sandbox' ? ('sandbox' as const) : null,
      }),
      ...(dto.pushToken !== undefined && { pushToken: dto.pushToken }),
      ...(dto.pushToStartToken !== undefined && { pushToStartToken: dto.pushToStartToken }),
      ...(dto.publicKey !== undefined && { publicKey: this.parseKey(dto.publicKey) }),
      ...(dto.backupDeviceKey !== undefined && { backupDeviceKey: dto.backupDeviceKey }),
      ...(dto.preferences !== undefined && {
        disabledEvents: disabledEventsOf(dto.preferences, current.disabledEvents),
      }),
    };
    const device = await this.devices.update(sessionId, changes);
    if (!device) {
      throw new NotFoundException('This device is not registered for push notifications');
    }
    return mapDevice({ ...device, activities: current.activities }, sessionId);
  }

  async unregisterCurrent(auth: AuthDto): Promise<void> {
    const sessionId = this.requireSession(auth);
    await this.devices.deleteBySession(sessionId);
  }

  async remove(auth: AuthDto, id: string): Promise<void> {
    this.requireUser(auth);
    if (!(await this.devices.deleteForUser(auth.user.id, id))) {
      throw new NotFoundException('Push device not found');
    }
  }

  async setActivityToken(auth: AuthDto, activityId: string, dto: PushActivityTokenDto): Promise<PushDeviceResponseDto> {
    const sessionId = this.requireSession(auth);
    const current = await this.devices.getBySession(sessionId);
    if (!current) {
      throw new NotFoundException('This device is not registered for push notifications');
    }
    if (current.platform !== PushPlatform.Ios) {
      throw new BadRequestException('Only iOS devices have Live Activity push tokens');
    }
    this.requireTokens(dto.token);
    await this.devices.setActivity(current.id, { activityId, kind: dto.kind, token: dto.token });
    const device = await this.devices.getBySession(sessionId);
    return mapDevice(device ?? current, sessionId);
  }

  async removeActivityToken(auth: AuthDto, activityId: string): Promise<void> {
    const sessionId = this.requireSession(auth);
    const current = await this.devices.getBySession(sessionId);
    if (!current || !(await this.devices.deleteActivity(current.id, activityId))) {
      throw new NotFoundException('Live Activity not found');
    }
  }

  /* ------------------------------------------------------------------ */
  /* Token lifecycle                                                     */
  /* ------------------------------------------------------------------ */

  /** Logout and session revocation; the foreign key already removed the row, this covers any path. */
  @OnEvent({ name: 'SessionDelete' })
  async onSessionDelete({ sessionId }: ArgOf<'SessionDelete'>) {
    await this.devices.deleteBySession(sessionId);
  }

  /** Account removal: a trashed account gets nothing more, long before it is deleted for good. */
  @OnEvent({ name: 'UserTrash' })
  async onUserTrash({ id }: ArgOf<'UserTrash'>) {
    const removed = await this.devices.deleteAllForUser(id);
    if (removed > 0) {
      this.logger.log(`Removed ${removed} push device(s) of removed user ${id}`);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Event selection                                                     */
  /* ------------------------------------------------------------------ */

  @OnEvent({ name: 'PushNotify' })
  async onPushNotify(notice: ArgOf<'PushNotify'>) {
    await this.queue(notice);
  }

  /** Items were added to a shared album or space: one coalesced notice per member who did not add them. */
  @OnEvent({ name: 'AlbumUpdate' })
  async onAlbumUpdate({ id, recipientIds }: ArgOf<'AlbumUpdate'>) {
    if (recipientIds.length === 0 || !(await this.isLinked())) {
      return;
    }
    const album = await this.albumInfo(id);
    if (!album) {
      return;
    }
    for (const recipientId of recipientIds) {
      await this.queue({
        type: PushEventType.SharedActivity,
        userIds: [recipientId],
        title: album.albumName,
        body: `New items were added to ${album.albumName}`,
        systemTemplate: { version: 1, key: 'push-album-update', args: { albumName: album.albumName } },
        data: { albumId: id, action: 'items-added' },
        assetIds: album.albumThumbnailAssetId ? [album.albumThumbnailAssetId] : [],
        dedupeKey: `album-update/${id}/${recipientId}`,
        delayMs: PUSH_ALBUM_UPDATE_DELAY_MS,
      });
    }
  }

  @OnEvent({ name: 'AlbumInvite' })
  async onAlbumInvite({ id, userId, senderName }: ArgOf<'AlbumInvite'>) {
    if (!(await this.isLinked())) {
      return;
    }
    const album = await this.albumInfo(id);
    if (!album) {
      return;
    }
    await this.queue({
      type: PushEventType.SharedActivity,
      userIds: [userId],
      title: 'Shared with you',
      body: `${senderName} shared ${album.albumName} with you`,
      systemTemplate: { version: 1, key: 'push-album-invite', args: { senderName, albumName: album.albumName } },
      data: { albumId: id, action: 'invited' },
      assetIds: album.albumThumbnailAssetId ? [album.albumThumbnailAssetId] : [],
    });
  }

  @OnEvent({ name: 'ItemShare' })
  async onItemShare({ ownerId, userId, senderName, count }: ArgOf<'ItemShare'>) {
    // like the in-app notification, it never names or shows an item (FL-83)
    await this.queue({
      type: PushEventType.SharedActivity,
      userIds: [userId],
      title: 'Shared with you',
      body: count === 1 ? `${senderName} shared an item with you` : `${senderName} shared ${count} items with you`,
      systemTemplate:
        count === 1
          ? { version: 1, key: 'item-share-one', args: { senderName } }
          : { version: 1, key: 'item-share-many', args: { senderName, count } },
      data: { ownerId, count, action: 'items-shared' },
    });
  }

  @OnEvent({ name: 'SharedSpaceMention' })
  async onSharedSpaceMention({ id, assetId, activityId, userIds, senderName }: ArgOf<'SharedSpaceMention'>) {
    if (userIds.length === 0 || !(await this.isLinked())) {
      return;
    }
    const album = await this.albumInfo(id);
    if (!album) {
      return;
    }
    await this.queue({
      type: PushEventType.SharedActivity,
      userIds,
      title: 'Mentioned in a shared space',
      body: `${senderName} mentioned you in ${album.albumName}`,
      systemTemplate: { version: 1, key: 'space-mention', args: { senderName, albumName: album.albumName } },
      data: { albumId: id, activityId, action: 'mentioned', ...(assetId && { assetId }) },
      assetIds: assetId ? [assetId] : [],
    });
  }

  @OnEvent({ name: 'SharedSpaceReply' })
  async onSharedSpaceReply({ id, assetId, activityId, userId, senderName }: ArgOf<'SharedSpaceReply'>) {
    if (!(await this.isLinked())) {
      return;
    }
    const album = await this.albumInfo(id);
    if (!album) {
      return;
    }
    await this.queue({
      type: PushEventType.SharedActivity,
      userIds: [userId],
      title: 'New reply',
      body: `${senderName} replied to your comment in ${album.albumName}`,
      systemTemplate: { version: 1, key: 'push-space-reply', args: { senderName, albumName: album.albumName } },
      data: { albumId: id, activityId, action: 'replied', ...(assetId && { assetId }) },
      assetIds: assetId ? [assetId] : [],
    });
  }

  /** A member was taken out of an album or shared space: their access ended. Leaving by oneself is silent. */
  @OnEvent({ name: 'AlbumUserRemove' })
  async onAlbumUserRemove({ albumId, userId, removedById }: ArgOf<'AlbumUserRemove'>) {
    if (removedById === userId || !(await this.isLinked())) {
      return;
    }
    const album = await this.albumInfo(albumId);
    await this.queue({
      type: PushEventType.AccessChanged,
      userIds: [userId],
      title: 'Access changed',
      body: album ? `You no longer have access to ${album.albumName}` : 'You no longer have access to an album',
      systemTemplate: album
        ? { version: 1, key: 'access-removed', args: { albumName: album.albumName } }
        : { version: 1, key: 'access-removed-unknown', args: {} },
      data: { albumId, change: 'removed' },
    });
  }

  /* ------------------------------------------------------------------ */
  /* Delivery                                                            */
  /* ------------------------------------------------------------------ */

  @OnJob({ name: JobName.PushDeliver, queue: QueueName.Notification })
  async handleDeliver({ notice }: JobOf<JobName.PushDeliver>): Promise<JobStatus> {
    const availability = await this.availability();
    if (availability.reason !== null) {
      this.logger.debug(`Push ${notice.type} not delivered: push is unavailable (${availability.reason})`);
      return JobStatus.Skipped;
    }

    const recipients = new Set(notice.userIds);
    if (notice.admins) {
      for (const admin of await this.userRepository.getAdmins()) {
        recipients.add(admin.id);
      }
    }
    let devices = (await this.devices.getDeliveryTargets([...recipients])).filter(
      (device) => !device.disabledEvents.includes(notice.type),
    );
    if (notice.backupDeviceKey) {
      const linked = devices.filter((device) => device.backupDeviceKey === notice.backupDeviceKey);
      // a wake-up is for that device alone; anything else may go to all of the owner's devices
      devices = linked.length > 0 || notice.background ? linked : devices;
    }
    if (devices.length === 0) {
      return JobStatus.Skipped;
    }

    // a recipient's hidden people, pets and tags hide an item from that recipient's push alone (FL-293)
    const assetIds = [...new Set(notice.assetIds)];
    const safeForAll = await this.devices.getPreviewSafeAssetIds(assetIds);
    const safeAssetIds = new Map<string, Set<string>>();
    const locales = new Map<string, ReturnType<typeof getPreferences>>();
    for (const userId of new Set(devices.map((device) => device.userId))) {
      // Read at delivery, including retries; queued notices never freeze a device's language.
      locales.set(userId, getPreferences((await this.userRepository.getMetadata(userId).catch(() => [])) ?? []));
      const hiddenContent = safeForAll.size > 0 ? await this.hiddenContentOf(userId) : undefined;
      safeAssetIds.set(
        userId,
        hiddenContent ? await this.devices.getPreviewSafeAssetIds(assetIds, hiddenContent) : safeForAll,
      );
    }
    const sentAt = new Date().toISOString();
    let planned = devices.flatMap((device) =>
      this.plan(
        device,
        notice,
        safeAssetIds.get(device.userId)!,
        sentAt,
        notificationLocaleOf(locales.get(device.userId)!, device.sessionId),
      ),
    );
    if (notice.retry) {
      const wanted = new Set(notice.retry.targets);
      planned = planned.filter((entry) => wanted.has(deliveryKeyOf(entry)));
    }
    if (planned.length === 0) {
      return JobStatus.Skipped;
    }

    let target;
    try {
      target = await this.gatewayTarget(availability.instanceId!, availability.cloudUrl!);
    } catch (error) {
      this.logger.warn(`Push ${notice.type} to ${planned.length} target(s) failed: ${errorMessage(error)}`);
      return JobStatus.Failed;
    }
    if (!target) {
      this.logger.debug(`Push ${notice.type} not delivered: no push gateway address (FRAMELEAF_PUSH_URL)`);
      return JobStatus.Skipped;
    }

    // one push per request, a few at a time; a failed request is the gateway's `retry` or a refusal
    const results: Array<{ entry: PlannedMessage; result: PushSendResult | 'rejected' }> = [];
    const queue = [...planned];
    const worker = async () => {
      for (let entry = queue.shift(); entry; entry = queue.shift()) {
        if (!isGatewayToken(entry.request.token)) {
          // registered before tokens were checked: the gateway could never deliver to it
          results.push({ entry, result: { status: 'invalid-token' } });
          continue;
        }
        try {
          results.push({ entry, result: await this.gateway.send(target, entry.request) });
        } catch (error) {
          // a request this server built wrongly is refused, never retried
          const status = error instanceof FrameleafCloudError ? error.status : error instanceof ZodError ? 400 : null;
          // never the request: it holds the device token
          this.logger.warn(`Push ${notice.type}: the gateway refused a send: ${errorMessage(error)}`);
          results.push({
            entry,
            result:
              status === null || status >= 500 || status === 429
                ? { status: 'retry', ...retryAfterOf(error) }
                : 'rejected',
          });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PUSH_GATEWAY_CONCURRENCY, planned.length) }, () => worker()));

    const delivered = new Set<string>();
    const goneDevices = new Set<string>();
    const goneStartTokens = new Set<string>();
    const goneActivities = new Set<string>();
    const again: PlannedMessage[] = [];
    let retryAfterSec = 0;
    let rejected = 0;
    for (const { entry, result } of results) {
      if (result === 'rejected') {
        rejected++;
      } else if (result.status === 'sent') {
        delivered.add(entry.deviceId);
      } else if (result.status === 'invalid-token') {
        if (entry.kind === PushTargetKind.Device) {
          goneDevices.add(entry.deviceId);
        } else if (entry.kind === PushTargetKind.ActivityStart) {
          goneStartTokens.add(entry.deviceId);
        } else if (entry.activityRowId) {
          goneActivities.add(entry.activityRowId);
        }
      } else if (entry.request.type === 'live-activity-update') {
        // never retried: a later attempt could show an older step, and the next update replaces it anyway
        rejected++;
      } else {
        again.push(entry);
        retryAfterSec = Math.max(retryAfterSec, result.retryAfterSec ?? 0);
      }
    }
    await this.devices.deleteByIds([...goneDevices]);
    await this.devices.clearPushToStartTokens([...goneStartTokens].filter((id) => !goneDevices.has(id)));
    await this.devices.deleteActivitiesByIds([...goneActivities]);
    await this.devices.markDelivered([...delivered].filter((id) => !goneDevices.has(id)));

    const attempt = (notice.retry?.attempt ?? 1) + 1;
    const retrying = again.length > 0 && attempt <= PUSH_GATEWAY_MAX_ATTEMPTS;
    if (retrying) {
      // only the targets the gateway asked to retry; a fresh job id, as the first one may still be kept
      await this.jobRepository.queue({
        name: JobName.PushDeliver,
        data: {
          notice: {
            ...notice,
            dedupeKey: undefined,
            delayMs: retryDelayMs(attempt, retryAfterSec),
            retry: {
              targets: again.map((entry) => deliveryKeyOf(entry)),
              attempt,
              ...(collapseIdOfNotice(notice) && { collapseId: collapseIdOfNotice(notice) }),
            },
          },
        },
      });
    }
    if (rejected > 0 || goneDevices.size > 0 || again.length > 0) {
      this.logger.warn(
        `Push ${notice.type}: ${delivered.size} device(s) reached, ${rejected} target(s) refused, ${goneDevices.size} invalid token(s) removed, ${again.length} to retry${retrying || again.length === 0 ? '' : ' (given up)'}`,
      );
    }
    return JobStatus.Success;
  }

  /** The nightly wake-up of devices whose phone backup has not succeeded for two days. */
  @OnJob({ name: JobName.PushBackupStaleCheck, queue: QueueName.BackgroundTask })
  async handleBackupStaleCheck(): Promise<JobStatus> {
    if (!(await this.isLinked())) {
      return JobStatus.Skipped;
    }
    const now = Date.now();
    const targets = await this.devices.getStaleBackupWakeTargets(
      new Date(now - PUSH_BACKUP_STALE_AFTER_MS),
      new Date(now - PUSH_BACKUP_WAKE_INTERVAL_MS),
    );
    for (const target of targets) {
      const days = Math.max(1, Math.floor((now - new Date(target.lastSuccessfulBackupAt).getTime()) / 86_400_000));
      await this.queue({
        type: PushEventType.BackupStale,
        userIds: [target.userId],
        title: 'Backup is out of date',
        body: `${target.displayName} has not backed up for ${days} day${days === 1 ? '' : 's'}`,
        data: {
          backupDeviceKey: target.backupDeviceKey,
          pendingCount: target.pendingCount,
          lastSuccessfulBackupAt: new Date(target.lastSuccessfulBackupAt).toISOString(),
        },
        backupDeviceKey: target.backupDeviceKey,
        background: true,
      });
    }
    await this.devices.markStaleWake(targets.map(({ deviceId }) => deviceId));
    return JobStatus.Success;
  }

  /* ------------------------------------------------------------------ */
  /* Helpers                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * The gateway requests for one device: one per token the notice goes to. Alerts and wake-ups carry
   * the payload sealed to the device key; a Live Activity carries only its fixed, non-personal state.
   */
  private plan(
    device: PushDeviceWithActivities,
    notice: PushNotice,
    safeAssetIds: ReadonlySet<string>,
    sentAt: string,
    locale: string,
  ): PlannedMessage[] {
    const platform =
      device.platform === PushPlatform.Android
        ? ('fcm' as const)
        : device.apnsEnvironment === 'sandbox'
          ? ('apns-sandbox' as const)
          : ('apns' as const);
    const collapseId = collapseIdOfNotice(notice);
    const planned: PlannedMessage[] = [];
    const progress = notice.activation;
    if (progress && device.platform === PushPlatform.Ios) {
      const live = {
        platform,
        priority: 'high' as const,
        ttlSec: pushTtlSec(notice, true),
        liveActivity: { state: liveActivityStateOf(progress), staleAfterSec: 3600 },
      };
      const activities = device.activities.filter(({ kind }) => kind === CLOUD_BACKUP_ACTIVITY_KIND);
      for (const activity of activities) {
        planned.push({
          deviceId: device.id,
          kind: PushTargetKind.ActivityUpdate,
          activityRowId: activity.id,
          request: {
            ...live,
            token: activity.token,
            type: progress.state === 'active' ? 'live-activity-update' : 'live-activity-end',
          },
        });
      }
      if (activities.length === 0 && device.pushToStartToken && progress.state === 'active') {
        planned.push({
          deviceId: device.id,
          kind: PushTargetKind.ActivityStart,
          request: {
            ...live,
            token: device.pushToStartToken,
            type: 'live-activity-start',
            liveActivity: { ...live.liveActivity, attributesType: CLOUD_BACKUP_ATTRIBUTES_TYPE },
          },
        });
      }
    }
    // While the chain runs, iOS follows it in the Live Activity alone; Android shows it as a progress
    // notification, and the end of the chain (complete or failed) is an alert everywhere
    if (!progress || device.platform !== PushPlatform.Ios || progress.state !== 'active') {
      const id = randomUUID();
      const payload = buildPushPayload(notice, { id, sentAt, safeAssetIds, locale });
      try {
        planned.push({
          deviceId: device.id,
          kind: PushTargetKind.Device,
          request: {
            platform,
            token: device.pushToken,
            type: notice.background ? 'background' : 'alert',
            priority: notice.background ? 'normal' : 'high',
            ttlSec: pushTtlSec(notice, false),
            payload: sealPushEnvelope(device.publicKey, Buffer.from(JSON.stringify(payload), 'utf8')),
            ...(collapseId && { collapseId }),
          },
        });
      } catch (error) {
        this.logger.warn(`Push device ${device.id} has an unusable key and was skipped: ${errorMessage(error)}`);
      }
    }
    return planned;
  }

  private async queue(notice: PushNotice) {
    if (!(await this.isLinked())) {
      return;
    }
    await this.jobRepository.queue({ name: JobName.PushDeliver, data: { notice } });
  }

  /** The recipient's hidden people, pets and tags (the Locked rules), as every ordinary read applies them. */
  private async hiddenContentOf(userId: string): Promise<HiddenContentFilter | undefined> {
    const { suppression } = getPreferences(await this.userRepository.getMetadata(userId)).privacy;
    const filter = { userId, includeNsfw: false, ...suppression };
    return hasHiddenContentFilter(filter) ? filter : undefined;
  }

  private async albumInfo(id: string) {
    const album = await this.albumRepository.getById(id, { withAssets: false });
    return album ? { albumName: album.albumName, albumThumbnailAssetId: album.albumThumbnailAssetId } : null;
  }

  private gatewayDeps() {
    return {
      configRepository: this.configRepository,
      databaseRepository: this.databaseRepository,
      systemMetadataRepository: this.systemMetadataRepository,
      instanceIdentityRepository: this.instanceIdentityRepository,
      frameleafCloudRepository: this.frameleafCloudRepository,
    };
  }

  /** Whether push can be delivered now, without contacting anything. */
  private async availability(): Promise<{
    reason: PushUnavailableReason | null;
    cloudUrl?: string;
    instanceId?: string;
  }> {
    const { cloudUrl, link, linked } = await readCloudLink(this.gatewayDeps());
    if (!cloudUrl) {
      return { reason: PushUnavailableReason.NotConfigured };
    }
    if (!linked || !link?.instanceId) {
      return { reason: PushUnavailableReason.NotLinked };
    }
    if (link.heartbeat?.cloneSuspected) {
      return { reason: PushUnavailableReason.CloneSuspected };
    }
    return { reason: null, cloudUrl, instanceId: link.instanceId };
  }

  private async isLinked() {
    return (await this.availability()).reason === null;
  }

  private async gatewayTarget(instanceId: string, cloudUrl: string) {
    const document = await this.frameleafCloudRepository.discovery(cloudUrl);
    await loadInstanceIdentity(this.gatewayDeps());
    return this.gateway.target(
      document,
      instanceId,
      this.instanceIdentityRepository.currentSigner(),
      this.configRepository.getEnv().frameleafCloud.pushUrl,
    );
  }

  private requireUser(auth: AuthDto) {
    if (auth.sharedLink) {
      throw new ForbiddenException('Push notifications need a signed-in account');
    }
  }

  private requireSession(auth: AuthDto): string {
    this.requireUser(auth);
    if (!auth.session) {
      throw new BadRequestException('Push registration needs a signed-in device session, not an API key');
    }
    return auth.session.id;
  }

  /** A token the push gateway could never deliver to is refused at once, never stored. */
  private requireTokens(...tokens: Array<string | null | undefined>) {
    if (tokens.some((token) => typeof token === 'string' && !isGatewayToken(token))) {
      throw new BadRequestException(
        'A push token is an APNs, ActivityKit or FCM token (32 or more letters, digits, -, _ or :)',
      );
    }
  }

  private parseKey(value: string): string {
    try {
      return parsePushPublicKey(value);
    } catch (error) {
      throw new BadRequestException(errorMessage(error));
    }
  }
}
