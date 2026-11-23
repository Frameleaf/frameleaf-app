import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { type Transaction, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import z from 'zod';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { DesktopWorkerTables } from 'src/repositories/desktop-worker.repository.js';
import type { DB } from 'src/schema/index.js';
import { SystemMetadataKey } from 'src/enum.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import {
  type DesktopAssistancePolicyRegistry,
  desktopAssistancePolicySchema,
  desktopRevisionCurrent,
} from 'src/utils/desktop-assistance-policy.js';
import { lockEffectiveConfig } from 'src/utils/effective-config-lock.js';

export type { DesktopAssistancePolicyRegistry } from 'src/utils/desktop-assistance-policy.js';

@Injectable()
export class DesktopAssistancePolicyService {
  constructor(private metadata: SystemMetadataRepository) {}

  readMemberApproval(auth: AuthDto, ownerId: string) {
    return this.withAdministrator(auth, ownerId, async (metadata) => ({
      enabled: (await this.registry(metadata)).accounts[ownerId]?.memberApproved === true,
    }));
  }

  setMemberApproval(auth: AuthDto, ownerId: string, enabled: boolean) {
    return this.withAdministrator(auth, ownerId, async (metadata, tx) => {
      const policy = await this.registry(metadata);
      const existing = policy.accounts[ownerId];
      if (enabled ? existing?.memberApproved === true : !existing) return { enabled };
      if (enabled) {
        if (!existing && Object.keys(policy.accounts).length >= 256)
          throw new ConflictException('desktop_pool_policy_capacity');
        policy.accounts[ownerId] = { revisionId: randomUUID(), memberApproved: true };
      } else {
        delete policy.accounts[ownerId];
      }
      await metadata.set(SystemMetadataKey.FrameleafDesktopAssistance, policy);
      await tx
        .updateTable('desktop_device')
        .set({ state: 'awaiting-approval', authorizationEpoch: sql`"authorizationEpoch" + 1` })
        .where('userId', '=', ownerId)
        .where('mode', '=', 'client-worker')
        .where('revokedAt', 'is', null)
        .execute();
      await tx
        .withTables<DesktopWorkerTables>()
        .deleteFrom('desktop_worker_session')
        .where('deviceId', 'in', tx.selectFrom('desktop_device').select('id').where('userId', '=', ownerId))
        .execute();
      return { enabled };
    });
  }

  /**
   * FL-1484: whether a computer works on everyone's photos at home, not only those of the account signed in on
   * it. Any change gives the list a new revision and gives the computer a new authorization epoch, ending its
   * sessions, so no work it held under the old list can be read, finished or revived by adding it again.
   * A revoked computer can still be removed; computers that are gone or revoked leave the list on any change.
   */
  setHousehold(auth: AuthDto, deviceId: string, enabled: boolean) {
    z.uuid().parse(deviceId);
    return this.asAdministrator(auth, async (metadata, tx) => {
      const device = await tx
        .selectFrom('desktop_device')
        .select(['id', 'revokedAt'])
        .where('id', '=', deviceId)
        .where('mode', '=', 'client-worker')
        .forUpdate()
        .executeTakeFirst();
      const policy = await this.registry(metadata);
      const listed = new Set(policy.household?.devices);
      // a computer is added only while it is live; one that is gone or revoked can still be taken off the list
      const removable = !enabled && listed.has(deviceId);
      if ((!device || (enabled && device.revokedAt)) && !removable) throw new NotFoundException('Computer not found');
      if (listed.has(deviceId) === enabled) return { enabled };
      const live = new Set(
        listed.size === 0
          ? []
          : (
              await tx
                .selectFrom('desktop_device')
                .select('id')
                .where('id', 'in', [...listed])
                .where('mode', '=', 'client-worker')
                .where('revokedAt', 'is', null)
                .execute()
            ).map(({ id }) => id),
      );
      const devices = new Set([...listed].filter((id) => live.has(id) && id !== deviceId));
      if (enabled) {
        if (devices.size >= 64) throw new ConflictException('desktop_household_capacity');
        devices.add(deviceId);
      }
      // FL-1758: a computer that leaves the household loses its video permission with it
      const transcodeDevices = policy.household?.transcodeDevices?.filter((id) => devices.has(id));
      policy.household = {
        revisionId: randomUUID(),
        devices: [...devices],
        ...(transcodeDevices?.length ? { transcodeDevices } : {}),
      };
      await metadata.set(SystemMetadataKey.FrameleafDesktopAssistance, policy);
      if (device) {
        await tx
          .updateTable('desktop_device')
          .set({ authorizationEpoch: sql`"authorizationEpoch" + 1` })
          .where('id', '=', deviceId)
          .execute();
        await tx
          .withTables<DesktopWorkerTables>()
          .deleteFrom('desktop_worker_session')
          .where('deviceId', '=', deviceId)
          .execute();
      }
      return { enabled };
    });
  }

  /**
   * FL-1761: whether a computer makes playback copies, and whether of other people's videos too. Every claim,
   * heartbeat and upload reads these lists live, so a change takes effect at the next one: the computer stays signed
   * in and the household revision is kept, because its AI work is not affected.
   */
  async setTranscode(auth: AuthDto, deviceId: string, { enabled, everyone }: { enabled: boolean; everyone: boolean }) {
    z.uuid().parse(deviceId);
    if (everyone && !enabled) throw new BadRequestException('desktop_transcode_everyone_needs_enabled');
    return this.asAdministrator(auth, async (metadata, tx) => {
      const device = await tx
        .selectFrom('desktop_device')
        .select(['id', 'revokedAt'])
        .where('id', '=', deviceId)
        .where('mode', '=', 'client-worker')
        .forUpdate()
        .executeTakeFirst();
      const policy = await this.registry(metadata);
      const on = new Set(policy.transcodeEnabledDevices);
      const all = new Set(policy.household?.transcodeDevices);
      // as with the household list, a computer that is gone or revoked can still be taken off
      const removable = !enabled && (on.has(deviceId) || all.has(deviceId));
      if ((!device || (enabled && device.revokedAt)) && !removable) throw new NotFoundException('Computer not found');
      if (everyone && !policy.household?.devices.includes(deviceId)) {
        throw new ConflictException('desktop_transcode_household_required');
      }
      if (on.has(deviceId) === enabled && all.has(deviceId) === everyone) return { enabled, everyone };

      const known = [...new Set([...on, ...all])];
      const live = new Set(
        known.length === 0
          ? []
          : (
              await tx
                .selectFrom('desktop_device')
                .select('id')
                .where('id', 'in', known)
                .where('mode', '=', 'client-worker')
                .where('revokedAt', 'is', null)
                .execute()
            ).map(({ id }) => id),
      );
      const nextOn = new Set([...on].filter((id) => live.has(id) && id !== deviceId));
      if (enabled) {
        if (nextOn.size >= 64) throw new ConflictException('desktop_transcode_capacity');
        nextOn.add(deviceId);
      }
      const nextAll = [...all].filter((id) => id !== deviceId && nextOn.has(id));
      if (everyone) nextAll.push(deviceId);

      if (nextOn.size > 0) policy.transcodeEnabledDevices = [...nextOn];
      else delete policy.transcodeEnabledDevices;
      if (policy.household) {
        if (nextAll.length > 0) policy.household.transcodeDevices = nextAll;
        else delete policy.household.transcodeDevices;
      }
      await metadata.set(SystemMetadataKey.FrameleafDesktopAssistance, policy);
      return { enabled, everyone };
    });
  }

  private withAdministrator<T>(
    auth: AuthDto,
    ownerId: string,
    run: (metadata: SystemMetadataRepository, tx: Transaction<DB>) => Promise<T>,
  ) {
    z.uuid().parse(ownerId);
    return this.asAdministrator(auth, async (metadata, tx) => {
      const target = await tx
        .selectFrom('user')
        .select('isAdmin')
        .where('id', '=', ownerId)
        .where('deletedAt', 'is', null)
        .forShare()
        .executeTakeFirst();
      if (!target) throw new NotFoundException('User not found');
      if (target.isAdmin) throw new ConflictException('desktop_member_account_required');
      return run(metadata, tx);
    });
  }

  /** An administrator signed in on a photo session, checked again inside the settings transaction. */
  private async asAdministrator<T>(
    auth: AuthDto,
    run: (metadata: SystemMetadataRepository, tx: Transaction<DB>) => Promise<T>,
  ) {
    if (!auth.session || auth.apiKey || auth.sharedLink || auth.system || !auth.user.isAdmin)
      throw new ForbiddenException('desktop_administrator_photo_session_required');
    return this.metadata.withConfigTransaction(async (metadata, tx) => {
      const actor = await tx
        .selectFrom('user as actor')
        .innerJoin('session as photo', 'photo.userId', 'actor.id')
        .select('actor.id')
        .where('actor.id', '=', auth.user.id)
        .where('actor.isAdmin', '=', true)
        .where('actor.deletedAt', 'is', null)
        .where('photo.id', '=', auth.session!.id)
        .where((eb) =>
          eb.or([eb('photo.expiresAt', 'is', null), eb('photo.expiresAt', '>', sql<Date>`clock_timestamp()`)]),
        )
        .forShare(['actor', 'photo'])
        .executeTakeFirst();
      if (!actor) throw new ForbiddenException('desktop_administrator_photo_session_required');
      return run(metadata, tx);
    });
  }

  /** Consent outlives an individual helper's pause, logout or revocation. */
  async enable(ownerId: string) {
    z.uuid().parse(ownerId);
    return this.metadata.withConfigTransaction(async (metadata) => {
      const policy = await this.registry(metadata);
      if (policy.accounts[ownerId]) return policy.accounts[ownerId];

      if (Object.keys(policy.accounts).length >= 256) throw new ConflictException('desktop_pool_policy_capacity');
      const account = { revisionId: randomUUID() };
      policy.accounts[ownerId] = account;
      await metadata.set(SystemMetadataKey.FrameleafDesktopAssistance, policy);
      return account;
    });
  }

  async read(ownerId: string) {
    z.uuid().parse(ownerId);
    return (await this.registry(this.metadata)).accounts[ownerId];
  }

  snapshot() {
    return this.registry(this.metadata);
  }

  async assertCurrent(ownerId: string, revisionId: string, tx?: Transaction<DB>) {
    if (tx) await lockEffectiveConfig(tx, 'read');
    const policy = await this.registry(tx ? new SystemMetadataRepository(tx) : this.metadata);
    if (!desktopRevisionCurrent(policy, ownerId, revisionId))
      throw new ConflictException('desktop_pool_policy_changed');
  }

  private async registry(metadata: SystemMetadataRepository): Promise<DesktopAssistancePolicyRegistry> {
    const value = await metadata.get(SystemMetadataKey.FrameleafDesktopAssistance);
    const result = desktopAssistancePolicySchema.safeParse(value ?? { version: 1, accounts: {} });
    if (!result.success) throw new ConflictException('desktop_pool_policy_invalid');
    return result.data;
  }
}
