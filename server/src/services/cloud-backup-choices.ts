import { BadRequestException } from '@nestjs/common';
import type {
  CloudBackupCoverageResponseDto,
  CloudBackupExclusionsResponseDto,
  CloudBackupSelectionResponseDto,
  CloudBackupSelectionUpdateDto,
  OwnerBackupExclusionsResponseDto,
} from 'src/dtos/cloud-backup-selection.dto.js';
import type { CloudBackupSelectionRepository } from 'src/repositories/cloud-backup-selection.repository.js';
import type { CloudBackupManifest } from 'src/utils/cloud-backup.js';
import {
  type BackupExclusionReason,
  type CloudBackupChosen,
  type CloudBackupSelection,
  backupUserFingerprint,
  canonicalSelection,
  exclusionReason,
  normalizeBackupFolder,
} from 'src/utils/cloud-backup-selection.js';
import { backupCoverageRowSchema } from 'src/utils/frameleaf-cloud-backup-coverage.js';

/** Report states the coverage view shows as they are; a refused or expired one was not reported. */
const SHOWN_REPORT_STATES: ReadonlySet<string> = new Set(['published', 'pending', 'local']);

/** Items a classification reads from the database at a time. */
const CLASSIFY_PAGE = 5000;

const EMPTY_CHOICE: CloudBackupChosen = {
  albumIds: [],
  collectionIds: [],
  personIds: [],
  tagIds: [],
  folders: [],
  favorites: false,
  dateRanges: [],
};

/** The assets of a manifest whose original it holds. */
const withOriginals = (manifest: CloudBackupManifest) =>
  new Set(
    Object.entries(manifest.assets)
      .filter(([, asset]) => asset.files.some((file) => file.role === 'original'))
      .map(([assetId]) => assetId),
  );

type Counts = { selection: number; licence: number; notCommitted: number; unknown: number };
const emptyCounts = (): Counts => ({ selection: 0, licence: 0, notCommitted: 0, unknown: 0 });
const countKey: Record<BackupExclusionReason, keyof Counts> = {
  selection: 'selection',
  licence: 'licence',
  'not-committed': 'notCommitted',
  unknown: 'unknown',
};

/**
 * FL-362: what each account chooses for Cloud Backup, what an administrator sees of it (numbers only), and
 * why an item of a backed-up library has no original in a backup. The reason always comes from that
 * backup's own decision, which its database copy carries: never from the choice made since.
 */
export class CloudBackupChoices {
  constructor(private selection: CloudBackupSelectionRepository) {}

  /** The account's own choice, with how much of its library it keeps now. */
  async get(userId: string): Promise<CloudBackupSelectionResponseDto> {
    const chosen = await this.selection.getSelection(userId);
    return this.respond(userId, chosen);
  }

  /**
   * Save the account's own choice. Only its own albums (or ones shared with it), collections, people and
   * tags can be chosen; asking for any other is refused, so a choice never names what the account can't see.
   */
  async set(userId: string, dto: CloudBackupSelectionUpdateDto): Promise<CloudBackupSelectionResponseDto> {
    if (dto.mode === 'everything') {
      await this.selection.setSelection(userId, null);
      return this.respond(userId, null);
    }
    const chosen = canonicalSelection({
      albumIds: dto.albumIds,
      collectionIds: dto.collectionIds,
      personIds: dto.personIds,
      tagIds: dto.tagIds,
      folders: dto.folders.map((folder) => normalizeBackupFolder(folder)),
      favorites: dto.favorites,
      dateRanges: dto.dateRanges.map((range) =>
        range.kind === 'between'
          ? { kind: 'between' as const, from: range.from!, to: range.to! }
          : { kind: 'recent' as const, months: range.months! },
      ),
    });
    const choosable = await this.selection.choosable(userId, chosen);
    for (const kind of ['albumIds', 'collectionIds', 'personIds', 'tagIds'] as const) {
      if (choosable[kind].length !== chosen[kind].length) {
        throw new BadRequestException('Choose only from your own library: an album, person or tag was not found.');
      }
    }
    await this.selection.setSelection(userId, chosen);
    return this.respond(userId, chosen);
  }

  private async respond(userId: string, chosen: CloudBackupSelection): Promise<CloudBackupSelectionResponseDto> {
    const { total, selected } = await this.selection.estimate(userId, chosen);
    const choice = chosen ?? EMPTY_CHOICE;
    return {
      mode: chosen ? 'chosen' : 'everything',
      albumIds: choice.albumIds,
      collectionIds: choice.collectionIds,
      personIds: choice.personIds,
      tagIds: choice.tagIds,
      folders: choice.folders,
      favorites: choice.favorites,
      dateRanges: choice.dateRanges.map((range) =>
        range.kind === 'between'
          ? { kind: 'between', from: range.from, to: range.to }
          : { kind: 'recent', months: range.months },
      ),
      totalOriginals: total,
      selectedOriginals: selected,
    };
  }

  /**
   * Who's backed up: each account's numbers in the newest run's coverage report, as published (or kept
   * here for your own bucket). Names are resolved on this server from the opaque references; never a choice.
   */
  async coverage(instanceId: string): Promise<CloudBackupCoverageResponseDto> {
    const report = await this.selection.getLatestCoverageReport();
    if (!report) {
      return { runId: null, inventoryAt: null, state: 'unknown', accounts: [] };
    }
    const accounts = await this.selection.listAccounts();
    const byFingerprint = new Map(accounts.map((account) => [backupUserFingerprint(instanceId, account.id), account]));
    const rows = report.pages.flatMap((body) =>
      (JSON.parse(body) as { rows: unknown[] }).rows.map((row) => backupCoverageRowSchema.parse(row)),
    );
    return {
      runId: report.runId,
      inventoryAt: new Date(report.inventoryAt as unknown as string).toISOString(),
      state: SHOWN_REPORT_STATES.has(report.status)
        ? (report.status as 'published' | 'pending' | 'local')
        : 'not-reported',
      accounts: rows.flatMap((row) => {
        const account = byFingerprint.get(row.userFingerprint);
        return account
          ? [
              {
                userId: account.id,
                name: account.name,
                email: account.email,
                totalOriginals: row.totalOriginals,
                selectedOriginals: row.selectedOriginals,
                licenceEligible: row.licenceEligible,
                includedOriginals: row.includedOriginals,
              },
            ]
          : [];
      }),
    };
  }

  /**
   * Why the items this database holds have no original in a backup, counted per account. For an
   * administrator: numbers only, so what an account chose stays its own.
   */
  async exclusions(manifest: CloudBackupManifest, manifestKey: string): Promise<CloudBackupExclusionsResponseDto> {
    const decision = await this.selection.findDecisionRunByManifest(manifestKey);
    const backedUp = withOriginals(manifest);
    const totals = emptyCounts();
    const perOwner = new Map<string, Counts>();
    let after: string | null = null;
    for (;;) {
      const page = await this.selection.getInventoryPage(decision?.runId ?? null, after, CLASSIFY_PAGE);
      for (const item of page) {
        if (backedUp.has(item.id)) {
          continue;
        }
        const key = countKey[exclusionReason(!!decision, item.reason)];
        totals[key] += 1;
        const counts = perOwner.get(item.ownerId) ?? emptyCounts();
        counts[key] += 1;
        perOwner.set(item.ownerId, counts);
      }
      if (page.length < CLASSIFY_PAGE) {
        break;
      }
      after = page.at(-1)!.id;
    }
    const names = new Map((await this.selection.listAccounts()).map((account) => [account.id, account.name]));
    return {
      manifestKey,
      decisionKnown: !!decision,
      totals,
      accounts: [...perOwner]
        .map(([userId, counts]) => ({ userId, name: names.get(userId) ?? '', ...counts }))
        .toSorted((a, b) => a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId)),
    };
  }

  /** The account's own items without an original in a backup, each with its reason, a page at a time. */
  async ownerExclusions(
    userId: string,
    manifest: CloudBackupManifest,
    dto: { manifestKey: string; afterId?: string; limit: number },
  ): Promise<OwnerBackupExclusionsResponseDto> {
    const decision = await this.selection.findDecisionRunByManifest(dto.manifestKey);
    const backedUp = withOriginals(manifest);
    const items: OwnerBackupExclusionsResponseDto['items'] = [];
    let after: string | null = dto.afterId ?? null;
    let full = false;
    for (;;) {
      const page = await this.selection.getInventoryPage(decision?.runId ?? null, after, CLASSIFY_PAGE, userId);
      for (const item of page) {
        after = item.id;
        if (backedUp.has(item.id)) {
          continue;
        }
        // a Locked item is never named in a restore list
        items.push({
          assetId: item.id,
          name: item.locked ? '' : item.originalFileName,
          reason: exclusionReason(!!decision, item.reason),
        });
        if (items.length === dto.limit) {
          full = true;
          break;
        }
      }
      if (full || page.length < CLASSIFY_PAGE) {
        break;
      }
    }
    return {
      manifestKey: dto.manifestKey,
      decisionKnown: !!decision,
      items,
      nextAfterId: full ? after : null,
    };
  }
}
