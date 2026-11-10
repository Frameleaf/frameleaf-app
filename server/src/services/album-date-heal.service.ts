import { Inject, Injectable } from '@nestjs/common';
import type { Transaction } from 'kysely';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { AlbumChangeReversal, AlbumChangeRow } from 'src/repositories/album-change-run.repository.js';
import type { HealPhotoRow, HealedDateAfter, HealedDateBefore } from 'src/repositories/album-suggestion.repository.js';
import type { DB } from 'src/schema/index.js';
import type { HealPhoto, HealResult } from 'src/utils/album-suggestions.js';
import {
  AlbumLostDatesHealDto,
  AlbumLostDatesHealResponseDto,
  AlbumLostDatesResponseDto,
} from 'src/dtos/album-suggestion.dto.js';
import { Permission } from 'src/enum.js';
import { AlbumSuggestionRepository, MAX_HEAL_PHOTOS } from 'src/repositories/album-suggestion.repository.js';
import { PartnerOriginRepository } from 'src/repositories/partner-origin.repository.js';
import { AlbumChangeRunKind, AlbumChangeRunStatus } from 'src/schema/tables/album-change-run.table.js';
import { ReversesAlbumChange } from 'src/services/album-change-run.service.js';
import { AssetService } from 'src/services/asset.service.js';
import { BaseService } from 'src/services/base.service.js';
import { LockedEncryptionService } from 'src/services/locked-encryption.service.js';
import { healDates, suspiciousDate } from 'src/utils/album-suggestions.js';
import { getHiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import { getLockedOwnerId } from 'src/utils/locked-visibility.js';

/** The change kind a healed date records, and the reverser below undoes. */
export const ALBUM_CHANGE_DATE_HEALED = 'asset.date_healed';

/** One photo to heal, decided from a fresh read of its album. */
export type HealPlanItem = {
  albumId: string;
  assetId: string;
  dateTimeOriginal: string;
  expectedTakenAt: Date;
  isLocked: boolean;
};

const toHealPhoto = (row: HealPhotoRow, viewerId: string): HealPhoto => ({
  id: row.id,
  fileName: row.originalFileName,
  takenAt: row.takenAt,
  localDateTime: row.localDateTime,
  camera: !suspiciousDate(row.originalFileName, row.hasCameraDetails),
  estimated: row.dateEstimated,
  dateSet: row.dateSet,
  mine: row.ownerId === viewerId,
});

/**
 * FL-1299: photos in an album that lost their date, healed from the album around them. Nothing changes without
 * the person's approval, and the server decides again what each approved photo should be: it takes which photos
 * to heal from the request, and never the dates.
 */
@Injectable()
export class AlbumDateHealService extends BaseService {
  /** FL-1347: for the AssetService this builds by hand, as Nest gives one to its own (FL-721, see `BaseService.create`). */
  @Inject(LockedEncryptionService)
  private lockedEncryption!: LockedEncryptionService;
  /**
   * A later edit wins, and Locked stays Locked: a session without the PIN can undo a run but learns nothing of
   * the Locked photos in it, neither their names nor how many were put back.
   */
  @ReversesAlbumChange(ALBUM_CHANGE_DATE_HEALED)
  static async reverseHeals(
    tx: Transaction<DB>,
    changes: AlbumChangeRow[],
    { auth }: { auth: AuthDto },
  ): Promise<AlbumChangeReversal> {
    const suggestions = new AlbumSuggestionRepository(tx);
    const showsLocked = getLockedOwnerId(auth) !== undefined;
    let reversed = 0;
    const skipped: string[] = [];
    const restored: string[] = [];
    for (const change of changes) {
      if (!change.assetId) {
        continue;
      }
      const result = await suggestions.restoreHealedDate(
        change.assetId,
        change.before as HealedDateBefore,
        change.after as HealedDateAfter,
      );
      if (!result) {
        continue;
      }
      const shown = !result.isLocked || showsLocked;
      if (result.outcome === 'restored') {
        restored.push(change.assetId);
        reversed += shown ? 1 : 0;
      } else if (shown) {
        skipped.push(result.fileName);
      }
    }
    if (restored.length > 0) {
      await suggestions.queueAfterRestore(
        restored,
        await new PartnerOriginRepository(tx).getIdsWithFollowers('asset', restored),
      );
    }
    return { reversed, skipped };
  }

  async getLostDates(auth: AuthDto, id: string): Promise<AlbumLostDatesResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AlbumRead, ids: [id] });
    const { result } = await this.read(auth, id);
    return {
      eligible: result.eligible,
      reason: result.reason ?? null,
      from: result.from ?? null,
      to: result.to ?? null,
      suggestions: result.suggestions,
    };
  }

  async heal(auth: AuthDto, dto: AlbumLostDatesHealDto): Promise<AlbumLostDatesHealResponseDto> {
    const requested = dto.albums.reduce((total, { assetIds }) => total + new Set(assetIds).size, 0);
    await this.requireAccess({ auth, permission: Permission.AlbumRead, ids: dto.albums.map(({ albumId }) => albumId) });
    const plan = await this.plan(auth, dto);
    if (plan.length === 0) {
      return { runId: null, healed: 0, skipped: requested };
    }

    // In id order, so that two healings at once queue for each photo instead of waiting on each other.
    const ids = plan.map(({ assetId }) => assetId).sort();
    const { runId, healed } = await this.partnerOriginRepository.withOriginEdit('asset', ids, [], async (tx) => {
      const runId = await this.albumChangeRunRepository.createRun(tx!, {
        userId: auth.user.id,
        kind: AlbumChangeRunKind.Heal,
      });
      const healed = await this.healInto(tx!, auth, runId, plan);
      // The run's summary can be read without the PIN, so it counts only what such a session may know of.
      const shown = healed.filter((item) => !item.isLocked).length;
      // Everything changed in between: a run with nothing in it must not become the latest thing to undo.
      await this.albumChangeRunRepository.finishRun(
        tx!,
        runId,
        healed.length > 0 ? AlbumChangeRunStatus.Done : AlbumChangeRunStatus.Undone,
        { healed: shown },
      );
      return { runId, healed };
    });

    await this.emitAssetsChanged(healed.map(({ assetId }) => assetId));
    return { runId: healed.length > 0 ? runId : null, healed: healed.length, skipped: requested - healed.length };
  }

  /**
   * Writes a plan inside a run, in the caller's transaction, so that cleanup can add healing to its own record.
   * Each write records the previous date and estimate beside the change that replaced them.
   */
  async healInto(tx: Transaction<DB>, auth: AuthDto, runId: string, plan: HealPlanItem[]): Promise<HealPlanItem[]> {
    const assets = BaseService.create(AssetService, this);
    const healed: HealPlanItem[] = [];
    for (const item of [...plan].sort((a, b) => a.assetId.localeCompare(b.assetId))) {
      const write = await assets.writeEstimatedDate(auth, {
        id: item.assetId,
        dateTimeOriginal: item.dateTimeOriginal,
        expectedTakenAt: item.expectedTakenAt,
      });
      if (write) {
        await this.albumChangeRunRepository.recordChange(tx, runId, {
          kind: ALBUM_CHANGE_DATE_HEALED,
          albumId: item.albumId,
          assetId: item.assetId,
          before: write.before,
          after: write.after,
        });
        healed.push(item);
      }
    }
    return healed;
  }

  /** What each approved photo should be now, read again: the list the person approved may be out of date. */
  async plan(auth: AuthDto, dto: AlbumLostDatesHealDto): Promise<HealPlanItem[]> {
    const plan = new Map<string, HealPlanItem>();
    for (const { albumId, assetIds } of dto.albums) {
      const { rows, result } = await this.read(auth, albumId);
      const byId = new Map(rows.map((row) => [row.id, row]));
      const approved = new Set(assetIds);
      for (const { assetId, dateTimeOriginal } of result.suggestions) {
        const row = byId.get(assetId);
        if (row && approved.has(assetId) && !plan.has(assetId)) {
          plan.set(assetId, {
            albumId,
            assetId,
            dateTimeOriginal,
            expectedTakenAt: row.takenAt,
            isLocked: row.isLocked,
          });
        }
      }
    }
    return plan.values().toArray();
  }

  private async read(auth: AuthDto, albumId: string): Promise<{ rows: HealPhotoRow[]; result: HealResult }> {
    const rows = await this.albumRepository.suggestions.getHealPhotos(
      albumId,
      auth.user.id,
      getLockedOwnerId(auth),
      getHiddenContentQueryOptions(auth),
    );
    if (rows.length > MAX_HEAL_PHOTOS) {
      return { rows: [], result: { eligible: false, reason: 'wide', suggestions: [] } };
    }
    return { rows, result: healDates(rows.map((row) => toHealPhoto(row, auth.user.id))) };
  }
}
