import { BadRequestException, Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { Selectable } from 'kysely';
import type { DB } from 'src/schema/index.js';
import type { PushDeviceActivityTable, PushDeviceTable } from 'src/schema/tables/push-device.table.js';
import type { HiddenContentFilter } from 'src/utils/hidden-content.js';
import { AssetVisibility, MediaOperationKind, PushPlatform } from 'src/enum.js';
import { anyUuid, withHiddenContentFilter } from 'src/utils/database.js';
import { isNotLocked } from 'src/utils/locked.js';

export type PushDevice = Selectable<PushDeviceTable>;
export type PushDeviceActivity = Selectable<PushDeviceActivityTable>;
export type PushDeviceWithActivities = PushDevice & {
  activities: PushDeviceActivity[];
};
export type PushDeviceRegistration = {
  userId: string;
  sessionId: string;
  platform: PushPlatform;
  pushToken: string;
  pushToStartToken: string | null;
  apnsEnvironment: 'production' | 'sandbox' | null;
  publicKey: string;
  backupDeviceKey: string | null;
  disabledEvents: string[];
};
export type PushDeviceChanges = Partial<
  Pick<
    PushDeviceRegistration,
    'pushToken' | 'pushToStartToken' | 'apnsEnvironment' | 'publicKey' | 'backupDeviceKey' | 'disabledEvents'
  >
>;
export type StaleBackupWakeTarget = {
  deviceId: string;
  userId: string;
  backupDeviceKey: string;
  displayName: string;
  pendingCount: number;
  lastSuccessfulBackupAt: Date;
};
/**
 * FL-228: the push device registry (`push_device`, `push_device_activity`). Tokens are delivery
 * addresses for the Frameleaf push gateway: they are read only to deliver, and never logged.
 */
@Injectable()
export class PushDeviceRepository {
  constructor(
    @InjectKysely()
    private db: Kysely<DB>,
  ) {}
  /**
   * Register the device of `sessionId`, or update its registration (a rotated push token, a new key).
   * A push token belongs to one installation, so a registration elsewhere holding the same token (the
   * app signed in again under a new session) is removed first.
   */
  upsert(registration: PushDeviceRegistration): Promise<PushDevice> {
    return this.db.transaction().execute(async (tx) => {
      await tx
        .deleteFrom('push_device')
        .where('platform', '=', registration.platform)
        .where('pushToken', '=', registration.pushToken)
        .where('sessionId', '!=', registration.sessionId)
        .execute();
      return tx
        .insertInto('push_device')
        .values(registration)
        .onConflict((oc) =>
          oc.column('sessionId').doUpdateSet({
            userId: registration.userId,
            platform: registration.platform,
            pushToken: registration.pushToken,
            pushToStartToken: registration.pushToStartToken,
            apnsEnvironment: registration.apnsEnvironment,
            publicKey: registration.publicKey,
            backupDeviceKey: registration.backupDeviceKey,
            disabledEvents: registration.disabledEvents,
            updatedAt: sql`now()`,
          }),
        )
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }
  /** Change some fields of the registration of `sessionId`; undefined when it has none. */
  update(sessionId: string, changes: PushDeviceChanges): Promise<PushDevice | undefined> {
    return this.db.transaction().execute(async (tx) => {
      if (changes.pushToken !== undefined) {
        const current = await tx
          .selectFrom('push_device')
          .select('platform')
          .where('sessionId', '=', sessionId)
          .executeTakeFirst();
        if (current) {
          await tx
            .deleteFrom('push_device')
            .where('platform', '=', current.platform)
            .where('pushToken', '=', changes.pushToken)
            .where('sessionId', '!=', sessionId)
            .execute();
        }
      }
      return tx
        .updateTable('push_device')
        .set({ ...changes, updatedAt: sql`now()` })
        .where('sessionId', '=', sessionId)
        .returningAll()
        .executeTakeFirst();
    });
  }
  async getBySession(sessionId: string): Promise<PushDeviceWithActivities | undefined> {
    const device = await this.devices().where('push_device.sessionId', '=', sessionId).executeTakeFirst();
    return device ? (await this.withActivities([device]))[0] : undefined;
  }
  async getByUser(userId: string): Promise<PushDeviceWithActivities[]> {
    const devices = await this.devices()
      .where('push_device.userId', '=', userId)
      .orderBy('push_device.createdAt')
      .orderBy('push_device.id')
      .execute();
    return this.withActivities(devices);
  }
  /** Every registration of these users, with Live Activity tokens, for one delivery. */
  async getDeliveryTargets(userIds: string[]): Promise<PushDeviceWithActivities[]> {
    if (userIds.length === 0) {
      return [];
    }
    const devices = await this.devices()
      .where('push_device.userId', '=', anyUuid(userIds))
      .orderBy('push_device.createdAt')
      .orderBy('push_device.id')
      .execute();
    return this.withActivities(devices);
  }
  async deleteBySession(sessionId: string): Promise<boolean> {
    const result = await this.db
      .transaction()
      .execute((tx) => tx.deleteFrom('push_device').where('sessionId', '=', sessionId).executeTakeFirst());
    return Number(result.numDeletedRows) > 0;
  }
  async deleteForUser(userId: string, id: string): Promise<boolean> {
    const result = await this.db
      .transaction()
      .execute((tx) =>
        tx.deleteFrom('push_device').where('id', '=', id).where('userId', '=', userId).executeTakeFirst(),
      );
    return Number(result.numDeletedRows) > 0;
  }
  async deleteAllForUser(userId: string): Promise<number> {
    const result = await this.db
      .transaction()
      .execute((tx) => tx.deleteFrom('push_device').where('userId', '=', userId).executeTakeFirst());
    return Number(result.numDeletedRows);
  }
  /** The gateway said these tokens are gone (APNs 410, FCM UNREGISTERED). */
  async deleteByIds(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    await this.db.transaction().execute((tx) => tx.deleteFrom('push_device').where('id', '=', anyUuid(ids)).execute());
  }
  /** Forget a push-to-start token the gateway reported gone, keeping the registration. */
  async clearPushToStartTokens(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    await this.db
      .transaction()
      .execute((tx) =>
        tx.updateTable('push_device').set({ pushToStartToken: null }).where('id', '=', anyUuid(ids)).execute(),
      );
  }
  setActivity(
    deviceId: string,
    activity: {
      activityId: string;
      kind: string;
      token: string;
      operationId?: string;
    },
  ) {
    return this.db.transaction().execute(async (tx) => {
      if (activity.kind === 'studio-render') {
        const operation =
          activity.operationId &&
          (await tx
            .selectFrom('media_operation')
            .innerJoin('push_device', 'push_device.userId', 'media_operation.ownerId')
            .select('media_operation.id')
            .where('push_device.id', '=', deviceId)
            .where('media_operation.id', '=', activity.operationId)
            .where('media_operation.kind', '=', MediaOperationKind.StudioExport)
            .executeTakeFirst());
        if (!operation) throw new BadRequestException('Studio render operation not found');
      }
      const operationId = activity.kind === 'studio-render' ? activity.operationId : null;
      const registered = await tx
        .insertInto('push_device_activity')
        .values({ deviceId, ...activity, operationId })
        .onConflict((oc) =>
          oc
            .columns(['deviceId', 'activityId'])
            .doUpdateSet({
              kind: activity.kind,
              operationId,
              token: activity.token,
              updatedAt: sql`now()`,
            })
            .where((eb) =>
              eb.or([
                eb('push_device_activity.operationId', 'is', null),
                eb('push_device_activity.operationId', '=', operationId ?? null),
              ]),
            ),
        )
        .returningAll()
        .executeTakeFirst();
      if (!registered) throw new BadRequestException('A render activity cannot change its operation');
      return registered;
    });
  }
  async deleteActivity(deviceId: string, activityId: string): Promise<boolean> {
    const result = await this.db
      .transaction()
      .execute((tx) =>
        tx
          .deleteFrom('push_device_activity')
          .where('deviceId', '=', deviceId)
          .where('activityId', '=', activityId)
          .executeTakeFirst(),
      );
    return Number(result.numDeletedRows) > 0;
  }
  async deleteActivitiesByIds(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    await this.db
      .transaction()
      .execute((tx) => tx.deleteFrom('push_device_activity').where('id', '=', anyUuid(ids)).execute());
  }
  async markDelivered(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    await this.db.transaction().execute((tx) =>
      tx
        .updateTable('push_device')
        .set({ lastDeliveredAt: sql`now()` })
        .where('id', '=', anyUuid(ids))
        .execute(),
    );
  }
  /**
   * FL-228 privacy (FL-137, FL-212/FL-213): which of these items may be named in a push payload or
   * shown as its thumbnail. Locked items (either lock representation), hidden items (the video half of a
   * live photo), items flagged sensitive (`is_nsfw`) and trashed or missing items never are. Nor, for a
   * recipient with hidden people, pets or tags (`hiddenContent`, FL-293), the items those rules hide.
   */
  async getPreviewSafeAssetIds(ids: string[], hiddenContent?: HiddenContentFilter): Promise<Set<string>> {
    if (ids.length === 0) {
      return new Set();
    }
    const rows = await this.db
      .selectFrom('asset')
      .select('asset.id')
      .where('asset.id', '=', anyUuid(ids))
      .where('asset.deletedAt', 'is', null)
      .where('asset.visibility', 'not in', [AssetVisibility.Locked, AssetVisibility.Hidden])
      .where('asset.is_nsfw', '=', false)
      .where(isNotLocked('asset'))
      .$call((qb) => withHiddenContentFilter(qb, { hiddenContent }))
      .execute();
    return new Set(rows.map(({ id }) => id));
  }
  /**
   * Push devices linked to a phone backup device whose last reported success is older than `cutoff`
   * (never-reported devices have nothing to be stale against), not woken since `wakeCutoff`.
   */
  getStaleBackupWakeTargets(cutoff: Date, wakeCutoff: Date): Promise<StaleBackupWakeTarget[]> {
    return this.db
      .selectFrom('push_device')
      .innerJoin('backup_device', (join) =>
        join
          .onRef('backup_device.ownerId', '=', 'push_device.userId')
          .onRef('backup_device.deviceKey', '=', 'push_device.backupDeviceKey'),
      )
      .select([
        'push_device.id as deviceId',
        'push_device.userId',
        'backup_device.deviceKey as backupDeviceKey',
        'backup_device.displayName',
        'backup_device.pendingCount',
      ])
      .select((eb) => eb.ref('backup_device.lastSuccessfulBackupAt').$notNull().as('lastSuccessfulBackupAt'))
      .where('backup_device.deletedAt', 'is', null)
      .where('backup_device.lastSuccessfulBackupAt', '<', cutoff)
      .where((eb) =>
        eb.or([eb('push_device.lastStaleWakeAt', 'is', null), eb('push_device.lastStaleWakeAt', '<', wakeCutoff)]),
      )
      .orderBy('push_device.id')
      .execute() as Promise<StaleBackupWakeTarget[]>;
  }
  async markStaleWake(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    await this.db.transaction().execute((tx) =>
      tx
        .updateTable('push_device')
        .set({ lastStaleWakeAt: sql`now()` })
        .where('id', '=', anyUuid(ids))
        .execute(),
    );
  }
  private devices() {
    return this.db.selectFrom('push_device').selectAll('push_device');
  }
  private async withActivities(devices: PushDevice[]): Promise<PushDeviceWithActivities[]> {
    if (devices.length === 0) {
      return [];
    }
    const activities = await this.db
      .selectFrom('push_device_activity')
      .selectAll()
      .where('deviceId', '=', anyUuid(devices.map(({ id }) => id)))
      .where((eb) =>
        eb.or([
          eb('kind', '!=', 'studio-render'),
          eb.exists(
            eb
              .selectFrom('media_operation')
              .innerJoin('push_device', 'push_device.userId', 'media_operation.ownerId')
              .select('media_operation.id')
              .whereRef('push_device.id', '=', 'push_device_activity.deviceId')
              .whereRef('media_operation.id', '=', 'push_device_activity.operationId')
              .where('media_operation.kind', '=', MediaOperationKind.StudioExport),
          ),
        ]),
      )
      .orderBy('updatedAt')
      .orderBy('id')
      .execute();
    return devices.map((device) => ({
      ...device,
      activities: activities.filter(({ deviceId }) => deviceId === device.id),
    }));
  }
}
