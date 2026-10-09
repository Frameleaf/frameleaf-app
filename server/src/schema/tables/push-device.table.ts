import { Column, ForeignKeyColumn, PrimaryGeneratedColumn, Table, Unique } from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import { PushPlatform } from 'src/enum.js';
import { SessionTable } from 'src/schema/tables/session.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

/**
 * FL-228: a device that receives push notifications. Mirrors migrations 2100000000727-PushDevices and 2100000000728-PushDeviceApnsEnvironment.
 *
 * One registration per signed-in device session: logging out, revoking the session or removing the
 * account deletes the row (and its Live Activity tokens) through the foreign keys, so no token outlives
 * the session that registered it. The tokens are delivery addresses for the Frameleaf push gateway and
 * are never returned by the API or written to a log.
 */
@Table('push_device')
@Unique({ columns: ['sessionId'] })
export class PushDeviceTable {
  @PrimaryGeneratedColumn() id!: Generated<string>;
  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' }) userId!: string;
  @ForeignKeyColumn(() => SessionTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' }) sessionId!: string;
  @Column({ type: 'text' }) platform!: PushPlatform;
  /** The APNs device token or FCM registration token. */
  @Column({ type: 'text' }) pushToken!: string;
  /** FL-302, iOS: `sandbox` for a development build's tokens (APNs sandbox); null is production. */
  @Column({ type: 'text', nullable: true }) apnsEnvironment!: 'production' | 'sandbox' | null;
  /** iOS: the ActivityKit push-to-start token. */
  @Column({ type: 'text', nullable: true }) pushToStartToken!: string | null;
  /** The device's X25519 public key (raw 32 bytes, base64url); every payload is encrypted to it. */
  @Column({ type: 'text' }) publicKey!: string;
  /** The phone backup device this push device is (`backup_device.deviceKey`), for stale-backup wake-ups. */
  @Column({ type: 'uuid', nullable: true }) backupDeviceKey!: string | null;
  /** Event types the user turned off on this device; everything else is delivered. */
  @Column({ type: 'text', array: true, default: [] }) disabledEvents!: Generated<string[]>;
  @Column({ type: 'timestamp with time zone', default: () => 'now()' }) createdAt!: Generated<Timestamp>;
  @Column({ type: 'timestamp with time zone', default: () => 'now()' }) updatedAt!: Generated<Timestamp>;
  @Column({ type: 'timestamp with time zone', nullable: true }) lastDeliveredAt!: Timestamp | null;
  /** When the last stale-backup wake-up went to this device, so it is sent at most once a day. */
  @Column({ type: 'timestamp with time zone', nullable: true }) lastStaleWakeAt!: Timestamp | null;
}

/** FL-228: an iOS Live Activity's ActivityKit update token, per activity. */
@Table('push_device_activity')
@Unique({ columns: ['deviceId', 'activityId'] })
export class PushDeviceActivityTable {
  @PrimaryGeneratedColumn() id!: Generated<string>;
  @ForeignKeyColumn(() => PushDeviceTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' }) deviceId!: string;
  /** The activity's id on the device (ActivityKit `Activity.id`). */
  @Column({ type: 'text' }) activityId!: string;
  /** The activity's attributes type; `cloud-backup-activation` today. */
  @Column({ type: 'text' }) kind!: string;
  /** Render operation binding; unbound legacy render activities receive no updates. */
  @Column({ type: 'uuid', nullable: true }) operationId!: string | null;
  @Column({ type: 'text' }) token!: string;
  @Column({ type: 'timestamp with time zone', default: () => 'now()' }) updatedAt!: Generated<Timestamp>;
}
