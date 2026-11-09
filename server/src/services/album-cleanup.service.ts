import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Kysely, Transaction } from 'kysely';
import type {
  AlbumCleanupApplyDto,
  AlbumCleanupApplyResponseDto,
  AlbumCleanupFacts,
  AlbumCleanupOperation,
  AlbumCleanupSnapshotResponseDto,
  AlbumCleanupStatusResponseDto,
} from 'src/dtos/album-cleanup.dto.js';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { AlbumChangeReversal, AlbumChangeRow } from 'src/repositories/album-change-run.repository.js';
import type { CleanupAlbumRow, CleanupCollectionRow } from 'src/repositories/album-cleanup.repository.js';
import type { AlbumReadOptions } from 'src/repositories/album.repository.js';
import type { DB } from 'src/schema/index.js';
import type { JobOf } from 'src/types.js';
import { OnJob } from 'src/decorators.js';
import { AlbumKind, AlbumUserRole, JobName, JobStatus, QueueName } from 'src/enum.js';
import { AlbumChangeKind, AlbumMergeRepository } from 'src/repositories/album-merge.repository.js';
import { AlbumSourceRepository } from 'src/repositories/album-source.repository.js';
import { MAX_HEAL_PHOTOS } from 'src/repositories/album-suggestion.repository.js';
import { AlbumRepository, lockAlbumHierarchy } from 'src/repositories/album.repository.js';
import { AlbumOriginField } from 'src/repositories/partner-origin.repository.js';
import { AlbumChangeRunKind, AlbumChangeRunStatus } from 'src/schema/tables/album-change-run.table.js';
import { AlbumCleanupVariant } from 'src/schema/tables/album-cleanup-snapshot.table.js';
import { ReversesAlbumChange } from 'src/services/album-change-run.service.js';
import { AlbumDateHealService } from 'src/services/album-date-heal.service.js';
import { AlbumMergeService, chooseMergeWinner } from 'src/services/album-merge.service.js';
import { BaseService } from 'src/services/base.service.js';
import { recordAlbumEdit } from 'src/services/partner-copy.service.js';
import {
  CLEANUP_APPLY_STALLED_MINUTES,
  CLEANUP_MAX_LOST_DATES_PER_ALBUM,
  CLEANUP_SCAN_STALE_HOURS,
  SAME_PHOTOS_MIN_SHARED,
  SAME_PHOTOS_SHARE,
  albumNameKey,
  albumPlaceKey,
  countCleanupSuggestions,
  detectHomeAreas,
  hasCurrentAlbumFacts,
  isDateOnlyName,
} from 'src/utils/album-cleanup.js';
import { healDates, suspiciousDate } from 'src/utils/album-suggestions.js';
import { hasHiddenContentFilter } from 'src/utils/hidden-content.js';
import { getLockedOwnerId } from 'src/utils/locked.js';
import { getPreferences } from 'src/utils/preferences.js';

/** The kinds of change a cleanup adds to those a merge records. Undo walks a run backwards. */
export const AlbumCleanupChangeKind = {
  Renamed: 'album.renamed',
  CollectionCreated: 'album.collection_created',
  SourceStayRemoved: 'album.source_stay_removed',
} as const;

/** Healing first, because the structure depends on those dates; moves last, onto what the run made. */
const OPERATION_ORDER: AlbumCleanupOperation['type'][] = [
  'heal',
  'createCollection',
  'merge',
  'combine',
  'rename',
  'move',
  'remove',
];

const DAY_MS = 86_400_000;
const serialDay = (date: Date) => Math.floor(date.getTime() / DAY_MS);
const variantOf = (auth: AuthDto) =>
  getLockedOwnerId(auth) ? AlbumCleanupVariant.Elevated : AlbumCleanupVariant.Ordinary;

/** The work of one run, kept as the job goes: what each reference now means and what has been done. */
type ApplyContext = {
  auth: AuthDto;
  runId: string;
  candidates: Map<string, CleanupAlbumRow>;
  collections: CleanupCollectionRow[];
  targets: Record<string, string>;
  tally: Record<string, number>;
};

/** Who keeps their name and icon in a group of albums: the same rule as a two-way merge, applied in turn. */
const largestByTrueCount = (albums: CleanupAlbumRow[], counts: Map<string, number>): CleanupAlbumRow => {
  let best = albums[0];
  for (const album of albums.slice(1)) {
    best = chooseMergeWinner(best, album, counts).winner;
  }
  return best;
};

const add = (tally: Record<string, number>, key: string, amount = 1) => {
  tally[key] = (tally[key] ?? 0) + amount;
};

/** A later change made this operation impossible, and only this operation: the rest of the cleanup carries on. */
/** The run ended while its job was still working: an operation in progress is taken back and the job stops. */
class ApplyStopped extends Error {}

const isSkippable = (error: unknown) =>
  error instanceof BadRequestException || error instanceof ConflictException || error instanceof NotFoundException;

/**
 * FL-1300: Magic Albums cleanup. A background scan writes per-album facts; the browser plans against them so every
 * control answers instantly; the server checks the explicit operations that come back and applies them as a job
 * that can resume after a restart. Every change is recorded in the run Undo reads.
 */
@Injectable()
export class AlbumCleanupService extends BaseService {
  private get merges() {
    return BaseService.create(AlbumMergeService, this);
  }

  private get heals() {
    return BaseService.create(AlbumDateHealService, this);
  }

  /** A later rename wins. */
  @ReversesAlbumChange(AlbumCleanupChangeKind.Renamed)
  static async reverseRenames(tx: Transaction<DB>, changes: AlbumChangeRow[]): Promise<AlbumChangeReversal> {
    let reversed = 0;
    const skipped: string[] = [];
    for (const change of changes) {
      if (!change.albumId) {
        continue;
      }
      const { albumName } = change.before as { albumName: string };
      const { albumName: expected } = change.after as { albumName: string };
      const album = await tx
        .updateTable('album')
        .set({ albumName })
        .where('id', '=', change.albumId)
        .where('albumName', '=', expected)
        .where('deletedAt', 'is', null)
        .returning('id')
        .executeTakeFirst();
      if (album) {
        reversed += 1;
      } else {
        const current = await tx
          .selectFrom('album')
          .select('albumName')
          .where('id', '=', change.albumId)
          .where('deletedAt', 'is', null)
          .executeTakeFirst();
        if (current) {
          skipped.push(current.albumName);
        }
      }
    }
    return { reversed, skipped };
  }

  /** A collection the run made goes only if the run's albums were all that was in it. */
  @ReversesAlbumChange(AlbumCleanupChangeKind.CollectionCreated)
  static async reverseCreatedCollections(tx: Transaction<DB>, changes: AlbumChangeRow[]): Promise<AlbumChangeReversal> {
    const repository = new AlbumRepository(tx);
    let reversed = 0;
    const skipped: string[] = [];
    for (const change of changes) {
      if (!change.albumId) {
        continue;
      }
      const album = await tx
        .selectFrom('album')
        .select(['albumName'])
        .where('id', '=', change.albumId)
        .where('deletedAt', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!album) {
        continue;
      }
      const child = await tx
        .selectFrom('album')
        .select('id')
        .where('parentId', '=', change.albumId)
        .where('deletedAt', 'is', null)
        .executeTakeFirst();
      const { albumName } = change.after as { albumName: string };
      if (child || album.albumName !== albumName) {
        skipped.push(album.albumName);
        continue;
      }
      await repository.deleteIn(tx, change.albumId);
      reversed += 1;
    }
    return { reversed, skipped };
  }

  @ReversesAlbumChange(AlbumCleanupChangeKind.SourceStayRemoved)
  static async reverseStayRemoved(tx: Transaction<DB>, changes: AlbumChangeRow[]): Promise<AlbumChangeReversal> {
    const links = new AlbumSourceRepository(tx);
    let reversed = 0;
    for (const change of changes) {
      const { linkIds } = change.after as { linkIds: string[] };
      reversed += await links.clearStayRemoved(tx, linkIds);
    }
    return { reversed, skipped: [] };
  }

  async getStatus(auth: AuthDto): Promise<AlbumCleanupStatusResponseDto> {
    const [snapshot, latest] = await Promise.all([
      this.albumCleanupRepository.getSnapshotSummary(auth.user.id, variantOf(auth)),
      this.albumCleanupRepository.getLatestApply(auth.user.id),
    ]);
    await this.scanWhenStale(auth.user.id, snapshot?.computedAt);

    let status = latest?.status;
    if (latest && status === AlbumChangeRunStatus.Running && (await this.failIfAbandoned(latest))) {
      status = AlbumChangeRunStatus.Failed;
    }

    return {
      ready: !!snapshot,
      computedAt: snapshot ? new Date(snapshot.computedAt).toISOString() : null,
      suggestionCount: snapshot?.suggestionCount ?? 0,
      apply: latest
        ? {
            runId: latest.runId,
            status: status!,
            done: latest.nextIndex,
            total: latest.total,
          }
        : null,
    };
  }

  async getSnapshot(auth: AuthDto): Promise<AlbumCleanupSnapshotResponseDto> {
    const stored = await this.albumCleanupRepository.getSnapshot(auth.user.id, variantOf(auth));
    // A snapshot from before the facts changed shape is treated as missing, so a fresh scan replaces it.
    const snapshot = stored && hasCurrentAlbumFacts(stored.facts.albums) ? stored : undefined;
    await this.scanWhenStale(auth.user.id, snapshot?.computedAt);
    if (!snapshot) {
      return { ready: false, computedAt: null, suggestionCount: 0, facts: null };
    }
    return {
      ready: true,
      computedAt: new Date(snapshot.computedAt).toISOString(),
      suggestionCount: snapshot.suggestionCount,
      facts: snapshot.facts,
    };
  }

  private async scanWhenStale(userId: string, computedAt: Date | undefined): Promise<void> {
    const stale = !computedAt || Date.now() - new Date(computedAt).getTime() > CLEANUP_SCAN_STALE_HOURS * 3_600_000;
    if (stale) {
      await this.jobRepository.queue({ name: JobName.AlbumCleanupScan, data: { userId } });
    }
  }

  /**
   * A run with no recent progress and no job left to make any (the queue was emptied) has ended: what it did stays
   * done, and Undo has to be reachable. A job still queued or running keeps its run, however long it takes.
   */
  private async failIfAbandoned({ runId, progressAt }: { runId: string; progressAt: Date }): Promise<boolean> {
    if (Date.now() - new Date(progressAt).getTime() <= CLEANUP_APPLY_STALLED_MINUTES * 60_000) {
      return false;
    }
    if (await this.jobRepository.findOpenJob(QueueName.BackgroundTask, JobName.AlbumCleanupApply, runId)) {
      return false;
    }
    return this.albumChangeRunRepository.transaction(async (tx) => {
      const running = await this.albumCleanupRepository.holdIfRunning(tx, runId);
      if (running) {
        await this.albumChangeRunRepository.finishRun(tx, runId, AlbumChangeRunStatus.Failed);
      }
      return running;
    });
  }

  /** The albums the cleanup may change: owned and plain, at any depth. */
  private async loadCandidates(userId: string): Promise<CleanupAlbumRow[]> {
    const albums = await this.loadScanAlbums(userId);
    return albums.filter(({ readOnly }) => !readOnly);
  }

  /** Everything the review lists: the whole Albums page except smart albums. */
  private async loadScanAlbums(userId: string): Promise<CleanupAlbumRow[]> {
    const albums = await this.albumCleanupRepository.getScanAlbums(userId);
    if (albums.length === 0) {
      return [];
    }
    const ids = albums.map(({ id }) => id);
    const [builtIn, ruled] = await Promise.all([
      this.smartAlbumRepository.getSmartBackedAlbumKinds(ids),
      this.classificationRepository.getRuleAlbumIds(ids),
    ]);
    return albums.filter(({ id }) => !builtIn.has(id) && !ruled.has(id));
  }

  @OnJob({ name: JobName.AlbumCleanupScan, queue: QueueName.BackgroundTask })
  async handleScan({ userId }: JobOf<JobName.AlbumCleanupScan>): Promise<JobStatus> {
    const [scanned, collections, metadata] = await Promise.all([
      this.loadScanAlbums(userId),
      this.albumCleanupRepository.getCollections(userId),
      this.userRepository.getMetadata(userId),
    ]);
    const albums = scanned.filter(({ readOnly }) => !readOnly);
    const readOnly = scanned.filter((album) => album.readOnly);
    const filter = { userId, includeNsfw: false, ...getPreferences(metadata).privacy.suppression };
    const ordinary: AlbumReadOptions = {
      ...(hasHiddenContentFilter(filter) ? { hiddenContent: filter } : {}),
      othersRulesViewerId: userId,
    };
    const elevated: AlbumReadOptions = {
      lockedOwnerId: userId,
      revealLockedOwnerId: userId,
      othersRulesViewerId: userId,
    };
    const ids = albums.map(({ id }) => id);
    const [trueCounts, withLocked] = await Promise.all([
      this.albumRepository.getOwnerAssetCounts(ids, userId),
      ids.length > 0 ? this.albumCleanupRepository.getAlbumsWithLocked(ids) : Promise.resolve(new Set<string>()),
    ]);

    const computedAt = new Date();
    const { facts: ordinaryFacts, healSkippedIds } = await this.scanVariant({
      userId,
      albums,
      readOnly,
      collections,
      trueCounts,
      options: ordinary,
    });
    await this.save(userId, AlbumCleanupVariant.Ordinary, ordinaryFacts, computedAt);
    const { facts: elevatedFacts } = await this.scanVariant({
      userId,
      albums,
      readOnly,
      collections,
      trueCounts,
      options: elevated,
      // Hidden people and tags also differ between the two variants, so only a person without any can reuse the read.
      reuse: ordinary.hiddenContent ? undefined : { facts: ordinaryFacts, healSkippedIds, withLocked },
    });
    await this.save(userId, AlbumCleanupVariant.Elevated, elevatedFacts, computedAt);
    return JobStatus.Success;
  }

  private async save(userId: string, variant: AlbumCleanupVariant, facts: AlbumCleanupFacts, computedAt: Date) {
    await this.albumCleanupRepository.saveSnapshot(userId, variant, facts, countCleanupSuggestions(facts), computedAt);
  }

  private async scanVariant({
    userId,
    albums,
    readOnly,
    collections,
    trueCounts,
    options,
    reuse,
  }: {
    userId: string;
    albums: CleanupAlbumRow[];
    readOnly: CleanupAlbumRow[];
    collections: CleanupCollectionRow[];
    trueCounts: Map<string, number>;
    options: AlbumReadOptions;
    reuse?: { facts: AlbumCleanupFacts; healSkippedIds: Set<string>; withLocked: Set<string> };
  }): Promise<{ facts: AlbumCleanupFacts; healSkippedIds: Set<string> }> {
    const ids = albums.map(({ id }) => id);
    const listed = [...albums, ...readOnly];
    const listedIds = listed.map(({ id }) => id);
    const structure = collections.map(({ id, name, parentId, createdAt }) => ({
      id,
      name,
      parentId,
      createdAt: new Date(createdAt).toISOString(),
    }));
    if (listedIds.length === 0) {
      return {
        facts: {
          albums: [],
          collections: structure,
          sameName: [],
          samePhotos: [],
          sameTrip: [],
          homeAreas: [],
          lostDates: [],
          healSkipped: 0,
        },
        healSkippedIds: new Set(),
      };
    }

    const repository = this.albumCleanupRepository;
    const [stats, locations, overlaps, bins, covers] = await Promise.all([
      repository.getAlbumStats(listedIds, options),
      repository.getAlbumLocations(ids, options),
      repository.getOverlaps(ids, options),
      repository.getHomeBins(userId, options),
      repository.getVisibleCovers(listedIds, options),
    ]);

    const statsById = new Map(stats.map((row) => [row.albumId, row]));
    const topCity = new Map<string, (typeof locations)[number]>();
    for (const row of locations) {
      const current = topCity.get(row.albumId);
      if (!current || row.count > current.count || (row.count === current.count && row.city! < current.city!)) {
        topCity.set(row.albumId, row);
      }
    }

    const facts = listed.map((album) => {
      const stat = statsById.get(album.id);
      const place = topCity.get(album.id);
      return {
        id: album.id,
        name: album.name,
        count: stat?.count ?? 0,
        createdAt: new Date(album.createdAt).toISOString(),
        locked: album.isLocked,
        shared: album.shared,
        parentId: album.parentId,
        readOnly: album.readOnly,
        gps:
          place && stat && stat.located > 0
            ? { city: place.city!, share: place.count / stat.located, lat: place.lat, lon: place.lon }
            : null,
        span:
          stat?.from && stat.to && stat.middle
            ? { from: serialDay(stat.from), to: serialDay(stat.to), middle: serialDay(stat.middle) }
            : null,
        coverAssetId: covers.get(album.id) ?? null,
      };
    });
    const factById = new Map(facts.map((fact) => [fact.id, fact]));
    const nameOf = (id: string) => albumNameKey(factById.get(id)!.name);
    const winner = (group: CleanupAlbumRow[]) => largestByTrueCount(group, trueCounts);

    // Rule 5: exact-name duplicates, side by side. "Day 1" in two different collections is two different days.
    const byName = Map.groupBy(albums, ({ name, parentId }) => albumPlaceKey(name, parentId));
    const duplicateGroups = [...byName].filter(([, group]) => group.length > 1);
    const unions = await repository.getUnionCounts(
      duplicateGroups.map(([key, group]) => ({ key, albumIds: group.map(({ id }) => id) })),
      options,
    );
    const sameName = duplicateGroups.map(([key, group]) => ({
      key,
      albumIds: group.map(({ id }) => id),
      winnerId: winner(group).id,
      union: unions.get(key) ?? 0,
    }));

    // Rule 7: the same photos under different names, measured against the smaller album.
    const rowById = new Map(albums.map((row) => [row.id, row]));
    const album = (id: string) => rowById.get(id)!;
    const overlapOf = new Map(overlaps.map(({ firstId, secondId, shared }) => [`${firstId}+${secondId}`, shared]));
    const samePhotos = overlaps.flatMap(({ firstId, secondId, shared }) => {
      const first = factById.get(firstId)!;
      const second = factById.get(secondId)!;
      const smaller = Math.min(first.count, second.count);
      if (
        smaller === 0 ||
        shared < SAME_PHOTOS_MIN_SHARED ||
        shared / smaller < SAME_PHOTOS_SHARE ||
        nameOf(firstId) === nameOf(secondId) ||
        album(firstId).parentId !== album(secondId).parentId
      ) {
        return [];
      }
      return [
        {
          firstId,
          secondId,
          winnerId: chooseMergeWinner(album(firstId), album(secondId), trueCounts).winner.id,
          share: shared / smaller,
          union: first.count + second.count - shared,
        },
      ];
    });

    // Rule 14: same dates in the same place, with no photos in common.
    const located = facts.filter((fact) => fact.gps && fact.span);
    const byTrip = Map.groupBy(located, (fact) => `${fact.span!.from}|${fact.span!.to}|${fact.gps!.city}`);
    const sameTrip = byTrip
      .values()
      .flatMap((group) => {
        if (group.length < 2) {
          return [];
        }
        const lead = winner(group.map(({ id }) => album(id)));
        return group.flatMap((other) => {
          if (
            other.id === lead.id ||
            nameOf(other.id) === nameOf(lead.id) ||
            album(other.id).parentId !== lead.parentId
          ) {
            return [];
          }
          const [firstId, secondId] = lead.id < other.id ? [lead.id, other.id] : [other.id, lead.id];
          if (overlapOf.get(`${firstId}+${secondId}`)) {
            return [];
          }
          return [
            { firstId, secondId, winnerId: lead.id, share: 0, union: factById.get(lead.id)!.count + other.count },
          ];
        });
      })
      .toArray();

    // Lost dates: read only the albums holding a photo that may need it.
    const lostDates: AlbumCleanupFacts['lostDates'] = [];
    const healSkippedIds = new Set<string>();
    const candidates = await repository.getLostDateCandidates(ids, options);
    const reused = new Map(reuse?.facts.lostDates.map((entry) => [entry.albumId, entry]));
    for (const albumId of candidates) {
      if (reuse && !reuse.withLocked.has(albumId)) {
        // Nothing Locked in it, so the session with the PIN sees exactly what the one without does.
        const entry = reused.get(albumId);
        if (entry) {
          lostDates.push(entry);
        } else if (reuse.healSkippedIds.has(albumId)) {
          healSkippedIds.add(albumId);
        }
        continue;
      }
      const rows = await this.albumRepository.suggestions.getHealPhotos(
        albumId,
        userId,
        options.lockedOwnerId,
        options,
      );
      const result =
        rows.length > MAX_HEAL_PHOTOS
          ? ({ eligible: false, reason: 'wide', suggestions: [] } as const)
          : healDates(
              rows.map((row) => ({
                id: row.id,
                fileName: row.originalFileName,
                takenAt: row.takenAt,
                localDateTime: row.localDateTime,
                camera: !suspiciousDate(row.originalFileName, row.hasCameraDetails),
                estimated: row.dateEstimated,
                dateSet: row.dateSet,
                mine: row.ownerId === userId,
              })),
            );
      if (result.eligible && result.suggestions.length > 0) {
        lostDates.push({
          albumId,
          from: result.from!,
          to: result.to!,
          suggestions: result.suggestions.slice(0, CLEANUP_MAX_LOST_DATES_PER_ALBUM),
        });
      } else if (!result.eligible && result.reason === 'wide') {
        healSkippedIds.add(albumId);
      }
    }

    return {
      facts: {
        albums: facts,
        collections: structure,
        sameName,
        samePhotos,
        sameTrip,
        homeAreas: detectHomeAreas(bins),
        lostDates,
        healSkipped: healSkippedIds.size,
      },
      healSkippedIds,
    };
  }

  async apply(auth: AuthDto, dto: AlbumCleanupApplyDto): Promise<AlbumCleanupApplyResponseDto> {
    const [candidates, collections] = await Promise.all([
      this.loadCandidates(auth.user.id),
      this.albumCleanupRepository.getCollections(auth.user.id),
    ]);
    const operations = this.validated(
      dto.operations,
      new Map(candidates.map((album) => [album.id, album])),
      collections,
    );

    const runId = await this.albumChangeRunRepository.transaction(async (tx) => {
      // Two clicks at once must queue here, not both find nothing running.
      await lockAlbumHierarchy(tx);
      if (await this.albumCleanupRepository.isApplying(tx, auth.user.id)) {
        throw new ConflictException('A cleanup is already being applied');
      }
      const id = await this.albumChangeRunRepository.createRun(tx, {
        userId: auth.user.id,
        kind: AlbumChangeRunKind.Cleanup,
      });
      await this.albumCleanupRepository.createApply(tx, {
        runId: id,
        operations,
        elevated: variantOf(auth) === AlbumCleanupVariant.Elevated,
      });
      await this.jobRepository.queueInTransaction(tx, { name: JobName.AlbumCleanupApply, data: { id } });
      return id;
    });
    return { runId };
  }

  /**
   * The server checks everything the browser sent: the person owns every album, shared albums need the explicit
   * flag, and a remove is refused for anything but a date-only album that isn't shared. Returns the operations in
   * the order they will run.
   */
  private validated(
    operations: AlbumCleanupOperation[],
    candidates: Map<string, CleanupAlbumRow>,
    collections: CleanupCollectionRow[],
  ): AlbumCleanupOperation[] {
    const collectionIds = new Set(collections.map(({ id }) => id));
    const created = new Set<string>();
    const claimed = new Set<string>();
    const album = (id: string | undefined) => {
      const row = id ? candidates.get(id) : undefined;
      if (!row) {
        throw new BadRequestException('Every album must be yours, at the top level, and still exist');
      }
      return row;
    };
    const parentOf = (operation: AlbumCleanupOperation) => {
      if (operation.parentTempId && !created.has(operation.parentTempId)) {
        throw new BadRequestException('A collection must be created before it is used');
      }
      if (operation.parentId && !collectionIds.has(operation.parentId)) {
        throw new BadRequestException('Every parent must be one of your collections');
      }
    };
    const merged = new Set<string>();
    const claim = (id: string) => {
      if (merged.has(id) || claimed.has(id)) {
        throw new BadRequestException('An album cannot be removed twice, or merged and removed');
      }
      claimed.add(id);
    };

    const ordered = OPERATION_ORDER.flatMap((type) => operations.filter((operation) => operation.type === type));
    for (const operation of ordered) {
      switch (operation.type) {
        case 'createCollection': {
          if (!operation.tempId || !operation.name) {
            throw new BadRequestException('A new collection needs a reference and a name');
          }
          parentOf(operation);
          created.add(operation.tempId);
          break;
        }
        case 'move': {
          album(operation.albumId);
          parentOf(operation);
          break;
        }
        case 'rename': {
          album(operation.albumId);
          if (!operation.name) {
            throw new BadRequestException('A rename needs a name');
          }
          break;
        }
        case 'merge':
        case 'combine': {
          const members = [...new Set(operation.albumIds)];
          if (members.length < 2) {
            throw new BadRequestException('A merge needs at least two albums');
          }
          const rows = members.map((id) => album(id));
          if (rows.some(({ shared }) => shared) && !(operation.type === 'merge' && operation.allowShared)) {
            throw new BadRequestException('Shared albums are merged only when you choose to');
          }
          if (operation.type === 'combine' && !operation.name) {
            throw new BadRequestException('Combined albums need a name');
          }
          // Merges chain: an album merged by name can then be combined with its neighbours.
          for (const id of members) {
            merged.add(id);
          }
          break;
        }
        case 'heal': {
          album(operation.albumId);
          if (!operation.assetIds?.length) {
            throw new BadRequestException('Healing needs an album and its photos');
          }
          break;
        }
        case 'remove': {
          const row = album(operation.albumId);
          if (!isDateOnlyName(row.name) || row.shared) {
            throw new BadRequestException('Only an unshared album named nothing but a date can be removed');
          }
          claim(row.id);
          break;
        }
      }
    }
    return ordered;
  }

  /**
   * The operations, one transaction each, in order. `nextIndex` advances with each change, so a job that stops
   * partway keeps what it did, is still undoable, and resumes from the next operation when it runs again.
   */
  @OnJob({ name: JobName.AlbumCleanupApply, queue: QueueName.BackgroundTask })
  async handleApply({ id: runId }: JobOf<JobName.AlbumCleanupApply>): Promise<JobStatus> {
    const state = await this.albumCleanupRepository.getApply(runId);
    if (!state || state.status !== AlbumChangeRunStatus.Running) {
      return JobStatus.Skipped;
    }
    const auth = {
      user: { id: state.userId },
      session: state.elevated ? { hasElevatedPermission: true } : undefined,
    } as AuthDto;
    const [candidates, collections] = await Promise.all([
      this.loadCandidates(state.userId),
      this.albumCleanupRepository.getCollections(state.userId),
    ]);
    const context: ApplyContext = {
      auth,
      runId,
      candidates: new Map(candidates.map((album) => [album.id, album])),
      collections,
      targets: { ...state.targets },
      tally: { ...state.tally },
    };

    try {
      for (let index = state.nextIndex; index < state.operations.length; index += 1) {
        const operation = state.operations[index];
        const before = {
          targets: { ...context.targets },
          tally: { ...context.tally },
          candidates: new Map(context.candidates),
          collections: [...context.collections],
        };
        try {
          await this.inOperationTransaction(context, operation, async (tx) => {
            await this.applyOperation(tx, context, operation);
            await this.advance(tx, context, index + 1);
          });
        } catch (error) {
          if (!isSkippable(error)) {
            throw error;
          }
          this.logger.warn(`Cleanup ${runId}: operation ${index} skipped: ${error}`);
          // The transaction rolled back, so what the operation noted here goes with it.
          Object.assign(context, before);
          add(context.tally, 'skipped');
          await this.albumChangeRunRepository.transaction((tx) => this.advance(tx, context, index + 1));
        }
      }
    } catch (error) {
      if (error instanceof ApplyStopped) {
        this.logger.warn(`Cleanup ${runId}: stopped because the run has ended`);
        return JobStatus.Skipped;
      }
      // Anything else ends the run; what it did stays done and can be undone.
      await this.finish(context, AlbumChangeRunStatus.Failed);
      throw error;
    }

    await this.finish(context, this.changedAnything(context) ? AlbumChangeRunStatus.Done : AlbumChangeRunStatus.Undone);
    await this.afterApply(context);
    return JobStatus.Success;
  }

  private changedAnything({ tally }: ApplyContext): boolean {
    return Object.entries(tally).some(([key, value]) => key !== 'skipped' && value > 0);
  }

  /** Last in each operation's transaction, so a run that has ended takes back the operation it was in. */
  private async advance(tx: Kysely<DB>, { runId, targets, tally }: ApplyContext, nextIndex: number): Promise<void> {
    if (!(await this.albumCleanupRepository.holdIfRunning(tx, runId))) {
      throw new ApplyStopped();
    }
    await this.albumCleanupRepository.advanceApply(tx, runId, { nextIndex, targets, tally });
  }

  private finish({ runId, tally }: ApplyContext, status: AlbumChangeRunStatus): Promise<void> {
    // The summary can be read without the PIN. `lockedHealed` is how many Locked photos were touched, so it stays here.
    const { lockedHealed: _lockedHealed, ...summary } = tally;
    return this.albumChangeRunRepository.transaction(async (tx) => {
      // A run that has already ended keeps the outcome it ended with.
      if (await this.albumCleanupRepository.holdIfRunning(tx, runId)) {
        await this.albumChangeRunRepository.finishRun(tx, runId, status, summary);
      }
    });
  }

  /** Healing writes through the asset date update, which joins the partner-copy transaction it expects. */
  private inOperationTransaction(
    context: ApplyContext,
    operation: AlbumCleanupOperation,
    write: (tx: Transaction<DB>) => Promise<void>,
  ): Promise<void> {
    if (operation.type === 'heal') {
      const ids = [...new Set(operation.assetIds)].toSorted();
      return this.partnerOriginRepository.withOriginEdit('asset', ids, [], (tx) => write(tx!));
    }
    return this.albumChangeRunRepository.transaction(write);
  }

  private resolve({ targets }: ApplyContext, id: string): string {
    let current = id;
    while (targets[current]) {
      current = targets[current];
    }
    return current;
  }

  private async applyOperation(
    tx: Transaction<DB>,
    context: ApplyContext,
    operation: AlbumCleanupOperation,
  ): Promise<void> {
    switch (operation.type) {
      case 'heal': {
        await this.applyHeal(tx, context, operation);
        break;
      }
      case 'createCollection': {
        await this.applyCreateCollection(tx, context, operation);
        break;
      }
      case 'merge': {
        const reviewed = context.candidates.get(this.resolve(context, operation.albumIds?.[0] ?? ''));
        const survivor = await this.applyMerge(
          tx,
          context,
          operation.albumIds ?? [],
          operation.allowShared === true,
          'merged',
        );
        // An earlier merge can make a different album the largest by now. The person approved this name.
        if (reviewed && survivor !== reviewed.id) {
          await this.rename(tx, context, survivor, reviewed.name);
        }
        break;
      }
      case 'combine': {
        const winnerId = await this.applyMerge(tx, context, operation.albumIds ?? [], false, 'combined');
        await this.rename(tx, context, winnerId, operation.name!);
        break;
      }
      case 'rename': {
        await this.rename(tx, context, this.requireAlbum(context, operation.albumId).id, operation.name!);
        break;
      }
      case 'move': {
        await this.applyMove(tx, context, operation);
        break;
      }
      case 'remove': {
        await this.applyRemove(tx, context, operation);
        break;
      }
    }
  }

  private requireAlbum(context: ApplyContext, id: string | undefined): CleanupAlbumRow {
    const row = id ? context.candidates.get(this.resolve(context, id)) : undefined;
    if (!row) {
      throw new BadRequestException('The album changed before it could be reached');
    }
    return row;
  }

  private async applyHeal(tx: Transaction<DB>, context: ApplyContext, operation: AlbumCleanupOperation) {
    const plan = await this.heals.plan(context.auth, {
      albums: [{ albumId: operation.albumId!, assetIds: operation.assetIds ?? [] }],
    });
    const healed = await this.heals.healInto(tx, context.auth, context.runId, plan);
    const locked = healed.filter(({ isLocked }) => isLocked).length;
    add(context.tally, 'healed', healed.length - locked);
    add(context.tally, 'lockedHealed', locked);
  }

  private async applyCreateCollection(tx: Transaction<DB>, context: ApplyContext, operation: AlbumCleanupOperation) {
    const parentId = operation.parentTempId ? context.targets[operation.parentTempId] : (operation.parentId ?? null);
    if (operation.parentTempId && !parentId) {
      throw new BadRequestException('The collection it belongs in was not created');
    }
    // Rule 4: each level reuses a collection of that name under the same parent, and if two match, the older one.
    const existing = context.collections.find(
      (collection) =>
        collection.parentId === parentId && albumNameKey(collection.name) === albumNameKey(operation.name!),
    );
    if (existing) {
      context.targets[operation.tempId!] = existing.id;
      return;
    }
    const album = await new AlbumRepository(tx).create(
      { albumName: operation.name!, kind: AlbumKind.Collection, parentId },
      [],
      [{ userId: context.auth.user.id, role: AlbumUserRole.Owner }],
      context.auth.user.id,
    );
    await this.albumChangeRunRepository.recordChange(tx, context.runId, {
      kind: AlbumCleanupChangeKind.CollectionCreated,
      albumId: album.id,
      after: { albumName: operation.name },
    });
    context.targets[operation.tempId!] = album.id;
    context.collections.push({ id: album.id, name: operation.name!, parentId, createdAt: new Date() });
    add(context.tally, 'collections');
  }

  /** The album with the most photos by true count stays; each other album is merged into it. */
  private async applyMerge(
    tx: Transaction<DB>,
    context: ApplyContext,
    albumIds: string[],
    allowShared: boolean,
    key: 'merged' | 'combined',
  ): Promise<string> {
    const ids = [...new Set(albumIds.map((id) => this.resolve(context, id)))];
    const rows = ids.flatMap((id) => context.candidates.get(id) ?? []);
    if (rows.length === 0) {
      throw new BadRequestException('These albums changed before they could be merged');
    }
    if (rows.some(({ shared }) => shared) && !allowShared) {
      throw new BadRequestException('Shared albums are merged only when you choose to');
    }
    const counts = await new AlbumRepository(tx).getOwnerAssetCounts(ids, context.auth.user.id);
    let base = largestByTrueCount(rows, counts);
    const others = rows.filter(({ id }) => id !== base.id);
    for (const other of others) {
      const { winner, loser } = await this.merges.mergeInto(tx, context.auth, context.runId, base.id, other.id);
      context.targets[loser.id] = winner.id;
      context.candidates.delete(loser.id);
      const survivor = context.candidates.get(winner.id);
      if (survivor) {
        base = survivor;
      }
      add(context.tally, key);
    }
    return base.id;
  }

  private async rename(tx: Transaction<DB>, context: ApplyContext, albumId: string, name: string): Promise<void> {
    const album = await tx
      .selectFrom('album')
      .select('albumName')
      .where('id', '=', albumId)
      .where('deletedAt', 'is', null)
      .forUpdate()
      .executeTakeFirst();
    if (!album) {
      throw new BadRequestException('The album changed before it could be renamed');
    }
    if (album.albumName === name) {
      return;
    }
    await tx.updateTable('album').set({ albumName: name }).where('id', '=', albumId).execute();
    await this.albumChangeRunRepository.recordChange(tx, context.runId, {
      kind: AlbumCleanupChangeKind.Renamed,
      albumId,
      before: { albumName: album.albumName },
      after: { albumName: name },
    });
    add(context.tally, 'renamed');
  }

  private async applyMove(tx: Transaction<DB>, context: ApplyContext, operation: AlbumCleanupOperation) {
    const album = this.requireAlbum(context, operation.albumId);
    const parentId = operation.parentTempId
      ? (context.targets[operation.parentTempId] ?? null)
      : (operation.parentId ?? null);
    if (operation.parentTempId && !parentId) {
      throw new BadRequestException('The collection it belongs in was not created');
    }
    await lockAlbumHierarchy(tx);
    const current = await tx
      .selectFrom('album')
      .select('parentId')
      .where('id', '=', album.id)
      .where('deletedAt', 'is', null)
      .forUpdate()
      .executeTakeFirst();
    if (!current) {
      throw new BadRequestException('The album changed before it could be moved');
    }
    if (current.parentId === parentId) {
      return;
    }
    await new AlbumRepository(tx).reparentIn(tx, album.id, parentId);
    await this.albumChangeRunRepository.recordChange(tx, context.runId, {
      kind: AlbumChangeKind.ParentChanged,
      albumId: album.id,
      before: { parentId: current.parentId },
      after: { parentId },
    });
    add(context.tally, 'moved');
  }

  /** A removed album leaves its photos where they are; only the album goes, and it stays gone after a phone sync. */
  private async applyRemove(tx: Transaction<DB>, context: ApplyContext, operation: AlbumCleanupOperation) {
    const album = this.requireAlbum(context, operation.albumId);
    if (!isDateOnlyName(album.name) || album.shared) {
      throw new BadRequestException('Only an unshared album named nothing but a date can be removed');
    }
    const links = new AlbumSourceRepository(tx);
    const linkIds = await links.markStayRemoved(tx, album.id);
    if (linkIds.length > 0) {
      await this.albumChangeRunRepository.recordChange(tx, context.runId, {
        kind: AlbumCleanupChangeKind.SourceStayRemoved,
        albumId: album.id,
        after: { linkIds },
      });
    }
    const deletedAt = await new AlbumMergeRepository(tx).softDelete(album.id);
    await this.albumChangeRunRepository.recordChange(tx, context.runId, {
      kind: AlbumChangeKind.SoftDeleted,
      albumId: album.id,
      before: { deletedAt: null },
      after: { deletedAt },
    });
    context.candidates.delete(album.id);
    add(context.tally, 'removed');
  }

  /** Covers, the person's open pages, and partners following an album. None of it can undo the cleanup. */
  private async afterApply(context: ApplyContext): Promise<void> {
    const userId = context.auth.user.id;
    const winners = [...new Set(Object.values(context.targets))].filter((id) => context.candidates.has(id));
    if (winners.length > 0) {
      await this.albumRepository.updateThumbnails(winners);
      await recordAlbumEdit({ partnerOrigin: this.partnerOriginRepository, job: this.jobRepository }, winners, [
        AlbumOriginField.Membership,
      ]);
    }
    // One change is enough to make an open Albums page read the directory again.
    await this.eventRepository.emit('AlbumUpdate', {
      id: winners[0] ?? context.runId,
      userIds: [userId],
      recipientIds: [],
    });
    await this.jobRepository.queue({ name: JobName.AlbumCleanupScan, data: { userId } });
  }
}
