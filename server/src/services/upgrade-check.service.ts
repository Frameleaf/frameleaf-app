import { Injectable } from '@nestjs/common';
import type { UpgradeCheckResponseDto, UpgradeCheckSummary } from 'src/dtos/upgrade-check.dto.js';
import { serverVersion } from 'src/constants.js';
import { OnEvent } from 'src/decorators.js';
import { FrameleafWorker } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import {
  type LibraryFingerprint,
  SENTINEL_FILE,
  type SentinelRecord,
  type SentinelState,
  UPGRADE_FINGERPRINT_KEY,
  type UpgradeFingerprintState,
  buildLibraryFingerprint,
  compareLibraryFingerprints,
  parseSentinel,
  sentinelPath,
} from 'src/utils/library-fingerprint.js';
import { type StorageRoot, pathState, storageRoots } from 'src/utils/storage-reach.js';

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException)?.code;
const isGone = (error: unknown) => errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR';

/** The short form of the latest check, shared with "What needs your attention". */
export const upgradeCheckSummary = (state: UpgradeFingerprintState | null | undefined): UpgradeCheckSummary => {
  const latest = state?.latest;
  if (!latest) {
    return { state: 'none', reason: null, checkedAt: null, fromVersion: null, toVersion: null };
  }
  return {
    state: latest.state,
    reason: latest.state === 'attention' ? 'upgrade-check-failed' : null,
    checkedAt: latest.checkedAt,
    fromVersion: latest.fromVersion,
    toVersion: latest.toVersion,
  };
};

/**
 * FL-954: the library check after each upgrade. `DatabaseService` keeps a fingerprint of the library
 * before the new version's migrations run; once the new version has started, this takes it again,
 * compares the two (`compareLibraryFingerprints`) and keeps the answer for `GET /admin/upgrade-check`.
 *
 * It also looks after the mount sentinels: a `.frameleaf-sentinel` file with a random id in each of
 * Frameleaf's own folders and each external library folder, written once the folder is in place and
 * has files. A sentinel that is gone after an upgrade means the drive is not mounted, which the check
 * says instead of reporting the photos on it as lost.
 */
@Injectable()
export class UpgradeCheckService extends BaseService {
  @OnEvent({ name: 'AppBootstrap', workers: [FrameleafWorker.Microservices] })
  async onBootstrap(): Promise<void> {
    try {
      await this.run();
    } catch (error) {
      // the check never stops a start
      this.logger.warn(`Could not check the library after starting: ${error}`);
    }
  }

  async getUpgradeCheck(): Promise<UpgradeCheckResponseDto> {
    const state = await this.read();
    const latest = state?.latest;
    return {
      ...upgradeCheckSummary(state),
      findings: latest?.findings ?? [],
      assetsBefore: latest?.assets.before ?? null,
      assetsAfter: latest?.assets.after ?? null,
      counts: latest?.tables ?? [],
    };
  }

  /** Runs the check when a fingerprint for this version is waiting, then brings the sentinels up to date. */
  async run(): Promise<void> {
    const state = (await this.read()) ?? {};
    const libraries = await this.libraryRepository.getAll();
    const current = storageRoots(libraries);
    const toVersion = serverVersion.toString();
    let { latest } = state;
    let checked = false;

    if (state.pending?.toVersion === toVersion) {
      const { before } = state.pending;
      const after = await this.capture(toVersion, before.roots, current);
      if (after) {
        const result = compareLibraryFingerprints(before, after);
        latest = { ...result, before, after };
        checked = true;
        if (result.state === 'ok') {
          this.logger.log(
            `Library check after upgrading from ${result.fromVersion} to ${result.toVersion}: everything is where it was`,
          );
        } else {
          const reasons = result.findings.map(({ reason, path }) => (path ? `${reason} (${path})` : reason));
          this.logger.warn(
            `Library check after upgrading from ${result.fromVersion} to ${result.toVersion} found: ${reasons.join(', ')}`,
          );
        }
      }
    }

    // On the start that ran the check, a sentinel that is away stays on record, so the finding holds.
    const roots = await this.ensureSentinels(state.roots ?? [], current, !checked);
    // A fingerprint waiting for another version is of no use to this one, and is dropped with the rest.
    await this.systemMetadataRepository.set(UPGRADE_FINGERPRINT_KEY, {
      roots,
      ...(latest && { latest }),
    } satisfies UpgradeFingerprintState);
  }

  private async read(): Promise<UpgradeFingerprintState | null> {
    return (await this.systemMetadataRepository.get(UPGRADE_FINGERPRINT_KEY)) as UpgradeFingerprintState | null;
  }

  /** The fingerprint now: the roots on record with their sentinels read again, then any root added since. */
  private async capture(
    version: string,
    recorded: SentinelRecord[],
    current: StorageRoot[],
  ): Promise<LibraryFingerprint | null> {
    const known = new Set(recorded.map(({ path }) => path));
    const roots: Array<SentinelRecord & { state: SentinelState }> = [];
    for (const { kind, name, path, sentinelId } of recorded) {
      const probe = current.find((root) => root.path === path)?.probe ?? path;
      roots.push({ kind, name, path, sentinelId, state: await this.sentinelState({ path, sentinelId }, probe) });
    }
    for (const root of current) {
      if (!known.has(root.path)) {
        // no sentinel on record: FL-520's signal, the mount file or the library folder being gone
        const reach = await pathState(this.storageRepository, root.probe);
        const state = reach === 'missing' ? 'missing' : reach === 'present' ? 'present' : 'unknown';
        roots.push({ kind: root.kind, name: root.name, path: root.path, sentinelId: null, state });
      }
    }
    const counts = await this.databaseRepository.getLibraryFingerprintCounts(roots.map(({ path }) => path));
    return counts ? buildLibraryFingerprint(version, new Date().toISOString(), counts, roots) : null;
  }

  private async readSentinel(root: string): Promise<{ id: string | null; state: 'read' | 'missing' | 'unknown' }> {
    try {
      const content = await this.storageRepository.readFile(sentinelPath(root));
      return { id: parseSentinel(content.toString('utf8')), state: 'read' };
    } catch (error) {
      return { id: null, state: isGone(error) ? 'missing' : 'unknown' };
    }
  }

  /** Whether a folder holds anything besides the sentinel; null when it cannot be told. */
  private async hasFiles(root: string): Promise<boolean | null> {
    try {
      const names = await this.storageRepository.readdir(root);
      return names.some((name) => name !== SENTINEL_FILE);
    } catch (error) {
      return isGone(error) ? false : null;
    }
  }

  private async sentinelState(
    { path, sentinelId }: Pick<SentinelRecord, 'path' | 'sentinelId'>,
    probe: string,
  ): Promise<SentinelState> {
    if (sentinelId) {
      const { id, state } = await this.readSentinel(path);
      if (state !== 'read') {
        return state;
      }
      return id === sentinelId ? 'present' : 'different';
    }
    // A folder no sentinel could be written to (a read-only share): in place while it is there with files in it.
    const reach = await pathState(this.storageRepository, probe);
    if (reach !== 'present') {
      return reach;
    }
    const files = await this.hasFiles(path);
    return files === null ? 'unknown' : files ? 'present' : 'missing';
  }

  /**
   * Records each root that is in place. A root gets its sentinel the first time it is reachable and has
   * files in it, so an empty mount point (the folder Docker leaves when a drive is not mounted) never
   * gets one. A root whose sentinel is away keeps its record, and with `adopt` takes the sentinel of
   * whatever is mounted there now once that has files: a drive that was replaced settles on a later
   * start, after the check has had its say.
   */
  private async ensureSentinels(recorded: SentinelRecord[], current: StorageRoot[], adopt: boolean) {
    const byPath = new Map(recorded.map((root) => [root.path, root]));
    const next: SentinelRecord[] = [];
    for (const root of current) {
      const { kind, name, path } = root;
      const existing = byPath.get(path);
      if (existing) {
        const state = await this.sentinelState(existing, root.probe);
        if (state === 'present' || state === 'unknown' || !adopt) {
          next.push({ ...existing, kind, name });
          continue;
        }
      }
      const inPlace =
        (await pathState(this.storageRepository, root.probe)) === 'present' && (await this.hasFiles(path)) === true;
      if (!inPlace) {
        if (existing) {
          next.push({ ...existing, kind, name });
        }
        continue;
      }
      next.push({ kind, name, path, sentinelId: await this.writeSentinel(path) });
    }
    return next;
  }

  /** The id of the sentinel in `root`: the one already there, or a new one. Null when none can be written. */
  private async writeSentinel(root: string): Promise<string | null> {
    const found = await this.readSentinel(root);
    if (found.id) {
      return found.id;
    }
    if (found.state !== 'missing') {
      return null;
    }
    const id = this.cryptoRepository.randomUUID();
    try {
      await this.storageRepository.createFile(sentinelPath(root), Buffer.from(`${id}\n`));
      return id;
    } catch (error) {
      if (errorCode(error) === 'EEXIST') {
        return (await this.readSentinel(root)).id;
      }
      this.logger.debug(`No mount sentinel could be written in ${root}: ${error}`);
      return null;
    }
  }
}
