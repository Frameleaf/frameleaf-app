import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, link, open, readFile, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { coerce, gt } from 'semver';
import type { BuddyManifest } from 'src/services/buddy-backup-capture.service.js';
import type { MaintenanceModeState } from 'src/types.js';
import { serverVersion } from 'src/constants.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { StorageFolder, SystemMetadataKey } from 'src/enum.js';
import { BuddyBackupRepository } from 'src/repositories/buddy-backup.repository.js';
import { CloudBackupKeyRepository } from 'src/repositories/cloud-backup-key.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseBackupService } from 'src/services/database-backup.service.js';
import {
  BuddyRecoveryFiles,
  buddyFileHash,
  buddyInside,
  buddyRecoveryTarget,
  readBuddyRecovery,
} from 'src/utils/buddy-backup-recovery.js';
import { createBuddyDirectory, flushBuddyDirectory, writeBuddyFile } from 'src/utils/buddy-backup-vault.js';
import { keyFingerprint, parseBackupKey } from 'src/utils/cloud-backup.js';
import { isValidDatabaseBackupName } from 'src/utils/database-backups.js';

/** Available in maintenance without booting application jobs, accounts or the Cloud client. */
@Injectable()
export class BuddyBackupRecoveryService {
  constructor(
    private repository: BuddyBackupRepository,
    private config: ConfigRepository,
    private backups: DatabaseBackupService,
    private keys: CloudBackupKeyRepository,
  ) {}

  private async restoreKeys(manifest: BuddyManifest, assert: () => Promise<void>) {
    for (const key of manifest.cloudBackupKeys ?? []) {
      if (
        typeof key.content !== 'string' ||
        key.content.length > 16_384 ||
        keyFingerprint(parseBackupKey(key.content)) !== key.fingerprint
      )
        throw new Error('Cloud Backup recovery key failed verification');
      await assert();
      await this.keys.write(dirname(this.repository.root()), key.fingerprint, key.content);
      await flushBuddyDirectory(dirname(this.repository.root()));
      await assert();
    }
  }

  private async plan(id: string) {
    const plan = await readBuddyRecovery(this.repository.root(), id);
    const version = coerce(plan.manifest.frameleafVersion);
    if (!version || gt(version, serverVersion))
      throw new Error('Update Frameleaf to the backup version before recovery');
    // Preserve path identity in the database. Reattach original external mounts before full recovery.
    if (plan.manifest.storageRoot !== StorageCore.getMediaLocation())
      throw new Error('Configure the original media mount path before server recovery');
    const settings = (await this.repository.state()).settings;
    const identityRoots = [resolve(dirname(this.repository.root())), await realpath(dirname(this.repository.root()))];
    if (
      plan.files.some(
        (file) =>
          identityRoots.some((root) => buddyInside(root, file.path)) ||
          (settings && buddyInside(settings.directory, file.path)),
      )
    )
      throw new Error('Recovery paths overlap the replacement server identity or hosted Buddy vault');
    // Check every ancestor before prepare/settings can write anything; aliases cannot bypass exclusions.
    for (const file of plan.files)
      await buddyRecoveryTarget(
        file.path,
        plan.scope === 'server' ? plan.manifest.storageRoots : [],
        settings?.configurationFiles ?? [],
      );
    return plan;
  }

  async prepare(id: string) {
    const plan = await this.plan(id);
    if (plan.scope !== 'server' || !plan.manifest.library.database)
      throw new Error('A staged full server recovery is required');
    const source = join(this.repository.root(), 'recovery', id, 'database.sql.gz');
    const evidence = await buddyFileHash(source);
    const dump = plan.manifest.library.database;
    if (evidence.sha256 !== dump.sha256 || evidence.size !== dump.size)
      throw new Error('Recovery database checksum failed');
    await this.backups.verifyDatabaseBackup(source);
    const filename = `buddy-restore-${id}-${basename(dump.key)}`;
    if (!isValidDatabaseBackupName(filename)) throw new Error('Unsupported recovery database format');
    const destination = join(StorageCore.getBaseFolder(StorageFolder.Backups), filename);
    await createBuddyDirectory(StorageCore.getBaseFolder(StorageFolder.Backups));
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await copyFile(source, temporary, constants.COPYFILE_EXCL);
      const handle = await open(temporary, 'r+');
      try {
        await handle.chmod(0o600);
        await handle.sync();
      } finally {
        await handle.close();
      }
      const copied = await buddyFileHash(temporary);
      if (copied.sha256 !== dump.sha256 || copied.size !== dump.size)
        throw new Error('Recovery database copy failed verification');
      try {
        await link(temporary, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const final = await buddyFileHash(destination);
      if (final.sha256 !== dump.sha256 || final.size !== dump.size)
        throw new Error('Recovery database destination differs');
      await flushBuddyDirectory(StorageCore.getBaseFolder(StorageFolder.Backups));
    } finally {
      await rm(temporary, { force: true });
    }
    // Keep replacement identity/link across database replacement; never resurrect the source identity.
    const keys = [
      SystemMetadataKey.FrameleafInstance,
      SystemMetadataKey.FrameleafServerId,
      SystemMetadataKey.FrameleafCloudLink,
      SystemMetadataKey.FrameleafServiceDiscovery,
      SystemMetadataKey.FrameleafLicense,
      SystemMetadataKey.FrameleafPricing,
      SystemMetadataKey.FrameleafBoot,
      SystemMetadataKey.FrameleafRemoteAccess,
      SystemMetadataKey.FrameleafMlSuspension,
    ];
    const metadata = await this.repository.db
      .selectFrom('system_metadata')
      .select(['key', 'value'])
      .where('key', 'in', keys)
      .execute();
    await writeBuddyFile(
      join(this.repository.root(), 'recovery', id, 'replacement.json'),
      JSON.stringify({ keys, metadata }),
    );
    return filename;
  }

  /** Called only after every ordinary worker has stopped. Failures leave maintenance active. */
  async restore(
    id: string,
    restoreDatabase: () => Promise<void>,
    maintenance: MaintenanceModeState,
    assert: () => Promise<void>,
  ) {
    const plan = await this.plan(id);
    const settings = (await this.repository.state()).settings;
    if (!settings) throw new Error('Set up the replacement server recovery storage first');
    if (
      plan.scope !== 'server' ||
      !plan.manifest.library.database ||
      !maintenance.isMaintenanceMode ||
      maintenance.action?.restoreBackupFilename !==
        `buddy-restore-${id}-${basename(plan.manifest.library.database.key)}`
    )
      throw new Error('The recovery database must match this staged snapshot');
    const roots = plan.manifest.storageRoots;
    const files = new BuddyRecoveryFiles(this.repository.root(), id, assert);
    const before = await files.load();
    if (before === 'complete') {
      await files.verify(plan, roots, settings.configurationFiles);
      return this.restoreKeys(plan.manifest, assert);
    }
    await files.publish(plan, roots, settings.configurationFiles);
    if (before !== 'database-ready') {
      // Durable intent keeps a crash from reopening a database with half-published files.
      await writeBuddyFile(join(this.repository.root(), 'recovery', id, 'database-pending'), '1', false, assert);
      try {
        await restoreDatabase();
      } catch (error) {
        await files.rollback(roots, settings.configurationFiles);
        throw error;
      }
      await files.state('database-ready');
    }
    const replacement = JSON.parse(
      await readFile(join(this.repository.root(), 'recovery', id, 'replacement.json'), 'utf8'),
    ) as {
      keys: SystemMetadataKey[];
      metadata: Array<{ key: SystemMetadataKey; value: unknown }>;
    };
    await assert();
    await this.repository.db.transaction().execute(async (trx) => {
      await assert();
      await trx.deleteFrom('session').execute();
      // Restored unfinished jobs describe work from the old server and cannot safely be resumed.
      await sql`DELETE FROM public.media_operation`.execute(trx);
      await sql`DELETE FROM immich_fork.buddy_backup_reference`.execute(trx);
      await trx.deleteFrom('system_metadata').where('key', 'in', replacement.keys).execute();
      for (const row of replacement.metadata)
        await sql`INSERT INTO system_metadata (key, value) VALUES (${row.key}, ${JSON.stringify(row.value)}::text::jsonb)
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`.execute(trx);
      await sql`INSERT INTO system_metadata (key, value) VALUES (${SystemMetadataKey.MaintenanceMode}, ${JSON.stringify(maintenance)}::text::jsonb)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`.execute(trx);
    });
    const { bull } = this.config.getEnv();
    for (const { name } of bull.queues) {
      await assert();
      if (!name) throw new Error('Recovery queue name is unavailable');
      const queue = new Queue(name, bull.config);
      try {
        await queue.obliterate({ force: true });
      } finally {
        await queue.close();
      }
    }
    await files.verify(plan, roots, settings.configurationFiles);
    await this.restoreKeys(plan.manifest, assert);
    await assert();
    await this.repository.update((state) => ({ ...state, run: null, nextScheduledAt: null }));
    await files.state('complete');
  }

  async settings(id: string, assert: () => Promise<void>) {
    const plan = await this.plan(id);
    if (plan.scope !== 'settings') throw new Error('A staged settings recovery is required');
    const settings = (await this.repository.state()).settings;
    if (!settings) throw new Error('Configure recovery storage first');
    const files = new BuddyRecoveryFiles(this.repository.root(), id, assert);
    const directory = join(this.repository.root(), 'recovery', id);
    const before = await files.load();
    if (before === 'complete') {
      await files.verify(plan, [], settings.configurationFiles);
      return this.restoreKeys(plan.manifest, assert);
    }
    if (before === 'database-ready') {
      await files.verify(plan, [], settings.configurationFiles);
      await this.restoreKeys(plan.manifest, assert);
      return files.state('complete');
    }
    const preimage = join(directory, 'settings-rollback.json');
    const digest = createHash('sha256').update(JSON.stringify(plan)).digest('hex');
    type Previous = { id: string; digest: string; system: unknown; users: unknown[]; fork: unknown[] };
    let previous: Previous;
    try {
      previous = JSON.parse(await readFile(preimage, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await assert();
      const system = await this.repository.db
        .selectFrom('system_metadata')
        .select('value')
        .where('key', '=', SystemMetadataKey.SystemConfig)
        .executeTakeFirst();
      const users = await this.repository.db.selectFrom('user_metadata').selectAll().execute();
      const fork = await sql`SELECT key, value FROM immich_fork.config`.execute(this.repository.db);
      previous = { id, digest, system: system?.value ?? {}, users, fork: fork.rows };
      // Persist the original preimage once, before publishing or committing anything.
      await writeBuddyFile(preimage, JSON.stringify(previous), true, assert);
    }
    if (previous.id !== id || previous.digest !== digest)
      throw new Error('Settings rollback does not match this recovery');
    await files.publish(plan, [], settings.configurationFiles);
    try {
      await assert();
      await this.repository.db.transaction().execute(async (trx) => {
        const old = (previous.system ?? {}) as Record<string, unknown>;
        const restored = plan.manifest.settings.system as Record<string, unknown>;
        const merged = plan.mode === 'replace' ? restored : { ...restored, ...old };
        await sql`INSERT INTO system_metadata (key, value) VALUES (${SystemMetadataKey.SystemConfig}, ${JSON.stringify(merged)}::text::jsonb)
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`.execute(trx);
        for (const row of plan.manifest.settings.fork) {
          await sql`INSERT INTO immich_fork.config (key, value) VALUES (${row.key}, ${JSON.stringify(row.value)}::text::jsonb)
            ON CONFLICT (key) DO UPDATE SET value = CASE WHEN ${plan.mode === 'replace'} THEN EXCLUDED.value ELSE immich_fork.config.value END`.execute(
            trx,
          );
        }
        for (const row of plan.manifest.settings.users) {
          if (!(await trx.selectFrom('user').select('id').where('id', '=', row.userId).executeTakeFirst())) continue;
          await sql`INSERT INTO user_metadata ("userId", key, value) VALUES (${row.userId}::uuid, ${row.key}, ${JSON.stringify(row.value)}::text::jsonb)
            ON CONFLICT ("userId", key) DO UPDATE SET value = CASE WHEN ${plan.mode === 'replace'} THEN EXCLUDED.value ELSE user_metadata.value END`.execute(
            trx,
          );
        }
      });
    } catch (error) {
      await files.rollback([], settings.configurationFiles);
      throw error;
    }
    await files.state('database-ready');
    await files.verify(plan, [], settings.configurationFiles);
    await this.restoreKeys(plan.manifest, assert);
    await files.state('complete');
  }
}
