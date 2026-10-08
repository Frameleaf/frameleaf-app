import { Injectable } from '@nestjs/common';
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
import { resetQueueAfterRestore } from 'src/queue/store.js';
import { BuddyBackupRepository } from 'src/repositories/buddy-backup.repository.js';
import { CloudBackupKeyRepository } from 'src/repositories/cloud-backup-key.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { DatabaseBackupService } from 'src/services/database-backup.service.js';
import {
  BuddyRecoveryFiles,
  buddyFileHash,
  buddyInside,
  buddyRecoveryTarget,
  readBuddyRecovery,
} from 'src/utils/buddy-backup-recovery.js';
import { type BuddySettingsSnapshot, readBuddySettingsSnapshot } from 'src/utils/buddy-backup-settings.js';
import { createBuddyDirectory, flushBuddyDirectory, writeBuddyFile } from 'src/utils/buddy-backup-vault.js';
import { finalizeBuddyBootBinding, verifyBuddyRecoveryBootBinding } from 'src/utils/buddy-boot-binding.js';
import {
  admitReplacementMl,
  captureReplacementMl,
  preserveHistoricalMl,
  readReplacementMl,
  verifyCommittedReplacementMl,
} from 'src/utils/buddy-recovery-ml.js';
import { keyFingerprint, parseBackupKey } from 'src/utils/cloud-backup.js';
import { publishFileConfig, recoverEffectiveConfig } from 'src/utils/config.js';
import { isValidDatabaseBackupName } from 'src/utils/database-backups.js';
import { canonicalJson } from 'src/utils/object.js';
import {
  recoveryAuthorityDigest,
  recoveryMlRefusal,
  recoveryMlRegistrySchema,
} from 'src/utils/recovery-ml-authority.js';

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

  private async restoreBuddySettings(
    saved: BuddySettingsSnapshot | undefined,
    mode: 'keep' | 'replace',
    assert: () => Promise<void>,
  ) {
    if (!saved || mode === 'keep') {
      return;
    }
    await this.repository.locked('state', async () => {
      await assert();
      const state = await this.repository.state();
      if (!state.settings) {
        throw new Error('Configure replacement Buddy recovery storage first');
      }
      const source = saved.settings;
      const settings = {
        ...state.settings,
        uploadMbps: source.uploadMbps,
        downloadMbps: source.downloadMbps,
        schedule: source.schedule,
        timezone: source.timezone,
        windowStart: source.windowStart,
        windowEnd: source.windowEnd,
        includeDerived: source.includeDerived,
        pausedSending: state.settings.pausedSending || source.pausedSending,
        pausedReceiving: state.settings.pausedReceiving || source.pausedReceiving,
      };
      await writeBuddyFile(
        join(this.repository.root(), 'state.json'),
        JSON.stringify({ ...state, settings, nextScheduledAt: null }),
        false,
        assert,
      );
      await assert();
    });
  }

  private async plan(id: string) {
    const plan = await readBuddyRecovery(this.repository.root(), id);
    // Validate optional source preferences before prepare can stage a database or identity preimage.
    const buddy = readBuddySettingsSnapshot(plan.manifest.settings?.buddy);
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
    return { plan, buddy };
  }

  async prepare(id: string, assert: () => Promise<void> = () => Promise.reject(recoveryMlRefusal())) {
    const { plan } = await this.plan(id);
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
    const directory = join(this.repository.root(), 'recovery', id);
    const verify = async () => verifyBuddyRecoveryBootBinding(this.repository.root(), id, assert);
    await new SystemMetadataRepository(this.repository.db).withConfigTransaction(async (metadataRepo, tx) => {
      await verify();
      await captureReplacementMl(
        { metadataRepo, configRepo: this.config, logger: LoggingRepository.create() },
        tx,
        directory,
        id,
        plan,
        verify,
      );
      const metadata = await tx
        .selectFrom('system_metadata')
        .select(['key', 'value'])
        .where('key', 'in', keys)
        .execute();
      const value = { keys, metadata };
      try {
        await writeBuddyFile(join(directory, 'replacement.json'), JSON.stringify(value), true, assert);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (
          canonicalJson(JSON.parse(await readFile(join(directory, 'replacement.json'), 'utf8'))) !==
          canonicalJson(value)
        )
          throw recoveryMlRefusal();
      }
      await assert();
    });
    return filename;
  }

  /** Called only after every ordinary worker has stopped. Failures leave maintenance active. */
  async restore(
    id: string,
    restoreDatabase: () => Promise<void>,
    maintenance: MaintenanceModeState,
    assert: () => Promise<void>,
  ) {
    const { plan, buddy } = await this.plan(id);
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
    const directory = join(this.repository.root(), 'recovery', id);
    const authority = await readReplacementMl(directory, id, plan);
    await verifyBuddyRecoveryBootBinding(this.repository.root(), id, assert);
    if (before === 'complete') {
      await verifyCommittedReplacementMl(
        {
          metadataRepo: new SystemMetadataRepository(this.repository.db),
          configRepo: this.config,
          logger: LoggingRepository.create(),
        },
        authority,
      );
      await files.verify(plan, roots, settings.configurationFiles);
      await this.restoreKeys(plan.manifest, assert);
      return finalizeBuddyBootBinding(this.repository.root(), id, assert);
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
    const recovered = await new SystemMetadataRepository(this.repository.db).withConfigTransaction(
      async (metadataRepo, trx) => {
        await assert();
        if (
          recoveryAuthorityDigest(await readReplacementMl(directory, id, plan)) !== recoveryAuthorityDigest(authority)
        )
          throw recoveryMlRefusal();
        await preserveHistoricalMl(
          { metadataRepo, configRepo: this.config, logger: LoggingRepository.create() },
          trx,
          directory,
          authority,
          assert,
        );
        await trx.deleteFrom('session').execute();
        // Stopped-worker restore: fence active claims and retain only the queue's safe durable work.
        await resetQueueAfterRestore(trx);
        await sql`TRUNCATE public.frameleaf_rate_limit, public.frameleaf_upload_lease,
        public.frameleaf_websocket_worker, public.socket_io_attachments`.execute(trx);
        // Restored unfinished jobs describe work from the old server and cannot safely be resumed.
        await sql`DELETE FROM public.media_operation`.execute(trx);
        await sql`DELETE FROM public.buddy_backup_reference`.execute(trx);
        await trx.deleteFrom('system_metadata').where('key', 'in', replacement.keys).execute();
        for (const row of replacement.metadata)
          await sql`INSERT INTO system_metadata (key, value) VALUES (${row.key}, ${JSON.stringify(row.value)}::text::jsonb)
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`.execute(trx);
        await sql`INSERT INTO system_metadata (key, value) VALUES (${SystemMetadataKey.MaintenanceMode}, ${JSON.stringify(maintenance)}::text::jsonb)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`.execute(trx);
        const repos = {
          metadataRepo,
          configRepo: this.config,
          logger: LoggingRepository.create(),
        };
        if (before !== 'database-ready')
          await trx
            .deleteFrom('system_metadata')
            .where('key', '=', SystemMetadataKey.FrameleafRecoveryMlAuthority)
            .execute();
        await admitReplacementMl(repos, trx, directory, authority, assert);
        await verifyBuddyRecoveryBootBinding(this.repository.root(), id, assert);
        const result = await recoverEffectiveConfig(repos, authority);
        if (
          recoveryAuthorityDigest(await readReplacementMl(directory, id, plan)) !== recoveryAuthorityDigest(authority)
        )
          throw recoveryMlRefusal();
        await assert();
        return result;
      },
    );
    await assert();
    publishFileConfig(
      {
        metadataRepo: new SystemMetadataRepository(this.repository.db),
        configRepo: this.config,
        logger: LoggingRepository.create(),
      },
      recovered.config,
      recovered.epoch,
    );
    await files.verify(plan, roots, settings.configurationFiles);
    await this.restoreKeys(plan.manifest, assert);
    await this.restoreBuddySettings(buddy, plan.mode, assert);
    await assert();
    await this.repository.update((state) => ({ ...state, run: null, nextScheduledAt: null }));
    await files.state('complete');
    await finalizeBuddyBootBinding(this.repository.root(), id, assert);
  }

  async settings(id: string, assert: () => Promise<void>) {
    const { plan, buddy } = await this.plan(id);
    if (plan.scope !== 'settings') throw new Error('A staged settings recovery is required');
    const settings = (await this.repository.state()).settings;
    if (!settings) throw new Error('Configure recovery storage first');
    const files = new BuddyRecoveryFiles(this.repository.root(), id, assert);
    const directory = join(this.repository.root(), 'recovery', id);
    const before = await files.load();
    if (before === 'complete') {
      await verifyCommittedReplacementMl(
        {
          metadataRepo: new SystemMetadataRepository(this.repository.db),
          configRepo: this.config,
          logger: LoggingRepository.create(),
        },
        await readReplacementMl(directory, id, plan),
      );
      await files.verify(plan, [], settings.configurationFiles);
      await this.restoreKeys(plan.manifest, assert);
      return finalizeBuddyBootBinding(this.repository.root(), id, assert);
    }
    if (before === 'database-ready') {
      await verifyCommittedReplacementMl(
        {
          metadataRepo: new SystemMetadataRepository(this.repository.db),
          configRepo: this.config,
          logger: LoggingRepository.create(),
        },
        await readReplacementMl(directory, id, plan),
      );
      await files.verify(plan, [], settings.configurationFiles);
      await this.restoreKeys(plan.manifest, assert);
      await this.restoreBuddySettings(buddy, plan.mode, assert);
      await files.state('complete');
      return finalizeBuddyBootBinding(this.repository.root(), id, assert);
    }
    const preimage = join(directory, 'settings-rollback.json');
    const digest = createHash('sha256').update(JSON.stringify(plan)).digest('hex');
    type Previous = { id: string; digest: string; system: unknown; users: unknown[] };
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
      previous = { id, digest, system: system?.value ?? {}, users };
      // Persist the original preimage once, before publishing or committing anything.
      await writeBuddyFile(preimage, JSON.stringify(previous), true, assert);
    }
    if (previous.id !== id || previous.digest !== digest)
      throw new Error('Settings rollback does not match this recovery');
    const authority = await new SystemMetadataRepository(this.repository.db).withConfigTransaction(
      async (metadataRepo, tx) => {
        try {
          return await readReplacementMl(directory, id, plan);
        } catch {
          return captureReplacementMl(
            { metadataRepo, configRepo: this.config, logger: LoggingRepository.create() },
            tx,
            directory,
            id,
            plan,
            assert,
          );
        }
      },
    );
    let recovered: Awaited<ReturnType<typeof recoverEffectiveConfig>>;
    let published = false;
    let callbackCompleted = false;
    let priorSystem: unknown;
    let priorEpoch: Awaited<ReturnType<SystemMetadataRepository['getEffectiveConfigEpoch']>>;
    try {
      await assert();
      recovered = await new SystemMetadataRepository(this.repository.db).withConfigTransaction(
        async (metadataRepo, trx) => {
          await verifyBuddyRecoveryBootBinding(this.repository.root(), id, assert);
          if (
            recoveryAuthorityDigest(await readReplacementMl(directory, id, plan)) !== recoveryAuthorityDigest(authority)
          )
            throw recoveryMlRefusal();
          const old = (previous.system ?? {}) as Record<string, unknown>;
          const restored = plan.manifest.settings.system as Record<string, unknown>;
          const merged = plan.mode === 'replace' ? restored : { ...restored, ...old };
          const current = await metadataRepo.get(SystemMetadataKey.SystemConfig);
          priorSystem = current;
          priorEpoch = await metadataRepo.getEffectiveConfigEpoch();
          // A crash after commit may replay the same result; unrelated concurrent settings never get overwritten.
          if (
            canonicalJson(current ?? {}) !== canonicalJson(old) &&
            canonicalJson(current ?? {}) !== canonicalJson(merged)
          )
            throw new Error('Settings changed after this recovery was prepared');
          await assert();
          published = true;
          await files.publish(plan, [], settings.configurationFiles);
          await assert();
          await metadataRepo.set(SystemMetadataKey.SystemConfig, merged);

          for (const row of plan.manifest.settings.users) {
            if (!(await trx.selectFrom('user').select('id').where('id', '=', row.userId).executeTakeFirst())) continue;
            await sql`INSERT INTO user_metadata ("userId", key, value) VALUES (${row.userId}::uuid, ${row.key}, ${JSON.stringify(row.value)}::text::jsonb)
            ON CONFLICT ("userId", key) DO UPDATE SET value = CASE WHEN ${plan.mode === 'replace'} THEN EXCLUDED.value ELSE user_metadata.value END`.execute(
              trx,
            );
          }
          const registry = await metadataRepo.get(SystemMetadataKey.FrameleafRecoveryMlAuthority);
          if (registry && !recoveryMlRegistrySchema.safeParse(registry).success) throw recoveryMlRefusal();
          await metadataRepo.set(SystemMetadataKey.FrameleafRecoveryMlAuthority, {
            ...authority.binding,
            quarantine: registry?.quarantine ?? {},
          });
          const result = await recoverEffectiveConfig(
            {
              metadataRepo,
              configRepo: this.config,
              logger: LoggingRepository.create(),
            },
            authority,
          );
          if (
            recoveryAuthorityDigest(await readReplacementMl(directory, id, plan)) !== recoveryAuthorityDigest(authority)
          )
            throw recoveryMlRefusal();
          await assert();
          callbackCompleted = true;
          return result;
        },
      );
    } catch (error) {
      if (published) {
        // Once the callback finished, COMMIT may have succeeded even if its response was lost.
        // An idempotent replay can commit the same epoch, so equality cannot prove rollback.
        // Transport errors may contain private settings or paths; expose only the settlement disposition.
        // eslint-disable-next-line preserve-caught-error
        if (callbackCompleted) throw new Error('Settings recovery commit outcome requires review');
        try {
          // A known pre-commit callback failure rolled back its DB transaction. Reacquire
          // authority and retain it through file rollback so another writer cannot race it.
          await new SystemMetadataRepository(this.repository.db).withConfigTransaction(async (metadata) => {
            const currentEpoch = await metadata.getEffectiveConfigEpoch();
            const currentSystem = await metadata.get(SystemMetadataKey.SystemConfig);
            if (
              canonicalJson(currentEpoch) !== canonicalJson(priorEpoch!) ||
              canonicalJson(currentSystem) !== canonicalJson(priorSystem)
            )
              throw new Error('Settings recovery commit outcome requires review');
            await files.rollback([], settings.configurationFiles);
          });
        } catch {
          throw new Error('Settings recovery commit outcome requires review');
        }
      }
      throw error;
    }
    await assert();
    publishFileConfig(
      {
        metadataRepo: new SystemMetadataRepository(this.repository.db),
        configRepo: this.config,
        logger: LoggingRepository.create(),
      },
      recovered.config,
      recovered.epoch,
    );
    await files.state('database-ready');
    await files.verify(plan, [], settings.configurationFiles);
    await this.restoreKeys(plan.manifest, assert);
    await this.restoreBuddySettings(buddy, plan.mode, assert);
    await files.state('complete');
    await finalizeBuddyBootBinding(this.repository.root(), id, assert);
  }
}
