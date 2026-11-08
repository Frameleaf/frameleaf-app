import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Kysely, Transaction } from 'kysely';
import type { AlbumChangeRunResponseDto, AlbumChangeUndoResponseDto } from 'src/dtos/album-merge.dto.js';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { DB } from 'src/schema/index.js';
import type {
  AlbumChangeInput,
  AlbumChangeReversal,
  AlbumChangeRow,
} from 'src/repositories/album-change-run.repository.js';
import { AlbumOriginField } from 'src/repositories/partner-origin.repository.js';
import { lockAlbumHierarchy } from 'src/repositories/album.repository.js';
import { AlbumChangeRunStatus } from 'src/schema/tables/album-change-run.table.js';
import { BaseService } from 'src/services/base.service.js';
import { recordAlbumEdit } from 'src/services/partner-copy.service.js';

export const ALBUM_CHANGE_UNDO_DAYS = 30;
const DAY_MS = 86_400_000;
/** Changes read per step while undoing; undoing a large merge walks thousands of them. */
const UNDO_PAGE_SIZE = 5000;

export type AlbumChangeReverser = (
  tx: Transaction<DB>,
  changes: AlbumChangeRow[],
  context: { auth: AuthDto; runId: string },
) => Promise<AlbumChangeReversal>;

const reversers = new Map<string, AlbumChangeReverser>();

/**
 * Undoes one kind of change. Parts of a run (merge, cleanup, date healing) register theirs when their
 * module loads, so a new kind needs nothing from the runner. Registered once per kind.
 */
export const registerAlbumChangeReverser = (kind: string, reverser: AlbumChangeReverser): void => {
  if (reversers.has(kind)) {
    throw new Error(`Album change kind ${kind} already has a reverser`);
  }
  reversers.set(kind, reverser);
};

/** Consecutive changes of one kind, reversed together, in the order they will run. */
const groupByKind = (changes: AlbumChangeRow[]): AlbumChangeRow[][] => {
  const groups: AlbumChangeRow[][] = [];
  for (const change of changes) {
    const group = groups.at(-1);
    if (group && group[0].kind === change.kind) {
      group.push(change);
    } else {
      groups.push([change]);
    }
  }
  return groups;
};

/**
 * FL-1298: the record of what a merge, cleanup or date healing changed, and undoing it. Runs undo newest
 * first and only the latest can be undone at any time. A later edit wins: each reverser leaves alone
 * anything changed since the run and reports what it skipped.
 */
@Injectable()
export class AlbumChangeRunService extends BaseService {
  /** Adds one change to a run, inside the transaction that made the change. */
  recordChange(tx: Kysely<DB>, runId: string, change: AlbumChangeInput): Promise<number> {
    return this.albumChangeRunRepository.recordChange(tx, runId, change);
  }

  async getLatest(auth: AuthDto): Promise<{ run: AlbumChangeRunResponseDto | null }> {
    const run = await this.albumChangeRunRepository.getLatest(auth.user.id, this.undoFloor());
    if (!run) {
      return { run: null };
    }
    return {
      run: {
        id: run.id,
        kind: run.kind,
        status: run.status,
        createdAt: new Date(run.createdAt).toISOString(),
        canUndo: run.status !== AlbumChangeRunStatus.Running,
        summary: run.summary,
      },
    };
  }

  async undoLatest(auth: AuthDto): Promise<AlbumChangeUndoResponseDto> {
    const touched = new Set<string>();
    const membership = new Set<string>();
    const outcome = await this.albumChangeRunRepository.transaction(async (tx) => {
      // Moving an album back rewrites the hierarchy, and a second Undo must wait for this one.
      await lockAlbumHierarchy(tx);
      const run = await this.albumChangeRunRepository.getLatestForUpdate(tx, auth.user.id, this.undoFloor());
      if (!run) {
        throw new NotFoundException('There is nothing to undo');
      }
      if (run.status === AlbumChangeRunStatus.Running) {
        throw new ConflictException('This change is still being made');
      }

      let reversed = 0;
      const skipped = new Set<string>();
      let beforeSeq: number | undefined;
      for (;;) {
        const page = await this.albumChangeRunRepository.getChanges(run.id, beforeSeq, UNDO_PAGE_SIZE, tx);
        if (page.length === 0) {
          break;
        }
        for (const group of groupByKind(page)) {
          const reverser = reversers.get(group[0].kind);
          if (!reverser) {
            throw new Error(`No reverser is registered for album change kind ${group[0].kind}`);
          }
          const reversal = await reverser(tx, group, { auth, runId: run.id });
          reversed += reversal.reversed;
          for (const name of reversal.skipped) {
            skipped.add(name);
          }
          for (const albumId of reversal.membershipAlbumIds ?? []) {
            membership.add(albumId);
          }
          for (const { albumId } of group) {
            if (albumId) {
              touched.add(albumId);
            }
          }
        }
        beforeSeq = page.at(-1)!.seq;
      }
      await this.albumChangeRunRepository.markUndone(tx, run.id);
      return { reversed, skipped: [...skipped] };
    });

    await this.afterUndo([...touched], [...membership]);
    return outcome;
  }

  /** Forgets runs past the Undo window. Their soft-deleted albums go first, in the caller's own transactions. */
  async purgeExpiredRuns(): Promise<void> {
    const floor = this.undoFloor();
    for (const albumId of await this.albumChangeRunRepository.getPurgeableAlbumIds(floor)) {
      await this.albumRepository.delete(albumId);
    }
    await this.albumChangeRunRepository.deleteRunsBefore(floor);
  }

  private undoFloor(): Date {
    return new Date(Date.now() - ALBUM_CHANGE_UNDO_DAYS * DAY_MS);
  }

  /** Covers, members' open pages, and partners following an album; none of it can undo the Undo. */
  private async afterUndo(albumIds: string[], membershipAlbumIds: string[]): Promise<void> {
    if (albumIds.length === 0) {
      return;
    }
    await this.albumRepository.updateThumbnails(albumIds);
    await recordAlbumEdit(
      { partnerOrigin: this.partnerOriginRepository, job: this.jobRepository },
      membershipAlbumIds,
      [AlbumOriginField.Membership],
    );
    const members = Map.groupBy(
      await this.albumChangeRunRepository.getAlbumMembers(albumIds),
      ({ albumId }) => albumId,
    );
    for (const [id, rows] of members) {
      await this.eventRepository.emit('AlbumUpdate', {
        id,
        userIds: rows.map(({ userId }) => userId),
        recipientIds: [],
      });
    }
  }
}
