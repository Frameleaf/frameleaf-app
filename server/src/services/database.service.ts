import { Injectable } from '@nestjs/common';
import * as semver from 'semver';
import { OnEvent } from 'src/decorators.js';
import { BootstrapEventPriority, DatabaseExtension, DatabaseLock, VectorIndex } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';

@Injectable()
export class DatabaseService extends BaseService {
  @OnEvent({ name: 'AppBootstrap', priority: BootstrapEventPriority.DatabaseService })
  async onBootstrap() {
    await this.initialize();
  }

  /**
   * Nightly optimization: after the other tidy-ups have deleted their rows, reclaim the dead space
   * and refresh planner statistics. Plain VACUUM does not lock tables, so the app keeps running.
   */
  // ponytail: whole database; per-table list if a large library makes this run too long
  @OnEvent({ name: 'NightlyDatabaseCleanup', priority: 1000 })
  async onNightlyDatabaseCleanup() {
    await this.databaseRepository.vacuum({ analyze: true });
  }

  async initialize(options: { allowInactiveImport?: boolean } = {}) {
    const version = await this.databaseRepository.getPostgresVersion();
    const current = semver.coerce(version);
    const range = this.databaseRepository.getPostgresVersionRange();
    if (!current || !semver.satisfies(current, range)) {
      throw new Error(`Frameleaf requires PostgreSQL 19. Found ${version}.`);
    }
    await this.databaseRepository.withLock(DatabaseLock.Migrations, async () => {
      await this.databaseRepository.assertFrameleafDatabase();
      const [{ installedVersion, availableVersion }] = await this.databaseRepository.getExtensionVersions([
        DatabaseExtension.Vector,
      ]);
      const vectorRange = this.databaseRepository.getExtensionVersionRange(DatabaseExtension.Vector);
      if (!availableVersion || !semver.satisfies(availableVersion, vectorRange)) {
        throw new Error(`Frameleaf requires pgvector ${vectorRange}; available: ${availableVersion ?? 'none'}.`);
      }
      if (!installedVersion) await this.databaseRepository.createExtension(DatabaseExtension.Vector);
      if (installedVersion && !semver.satisfies(installedVersion, vectorRange)) {
        throw new Error(`Installed pgvector ${installedVersion} does not satisfy ${vectorRange}.`);
      }
      if (!this.configRepository.getEnv().database.skipMigrations) await this.databaseRepository.runMigrations();
      if (!options.allowInactiveImport) await this.databaseRepository.assertImportActivated();
      await this.databaseRepository.reindexVectorsIfNeeded([
        VectorIndex.Clip,
        VectorIndex.Face,
        VectorIndex.VideoMomentFrame,
      ]);
    });
  }
}
