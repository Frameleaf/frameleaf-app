import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AlbumSuggestionReason as ReasonDto } from 'src/dtos/album-suggestion.dto.js';
import {
  AlbumDateSuggestion,
  AlbumSuggestionAutoAddDto,
  AlbumSuggestionsResponseDto,
  AlbumTripSuggestion,
} from 'src/dtos/album-suggestion.dto.js';
import { BulkIdsDto } from 'src/dtos/asset-ids.response.dto.js';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import { FrameleafWorker, JobName, JobStatus, Permission, QueueName } from 'src/enum.js';
import type { TripPhotoRow } from 'src/repositories/album-suggestion.repository.js';
import type { ArgOf } from 'src/repositories/event.repository.js';
import { AlbumService } from 'src/services/album.service.js';
import { BaseService } from 'src/services/base.service.js';
import type { JobOf } from 'src/types.js';
import {
  type SuggestionReason,
  type Trip,
  describeTrip,
  estimateDate,
  isAtTripPlaces,
  localDay,
  matchTripCandidate,
  suspiciousDate,
  utcOffset,
} from 'src/utils/album-suggestions.js';

const MAX_PLACES = 3;

/**
 * FL-1092 / FL-1093 magic albums. Suggests the viewer's own photos (partner copies included) for an album
 * they can add to. Nothing is added or re-dated here except by "Keep adding new photos from this trip",
 * which only ever adds very likely matches from the library of the person who turned it on.
 */
@Injectable()
export class AlbumSuggestionService extends BaseService {
  private _albumService: AlbumService | undefined;
  private get albumService(): AlbumService {
    this._albumService ??= BaseService.create(AlbumService, this);
    return this._albumService;
  }

  async getSuggestions(auth: AuthDto, id: string): Promise<AlbumSuggestionsResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AlbumAssetCreate, ids: [id] });
    const suggestions = this.albumRepository.suggestions;
    const autoAdd = await suggestions.isAutoAdd(id, auth.user.id);
    const photos = await suggestions.getTripPhotos(id);
    const trip = describeTrip(photos);
    if (!trip) return { autoAdd, tripStart: null, tripEnd: null, places: [], fromTrip: [], needDate: [] };

    const places = [...countBy(photos.filter(({ id }) => trip.photoIds.includes(id)).map(({ place }) => place))]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, MAX_PLACES)
      .map(([place]) => place);
    return {
      autoAdd,
      tripStart: localDay(trip.segments[0].localStart),
      tripEnd: localDay(trip.segments.at(-1)!.localEnd),
      places,
      fromTrip: await this.fromTrip(auth.user.id, id, trip),
      needDate: await this.needDate(auth.user.id, id, trip, new Map(photos.map((photo) => [photo.id, photo]))),
    };
  }

  async dismiss(auth: AuthDto, id: string, { ids }: BulkIdsDto): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.AlbumAssetCreate, ids: [id] });
    // Only the viewer's own photos are ever suggested, so only those can be dismissed.
    await this.requireAccess({ auth, permission: Permission.AssetUpdate, ids });
    await this.albumRepository.suggestions.dismiss(id, ids);
  }

  async setAutoAdd(auth: AuthDto, id: string, { enabled }: AlbumSuggestionAutoAddDto): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.AlbumAssetCreate, ids: [id] });
    await this.albumRepository.suggestions.setAutoAdd(id, auth.user.id, enabled);
  }

  @OnEvent({ name: 'AssetMetadataExtracted', workers: [FrameleafWorker.Microservices] })
  async onMetadataExtracted({ assetId, userId }: ArgOf<'AssetMetadataExtracted'>): Promise<void> {
    const albumIds = await this.albumRepository.suggestions.getAutoAddAlbumIds(userId);
    if (albumIds.length > 0) {
      await this.jobRepository.queue({ name: JobName.AlbumSuggestionAutoAdd, data: { id: assetId } });
    }
  }

  @OnJob({ name: JobName.AlbumSuggestionAutoAdd, queue: QueueName.BackgroundTask })
  async handleAutoAdd({ id }: JobOf<JobName.AlbumSuggestionAutoAdd>): Promise<JobStatus> {
    const asset = await this.assetRepository.getById(id);
    if (!asset) return JobStatus.Skipped;
    const owner = await this.userRepository.get(asset.ownerId, {});
    if (!owner) return JobStatus.Skipped;
    const auth: AuthDto = {
      user: {
        id: owner.id,
        isAdmin: owner.isAdmin,
        name: owner.name,
        email: owner.email,
        quotaUsageInBytes: owner.quotaUsageInBytes,
        quotaSizeInBytes: owner.quotaSizeInBytes,
      },
      session: { id: randomUUID(), hasElevatedPermission: false },
    };
    const suggestions = this.albumRepository.suggestions;
    for (const albumId of await suggestions.getAutoAddAlbumIds(owner.id)) {
      const [candidate] = await suggestions.getCandidates(owner.id, albumId, [id]);
      if (!candidate) continue;
      const trip = describeTrip(await suggestions.getTripPhotos(albumId));
      if (!trip || !matchTripCandidate(trip, candidate)?.likely) continue;
      try {
        // The same path as adding by hand: access is rechecked, so a person who left the album adds nothing.
        await this.albumService.addAssets(auth, albumId, { ids: [id] });
      } catch (error) {
        this.logger.warn(`Could not add ${id} to album ${albumId}: ${error instanceof Error ? error.message : error}`);
      }
    }
    return JobStatus.Success;
  }

  private async fromTrip(ownerId: string, albumId: string, trip: Trip): Promise<AlbumTripSuggestion[]> {
    const suggestions = this.albumRepository.suggestions;
    const candidates = await suggestions.getTripCandidates(ownerId, albumId, trip.segments);
    const unlocated = candidates.filter(({ latitude, longitude }) => latitude === null || longitude === null);
    const distances = await suggestions.getVisualDistances(
      unlocated.map(({ id }) => id),
      trip.photoIds,
    );
    const matches: AlbumTripSuggestion[] = [];
    for (const candidate of candidates) {
      const match = matchTripCandidate(trip, { ...candidate, visualDistance: distances.get(candidate.id) });
      if (match)
        matches.push({
          assetId: candidate.id,
          fileName: candidate.originalFileName,
          likely: match.likely,
          reasons: match.reasons.map((reason) => toDto(reason)),
        });
    }
    return matches.sort((a, b) => Number(b.likely) - Number(a.likely));
  }

  private async needDate(
    ownerId: string,
    albumId: string,
    trip: Trip,
    references: Map<string, TripPhotoRow>,
  ): Promise<AlbumDateSuggestion[]> {
    const suggestions = this.albumRepository.suggestions;
    const neighbours = await suggestions.getUndatedNeighbours(ownerId, albumId, trip.photoIds);
    const candidateIds = [...new Set(neighbours.map(({ assetId }) => assetId))];
    const candidates = await suggestions.getCandidates(ownerId, albumId, candidateIds);
    if (candidates.length === 0) return [];
    const albumPeople = new Set(
      [...(await suggestions.getPeople(ownerId, trip.photoIds)).values()].flat().map(({ id }) => id),
    );
    const people = await suggestions.getPeople(
      ownerId,
      candidates.map(({ id }) => id),
    );
    const fileNames = await suggestions.getFileNames([...new Set(neighbours.map(({ referenceId }) => referenceId))]);

    const results: AlbumDateSuggestion[] = [];
    for (const candidate of candidates) {
      const doubt = suspiciousDate(candidate.originalFileName, candidate.hasCameraDetails);
      // A photo already dated inside the trip is suggested by date instead.
      if (!doubt || trip.segments.some(({ from, to }) => candidate.takenAt >= from && candidate.takenAt <= to)) continue;
      const near = neighbours
        .filter(({ assetId }) => assetId === candidate.id)
        .flatMap(({ referenceId, distance }) => {
          const reference = references.get(referenceId);
          return reference
            ? [{ assetId: referenceId, distance, takenAt: reference.takenAt, localDateTime: reference.localDateTime }]
            : [];
        });
      const located = candidate.latitude !== null && candidate.longitude !== null;
      const estimate = estimateDate(trip, {
        neighbours: near,
        people: (people.get(candidate.id) ?? []).filter(({ id }) => albumPeople.has(id)).map(({ name }) => name),
        place:
          located && candidate.place && isAtTripPlaces(trip, { latitude: candidate.latitude!, longitude: candidate.longitude! })
            ? candidate.place
            : null,
        savedAt: doubt.savedAt,
      });
      if (!estimate) continue;
      const anchor = near.sort((a, b) => a.distance - b.distance)[0];
      results.push({
        assetId: candidate.id,
        fileName: candidate.originalFileName,
        source: doubt.source,
        fileDate: localDay(candidate.localDateTime),
        savedAt: doubt.savedAt?.toISOString() ?? null,
        precision: estimate.precision,
        dateTimeOriginal: `${estimate.localDateTime}${utcOffset(anchor.takenAt, anchor.localDateTime)}`,
        reasons: estimate.reasons.map((reason) => toDto(reason, fileNames)),
      });
    }
    const order = { moment: 0, day: 1, trip: 2 } as Record<string, number>;
    return results.sort((a, b) => order[a.precision] - order[b.precision]);
  }
}

const countBy = (values: (string | null)[]) => {
  const counts = new Map<string, number>();
  for (const value of values) if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
};

const toDto = (reason: SuggestionReason, fileNames?: Map<string, string>): ReasonDto =>
  'assetId' in reason ? { ...reason, fileName: fileNames?.get(reason.assetId) } : { ...reason };
