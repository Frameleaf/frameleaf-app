import { BadRequestException, Injectable } from '@nestjs/common';
import type { Transaction } from 'kysely';
import type {
  AlbumMergeDto,
  AlbumMergeIntoDto,
  AlbumMergePreviewResponseDto,
  AlbumMergeResponseDto,
} from 'src/dtos/album-merge.dto.js';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { AlbumChangeReversal, AlbumChangeRow } from 'src/repositories/album-change-run.repository.js';
import type { DB } from 'src/schema/index.js';
import { OnEvent } from 'src/decorators.js';
import { asAlbumKind } from 'src/dtos/album.dto.js';
import { AlbumKind, AlbumUserRole, FrameleafWorker, Permission } from 'src/enum.js';
import { AlbumChangeKind, AlbumMergeRepository, type MergeAlbumRow } from 'src/repositories/album-merge.repository.js';
import { AlbumSourceRepository } from 'src/repositories/album-source.repository.js';
import { AlbumRepository, lockAlbumHierarchy } from 'src/repositories/album.repository.js';
import { AlbumOriginField } from 'src/repositories/partner-origin.repository.js';
import { AlbumChangeRunKind, AlbumChangeRunStatus } from 'src/schema/tables/album-change-run.table.js';
import { AlbumChangeRunService, ReversesAlbumChange } from 'src/services/album-change-run.service.js';
import { BaseService } from 'src/services/base.service.js';
import { recordAlbumEdit } from 'src/services/partner-copy.service.js';
import { getHiddenContentQueryOptions, getOthersRulesQueryOptions } from 'src/utils/hidden-content.js';
import { getLockedVisibilityOptions } from 'src/utils/locked-visibility.js';

/**
 * Who keeps their name and icon: the album with the most photos by true owner count, the older one on a tie.
 * Pure, so the rule can be read and tested on its own; both the preview and the merge use it.
 */
export const chooseMergeWinner = <T extends { id: string; createdAt: Date }>(
  first: T,
  second: T,
  counts: Map<string, number>,
): { winner: T; loser: T } => {
  const difference = (counts.get(first.id) ?? 0) - (counts.get(second.id) ?? 0);
  const age = first.createdAt.getTime() - second.createdAt.getTime();
  const firstWins = difference === 0 ? (age === 0 ? first.id < second.id : age < 0) : difference > 0;
  return firstWins ? { winner: first, loser: second } : { winner: second, loser: first };
};

const sharedWithOthers = (album: {
  albumUsers: { role: AlbumUserRole }[];
  sharedLinks: unknown[] | null | undefined;
}) => album.albumUsers.some(({ role }) => role !== AlbumUserRole.Owner) || (album.sharedLinks?.length ?? 0) > 0;

/**
 * FL-1298: "Merge with…". The server decides which album stays; the person sees which in the preview. Everything
 * happens in one transaction, so a restart half-way leaves neither a partial merge nor anything to resume, and
 * every step is recorded so Undo can take back exactly what it did.
 */
@Injectable()
export class AlbumMergeService extends BaseService {
  private get runs() {
    return BaseService.create(AlbumChangeRunService, this);
  }

  @ReversesAlbumChange(AlbumChangeKind.ParentChanged)
  static async reverseParents(tx: Transaction<DB>, changes: AlbumChangeRow[]): Promise<AlbumChangeReversal> {
    let reversed = 0;
    const skipped: string[] = [];
    const repository = new AlbumRepository(tx);
    for (const change of changes) {
      if (!change.albumId) {
        continue;
      }
      const album = await tx
        .selectFrom('album')
        .select(['albumName', 'parentId'])
        .where('id', '=', change.albumId)
        .where('deletedAt', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!album) {
        continue;
      }
      const { parentId: expected } = change.after as { parentId: string | null };
      if (album.parentId !== expected) {
        skipped.push(album.albumName);
        continue;
      }
      const { parentId } = change.before as { parentId: string | null };
      try {
        await repository.reparentIn(tx, change.albumId, parentId);
        reversed += 1;
      } catch (error) {
        // What it was moved back into no longer exists or now sits inside it.
        if (!(error instanceof BadRequestException)) {
          throw error;
        }
        skipped.push(album.albumName);
      }
    }
    return { reversed, skipped };
  }

  @ReversesAlbumChange(AlbumChangeKind.AssetAdded)
  static async reverseAssets(tx: Transaction<DB>, changes: AlbumChangeRow[]): Promise<AlbumChangeReversal> {
    return {
      ...(await new AlbumMergeRepository(tx).reverseMemberships(changes)),
      membershipAlbumIds: [...new Set(changes.flatMap(({ albumId }) => albumId ?? []))],
    };
  }

  @ReversesAlbumChange(AlbumChangeKind.BookmarkAdded)
  static reverseBookmarks(tx: Transaction<DB>, changes: AlbumChangeRow[]): Promise<AlbumChangeReversal> {
    return new AlbumMergeRepository(tx).reverseBookmarks(changes);
  }

  @ReversesAlbumChange(AlbumChangeKind.ActivityMoved)
  static reverseActivity(tx: Transaction<DB>, changes: AlbumChangeRow[]): Promise<AlbumChangeReversal> {
    return new AlbumMergeRepository(tx).reverseActivity(changes);
  }

  @ReversesAlbumChange(AlbumChangeKind.SourceLinkMoved)
  static async reverseSourceLinks(tx: Transaction<DB>, changes: AlbumChangeRow[]): Promise<AlbumChangeReversal> {
    const links = new AlbumSourceRepository(tx);
    let reversed = 0;
    const skipped: string[] = [];
    for (const change of changes) {
      if (!change.albumId) {
        continue;
      }
      const { linkId, name } = change.after as { linkId: string; name: string };
      const { albumId: original } = change.before as { albumId: string };
      if (await links.moveBack(tx, linkId, change.albumId, original)) {
        await links.restoreMemberships(tx, linkId, original);
        reversed += 1;
      } else {
        skipped.push(name);
      }
    }
    return { reversed, skipped };
  }

  @ReversesAlbumChange(AlbumChangeKind.ICloudAlbumMoved)
  static reverseICloudAlbums(tx: Transaction<DB>, changes: AlbumChangeRow[]): Promise<AlbumChangeReversal> {
    return new AlbumMergeRepository(tx).reverseICloudAlbums(changes);
  }

  @ReversesAlbumChange(AlbumChangeKind.TakeoutFolderMoved)
  static reverseTakeoutFolders(tx: Transaction<DB>, changes: AlbumChangeRow[]): Promise<AlbumChangeReversal> {
    return new AlbumMergeRepository(tx).reverseTakeoutFolders(changes);
  }

  @ReversesAlbumChange(AlbumChangeKind.ChoiceMoved)
  static reverseChoices(tx: Transaction<DB>, changes: AlbumChangeRow[]): Promise<AlbumChangeReversal> {
    return new AlbumMergeRepository(tx).reverseChoices(changes);
  }

  @ReversesAlbumChange(AlbumChangeKind.LockChanged)
  static reverseLock(tx: Transaction<DB>, changes: AlbumChangeRow[]): Promise<AlbumChangeReversal> {
    return new AlbumMergeRepository(tx).reverseLock(changes);
  }

  @ReversesAlbumChange(AlbumChangeKind.SoftDeleted)
  static reverseSoftDelete(tx: Transaction<DB>, changes: AlbumChangeRow[]): Promise<AlbumChangeReversal> {
    return new AlbumMergeRepository(tx).reverseSoftDelete(changes);
  }

  async getPreview(auth: AuthDto, id: string, otherId: string): Promise<AlbumMergePreviewResponseDto> {
    const [album, other] = await this.loadPair(auth, id, otherId);
    const counts = await this.albumRepository.getOwnerAssetCounts([album.id, other.id], auth.user.id);
    const { winner, loser } = chooseMergeWinner(album, other, counts);
    const [{ total, inBoth }, spaceLinked] = await Promise.all([
      this.albumRepository.getMergeCounts(album.id, other.id, {
        ...getHiddenContentQueryOptions(auth),
        ...getLockedVisibilityOptions(auth),
        ...getOthersRulesQueryOptions(auth),
      }),
      this.albumRepository.getLinkedToSpaceIds([album.id, other.id]),
    ]);
    return {
      winnerId: winner.id,
      total,
      inBoth,
      winnerShared: sharedWithOthers(winner) || spaceLinked.has(winner.id),
      loserShared: sharedWithOthers(loser) || spaceLinked.has(loser.id),
    };
  }

  async merge(auth: AuthDto, id: string, dto: AlbumMergeDto): Promise<AlbumMergeResponseDto> {
    const pair = await this.loadPair(auth, id, dto.otherId);
    const { runId, winner, loser, added } = await this.albumChangeRunRepository.transaction(async (tx) => {
      const runId = await this.albumChangeRunRepository.createRun(tx, {
        userId: auth.user.id,
        kind: AlbumChangeRunKind.Merge,
      });
      const result = await this.mergeInto(tx, auth, runId, id, dto.otherId);
      await this.albumChangeRunRepository.finishRun(tx, runId, AlbumChangeRunStatus.Done, {
        winnerId: result.winner.id,
        winnerName: result.winner.albumName,
        loserId: result.loser.id,
        loserName: result.loser.albumName,
        added: result.added,
      });
      return { runId, ...result };
    });

    const members = pair.flatMap(({ id: albumId, albumUsers }) =>
      albumId === loser.id || albumId === winner.id
        ? [{ id: albumId, userIds: albumUsers.map(({ user }) => user.id) }]
        : [],
    );
    await this.afterMerge(winner.id, members, added);
    return { runId, winnerId: winner.id };
  }

  /** Merge many albums into `id`, which stays whatever its size: one run, so one Undo brings them all back. */
  async mergeMany(auth: AuthDto, id: string, dto: AlbumMergeIntoDto): Promise<AlbumMergeResponseDto> {
    // Choosing the album that stays among the ones to merge is fine; it is simply not merged with itself.
    const otherIds = [...new Set(dto.otherIds)].filter((otherId) => otherId !== id);
    if (otherIds.length === 0) {
      throw new BadRequestException('Choose at least one other album to merge');
    }
    // ponytail: one pair check per album (a few queries each); fine for the 100 the DTO allows.
    const pairs = [];
    for (const otherId of otherIds) {
      pairs.push(await this.loadPair(auth, id, otherId));
    }
    const { runId, winner, losers, added } = await this.albumChangeRunRepository.transaction(async (tx) => {
      const runId = await this.albumChangeRunRepository.createRun(tx, {
        userId: auth.user.id,
        kind: AlbumChangeRunKind.Merge,
      });
      let added = 0;
      const losers: MergeAlbumRow[] = [];
      let winner: MergeAlbumRow | undefined;
      for (const otherId of otherIds) {
        const result = await this.mergeInto(tx, auth, runId, id, otherId, true);
        winner = result.winner;
        losers.push(result.loser);
        added += result.added;
      }
      await this.albumChangeRunRepository.finishRun(tx, runId, AlbumChangeRunStatus.Done, {
        winnerId: id,
        winnerName: winner!.albumName,
        loserIds: losers.map((loser) => loser.id),
        loserNames: losers.map((loser) => loser.albumName),
        added,
      });
      return { runId, winner: winner!, losers, added };
    });

    const loserIds = new Set(losers.map((loser) => loser.id));
    const members = new Map<string, string[]>();
    for (const { id: albumId, albumUsers } of pairs.flat()) {
      if (albumId === winner.id || loserIds.has(albumId)) {
        members.set(
          albumId,
          albumUsers.map(({ user }) => user.id),
        );
      }
    }
    await this.afterMerge(
      winner.id,
      [...members].map(([albumId, userIds]) => ({ id: albumId, userIds })),
      added,
    );
    return { runId, winnerId: winner.id };
  }

  /**
   * One merge inside a run, in the caller's transaction, so cleanup can do many in one record. Re-reads both
   * albums and decides the winner under the locks: what the preview showed may be out of date.
   */
  async mergeInto(
    tx: Transaction<DB>,
    auth: AuthDto,
    runId: string,
    id: string,
    otherId: string,
    /** `id` stays whatever its size ("Merge into…" a chosen album). */
    keepFirst = false,
  ): Promise<{ winner: MergeAlbumRow; loser: MergeAlbumRow; added: number }> {
    await lockAlbumHierarchy(tx);
    const merge = new AlbumMergeRepository(tx);
    const albums = new AlbumRepository(tx);
    const links = new AlbumSourceRepository(tx);
    const runs = this.runs;

    const [first, second] = await merge.lockPair(id, otherId, auth.user.id);
    const { winner, loser } = keepFirst
      ? first.id === id
        ? { winner: first, loser: second }
        : { winner: second, loser: first }
      : chooseMergeWinner(first, second, await albums.getOwnerAssetCounts([id, otherId], auth.user.id));

    // Nested inside the album going away, the winner would disappear with it.
    if (await merge.isInside(loser.id, winner.id)) {
      await albums.reparentIn(tx, winner.id, loser.parentId);
      await runs.recordChange(tx, runId, {
        kind: AlbumChangeKind.ParentChanged,
        albumId: winner.id,
        before: { parentId: winner.parentId },
        after: { parentId: loser.parentId },
      });
    }

    const added = await merge.copyMemberships(runId, loser.id, winner.id);
    await merge.copyBookmarks(runId, loser.id, winner.id);
    await merge.moveActivity(runId, loser.id, winner.id);

    for (const childId of await merge.getChildIds(loser.id)) {
      await albums.reparentIn(tx, childId, winner.id);
      await runs.recordChange(tx, runId, {
        kind: AlbumChangeKind.ParentChanged,
        albumId: childId,
        before: { parentId: loser.id },
        after: { parentId: winner.id },
      });
    }

    const moved = await links.moveToAlbum(tx, loser.id, winner.id);
    await links.followCopiedMemberships(
      tx,
      moved.map(({ id: linkId }) => linkId),
      winner.id,
      runId,
    );
    for (const { id: linkId, lastSourceName } of moved) {
      await runs.recordChange(tx, runId, {
        kind: AlbumChangeKind.SourceLinkMoved,
        albumId: winner.id,
        before: { albumId: loser.id },
        after: { linkId, name: lastSourceName },
      });
    }

    for (const source of await merge.getICloudAlbums(loser.id)) {
      const { syncAddedAssetIds } = await merge.moveICloudAlbum(runId, source, loser.id, winner.id);
      await runs.recordChange(tx, runId, {
        kind: AlbumChangeKind.ICloudAlbumMoved,
        albumId: winner.id,
        before: { ...source, albumId: loser.id, syncAddedAssetIds },
      });
    }
    for (const folder of await merge.moveTakeoutFolders(loser.id, winner.id)) {
      await runs.recordChange(tx, runId, {
        kind: AlbumChangeKind.TakeoutFolderMoved,
        albumId: winner.id,
        before: { albumId: loser.id },
        after: folder,
      });
    }
    for (const change of await merge.moveChoices(loser.id, winner.id, auth.user.id)) {
      await runs.recordChange(tx, runId, change);
    }

    // Locked only if every album in the merge was: a locked album locks what it is given, and that would pull
    // the other album's ordinary photos out of the Timeline.
    if (winner.isLocked && !loser.isLocked) {
      await merge.setLocked(winner.id, false);
      await runs.recordChange(tx, runId, {
        kind: AlbumChangeKind.LockChanged,
        albumId: winner.id,
        before: { isLocked: true },
        after: { isLocked: false },
      });
    }

    const deletedAt = await merge.softDelete(loser.id);
    await runs.recordChange(tx, runId, {
      kind: AlbumChangeKind.SoftDeleted,
      albumId: loser.id,
      before: { deletedAt: null },
      after: { deletedAt },
    });

    return { winner, loser, added };
  }

  /** A run's soft-deleted albums go for good once the Undo window has closed. */
  @OnEvent({ name: 'NightlyDatabaseCleanup', workers: [FrameleafWorker.Microservices] })
  async onNightlyDatabaseCleanup(): Promise<void> {
    await this.runs.purgeExpiredRuns();
  }

  /** The two albums, once the person may merge them: both theirs, plain albums, not the same one. */
  private async loadPair(auth: AuthDto, id: string, otherId: string) {
    if (id === otherId) {
      throw new BadRequestException('An album cannot be merged with itself');
    }
    await this.requireAccess({ auth, permission: Permission.AlbumDelete, ids: [id, otherId] });
    const albums = await Promise.all(
      [id, otherId].map((albumId) => this.albumRepository.getById(albumId, { withAssets: false }, auth.user.id)),
    );
    const pair = albums.filter((album) => album !== undefined);
    if (pair.length !== 2) {
      throw new BadRequestException('Both albums must be yours and still exist');
    }
    if (pair.some((album) => asAlbumKind(album.kind) !== AlbumKind.Album)) {
      throw new BadRequestException('Only albums can be merged, not collections or shared spaces');
    }
    const [builtIn, ruled, origins] = await Promise.all([
      this.smartAlbumRepository.getSmartBackedAlbumKinds([id, otherId]),
      this.classificationRepository.getRuleAlbumIds([id, otherId]),
      this.partnerOriginRepository.getOriginLabels('album', [id, otherId], auth.user.id),
    ]);
    if (builtIn.size > 0 || ruled.size > 0) {
      throw new BadRequestException('Smart albums cannot be merged');
    }
    if (origins.size > 0) {
      throw new BadRequestException('An album shared from a partner follows theirs, so it cannot be merged');
    }
    return pair;
  }

  private async afterMerge(
    winnerId: string,
    members: { id: string; userIds: string[] }[],
    added: number,
  ): Promise<void> {
    await this.albumRepository.updateThumbnails([winnerId]);
    if (added > 0) {
      await recordAlbumEdit(
        { partnerOrigin: this.partnerOriginRepository, job: this.jobRepository },
        [winnerId],
        [AlbumOriginField.Membership],
      );
    }
    for (const { id, userIds } of members) {
      // Open pages re-read the album; a merge sends no email.
      await this.eventRepository.emit('AlbumUpdate', { id, userIds, recipientIds: [] });
    }
  }
}
