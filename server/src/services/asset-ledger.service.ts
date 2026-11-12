import { BadRequestException, Injectable } from '@nestjs/common';
import type {
  AssetLedgerAdminSummaryResponseDto,
  AssetLedgerListResponseDto,
  AssetLedgerQueryDto,
  AssetLedgerSummaryResponseDto,
} from 'src/dtos/asset-ledger.dto.js';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { ArgOf } from 'src/repositories/event.repository.js';
import { OnEvent } from 'src/decorators.js';
import { AssetStatus, FrameleafWorker } from 'src/enum.js';
import { type AssetLedgerCounts, AssetLedgerRepository } from 'src/repositories/asset-ledger.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { getLockedOwnerId } from 'src/utils/locked.js';

/** Rows the nightly pass reads at a time, so no statement holds the table for long. */
export const LEDGER_RECONCILE_PAGE = 20_000;

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
/** A timestamp as Postgres prints it: 2026-11-12 08:15:30.123456+00. */
const CURSOR_AT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?[+-]\d{2}(?::\d{2}){0,2}$/;

const total = (counts: AssetLedgerCounts) =>
  counts.kept + counts.trashed + counts.removed + counts.merged + counts.missing;

const encodeCursor = (row: { cursorAt: string; assetId: string }) =>
  Buffer.from(`${row.cursorAt}|${row.assetId}`).toString('base64url');

const decodeCursor = (cursor: string) => {
  const [at, assetId, ...rest] = Buffer.from(cursor, 'base64url').toString('utf8').split('|', 3);
  if (rest.length > 0 || !at || !assetId || !CURSOR_AT.test(at) || !UUID.test(assetId)) {
    throw new BadRequestException('Unknown cursor');
  }
  return { at, assetId };
};

/**
 * FL-921: the nothing-lost ledger. For every original the server has accepted it says where the original
 * is now, and which ones it cannot account for.
 *
 * Rows are written where photos are added and removed (`recordLedgerAdded`, `recordLedgerRemoved` in the
 * asset repository's own transactions). Moves to and from the Trash, and deletions somebody asked for,
 * arrive here as the events those paths already emit, one statement per event, so the actor is kept and
 * no bulk path does extra work per photo. The nightly pass then puts right whatever a path did not
 * report, and marks as missing any original that is gone without a recorded removal.
 */
@Injectable()
export class AssetLedgerService {
  constructor(
    private logger: LoggingRepository,
    private ledgerRepository: AssetLedgerRepository,
  ) {
    this.logger.setContext(AssetLedgerService.name);
  }

  async getSummary(auth: AuthDto): Promise<AssetLedgerSummaryResponseDto> {
    const states = await this.ledgerRepository.counts(auth.user.id);
    return { total: total(states), states };
  }

  /** Every account's totals. It names no file: only how many each account is missing. */
  async getAdminSummary(): Promise<AssetLedgerAdminSummaryResponseDto> {
    const [states, missing] = await Promise.all([
      this.ledgerRepository.counts(),
      this.ledgerRepository.missingByOwner(),
    ]);
    return {
      total: total(states),
      states,
      missingByOwner: missing.map(({ ownerId, count, since }) => ({
        ownerId,
        count,
        since: new Date(since).toISOString(),
      })),
    };
  }

  /**
   * The reader's own originals only: a partner's copy is a row of the partner's ledger. Photos that are
   * locked now are listed only while the reader's session has them unlocked.
   */
  async getItems(auth: AuthDto, dto: AssetLedgerQueryDto): Promise<AssetLedgerListResponseDto> {
    const take = dto.size ?? 200;
    const rows = await this.ledgerRepository.list(auth.user.id, {
      state: dto.state,
      before: dto.cursor ? decodeCursor(dto.cursor) : undefined,
      take: take + 1,
      hideLocked: !getLockedOwnerId(auth),
    });
    const page = rows.slice(0, take);
    return {
      items: page.map((row) => ({
        assetId: row.assetId,
        checksum: Buffer.from(row.checksum).toString('base64'),
        originalFileName: row.originalFileName,
        addedAt: new Date(row.addedAt).toISOString(),
        addedVia: row.addedVia,
        state: row.state,
        stateAt: new Date(row.stateAt).toISOString(),
        stateBy: row.stateBy,
        reason: row.reason,
      })),
      nextCursor: rows.length > take ? encodeCursor(page.at(-1)!) : null,
    };
  }

  @OnEvent({ name: 'AssetTrashAll' })
  onAssetTrashAll({ assetIds, userId }: ArgOf<'AssetTrashAll'>): Promise<void> {
    return this.record('trash', () => this.ledgerRepository.trashed(assetIds, userId));
  }

  @OnEvent({ name: 'AssetRestoreAll' })
  onAssetRestoreAll({ assetIds, userId }: ArgOf<'AssetRestoreAll'>): Promise<void> {
    return this.record('restore', () => this.ledgerRepository.restored(assetIds, userId));
  }

  /** Emptying the Trash and deleting for good: the rows go when the deletion job reaches them. */
  @OnEvent({ name: 'AssetDeleteAll' })
  onAssetDeleteAll({ assetIds, userId }: ArgOf<'AssetDeleteAll'>): Promise<void> {
    return this.record('deletion', () => this.ledgerRepository.removed(assetIds, { by: userId, reason: 'deleted' }));
  }

  /** Trash and restore of photos whose order with a synced source matters; they arrive as one bundle. */
  @OnEvent({ name: 'AssetLocalEffects' })
  onAssetLocalEffects({ ownerId, assets }: ArgOf<'AssetLocalEffects'>): Promise<void> {
    const trashed = assets.filter(({ status }) => status === AssetStatus.Trashed).map(({ assetId }) => assetId);
    const restored = assets.filter(({ status }) => status === AssetStatus.Active).map(({ assetId }) => assetId);
    return this.record('trash', async () => {
      await this.ledgerRepository.trashed(trashed, ownerId);
      await this.ledgerRepository.restored(restored, ownerId);
    });
  }

  /**
   * The ledger never stops the change it records: a write that fails is logged, and the nightly pass
   * brings the row in line with the photo.
   */
  private async record(what: string, write: () => Promise<void>): Promise<void> {
    try {
      await write();
    } catch (error) {
      this.logger.warn(`Could not record a ${what} in the nothing-lost ledger; the nightly pass will: ${error}`);
    }
  }

  @OnEvent({ name: 'NightlyDatabaseCleanup', workers: [FrameleafWorker.Microservices] })
  async onNightlyDatabaseCleanup(): Promise<void> {
    try {
      const result = await this.reconcile();
      if (result.added > 0 || result.corrected > 0 || result.missing > 0) {
        this.logger.log(
          `Nothing-lost ledger: ${result.added} original(s) added, ${result.corrected} brought in line, ${result.missing} found missing`,
        );
      }
      if (result.missing > 0) {
        this.logger.warn(
          `${result.missing} original(s) are gone with no record of a removal; they are listed as missing in the ledger`,
        );
      }
    } catch (error) {
      this.logger.error(`The nightly pass over the nothing-lost ledger did not finish: ${error}`);
    }
  }

  /**
   * The nightly pass, a page at a time: first every photo without a ledger row gets one (photos from
   * before the ledger, and any added by a path that wrote none), then every row is compared with its photo.
   */
  async reconcile(): Promise<{ added: number; corrected: number; missing: number }> {
    const result = { added: 0, corrected: 0, missing: 0 };
    for (let after: string | null = null; ;) {
      const page = await this.ledgerRepository.backfillPage(after, LEDGER_RECONCILE_PAGE);
      result.added += page.added;
      if (!page.last) {
        break;
      }
      after = page.last;
    }
    for (let after: string | null = null; ;) {
      const page = await this.ledgerRepository.reconcilePage(after, LEDGER_RECONCILE_PAGE);
      result.missing += page.missing;
      result.corrected += page.corrected;
      if (!page.last) {
        break;
      }
      after = page.last;
    }
    return result;
  }
}
