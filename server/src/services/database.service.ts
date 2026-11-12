import { Injectable } from '@nestjs/common';
import * as semver from 'semver';
import { serverVersion } from 'src/constants.js';
import { OnEvent } from 'src/decorators.js';
import { BootstrapEventPriority, DatabaseExtension, DatabaseLock, VectorIndex } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import {
  UPGRADE_FINGERPRINT_KEY,
  type UpgradeFingerprintState,
  buildLibraryFingerprint,
  hasUpgradeFingerprint,
} from 'src/utils/library-fingerprint.js';

@Injectable()
export class DatabaseService extends BaseService {
  @OnEvent({ name: 'AppBootstrap', priority: BootstrapEventPriority.DatabaseService })
  async onBootstrap() {
    await this.initialize();
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
      await this.captureUpgradeFingerprint();
      if (!this.configRepository.getEnv().database.skipMigrations) await this.databaseRepository.runMigrations();
      if (!options.allowInactiveImport) await this.databaseRepository.assertImportActivated();
      await this.databaseRepository.reindexVectorsIfNeeded([
        VectorIndex.Clip,
        VectorIndex.Face,
        VectorIndex.VideoMomentFrame,
      ]);
    });
  }

  /**
   * FL-954: when this start is the first on another version, keep a fingerprint of the library as the
   * old version left it, before any migration runs. The upgrade check compares it once the new version
   * is up. Taken once per upgrade (a start that failed part way keeps the first one), and never in the
   * way of starting: anything that goes wrong here is logged and the upgrade goes on without a check.
   */
  private async captureUpgradeFingerprint(): Promise<void> {
    try {
      const fromVersion = await this.databaseRepository.getRecordedVersion();
      const toVersion = serverVersion.toString();
      if (!fromVersion || fromVersion === toVersion) {
        return;
      }
      const state = (await this.systemMetadataRepository.get(
        UPGRADE_FINGERPRINT_KEY,
      )) as UpgradeFingerprintState | null;
      if (hasUpgradeFingerprint(state, fromVersion, toVersion)) {
        return;
      }
      const roots = state?.roots ?? [];
      const counts = await this.databaseRepository.getLibraryFingerprintCounts(roots.map(({ path }) => path));
      if (!counts) {
        return;
      }
      const before = buildLibraryFingerprint(
        fromVersion,
        new Date().toISOString(),
        counts,
        // the sentinels were in place when they were last recorded; the check reads them again afterwards
        roots.map((root) => ({ ...root, state: 'present' as const })),
      );
      await this.systemMetadataRepository.set(UPGRADE_FINGERPRINT_KEY, {
        ...state,
        pending: { toVersion, before },
      } satisfies UpgradeFingerprintState);
      this.logger.log(`Kept a library fingerprint of ${fromVersion} before upgrading to ${toVersion}`);
    } catch (error) {
      this.logger.warn(`Could not keep a library fingerprint before upgrading: ${error}`);
    }
  }
}
