import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AlbumSuggestionReason as ReasonDto } from 'src/dtos/album-suggestion.dto.js';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { TripPhotoRow } from 'src/repositories/album-suggestion.repository.js';
import type { ArgOf } from 'src/repositories/event.repository.js';
import type { JobOf } from 'src/types.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import {
  AlbumDateSuggestion,
  AlbumSuggestionAutoAddDto,
  AlbumSuggestionsResponseDto,
  AlbumTripSuggestion,
} from 'src/dtos/album-suggestion.dto.js';
import { BulkIdsDto } from 'src/dtos/asset-ids.response.dto.js';
import { AssetEditAction } from 'src/dtos/editing.dto.js';
import {
  AssetVisibility,
  FrameleafWorker,
  ImageFormat,
  JobName,
  JobStatus,
  MlWorkload,
  Permission,
  QueueName,
} from 'src/enum.js';
import { AlbumService } from 'src/services/album.service.js';
import { BaseService } from 'src/services/base.service.js';
import {
  type Outfit,
  type SuggestionReason,
  TRIP_PADDING_MS,
  type Trip,
  type TripOutfit,
  describeTrip,
  estimateDate,
  isAtTripPlaces,
  localDay,
  matchOutfit,
  matchTripCandidate,
  sample,
  suspiciousDate,
  torsoBox,
  utcOffset,
} from 'src/utils/album-suggestions.js';
import { getAssetFiles } from 'src/utils/asset.util.js';
import { clipEmbeddingForStorage } from 'src/utils/clip-embedding.js';
import { getHiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import { isSmartSearchEnabled } from 'src/utils/misc.js';

const MAX_PLACES = 3;
/** ponytail: a trip person's photos sampled for outfits; a person photographed more than this is sampled evenly. */
const MAX_OUTFIT_PHOTOS = 300;
/** Torso crops are scaled to this before CLIP, which reads 224-384 pixel images. */
const OUTFIT_CROP_SIZE = 384;

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
    const photos = await suggestions.getTripPhotos(id, auth.user.id, getHiddenContentQueryOptions(auth));
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
      // A photo whose date can't be trusted is only ever suggested for review, never added.
      if (!candidate || suspiciousDate(candidate.originalFileName, candidate.hasCameraDetails)) continue;
      // Most new photos are nowhere near the trip: check its span before reading the album's photos.
      const span = await suggestions.getTimeSpan(albumId, owner.id);
      if (
        !span ||
        candidate.takenAt.getTime() < span.from.getTime() - TRIP_PADDING_MS ||
        candidate.takenAt.getTime() > span.to.getTime() + TRIP_PADDING_MS
      )
        continue;
      const trip = describeTrip(await suggestions.getTripPhotos(albumId, owner.id));
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

  /**
   * FL-1094: what each named person in a photo is wearing, as a CLIP embedding of the torso under their face,
   * made on the routed CLIP destination (Local, then Desktops, then Cloud). Queued only for album trip photos
   * and photos that need a date.
   */
  @OnJob({ name: JobName.AlbumSuggestionOutfit, queue: QueueName.SmartSearch })
  async handleOutfit({ id }: JobOf<JobName.AlbumSuggestionOutfit>): Promise<JobStatus> {
    const { machineLearning, image } = await this.getConfig({ withCache: true });
    if (!isSmartSearchEnabled(machineLearning)) return JobStatus.Skipped;
    await this.jobRepository.guardAssetSource(id);
    const asset = await this.assetJobRepository.getForClipEncoding(id);
    if (!asset || asset.visibility === AssetVisibility.Hidden) return JobStatus.Skipped;
    // Face boxes are stored in the unedited photo's space (mapped back when found on an edited preview), so
    // the unedited preview is cropped: no edit transform is needed, and an edit never makes an outfit stale.
    const { previewFile: preview } = getAssetFiles(asset.files);
    if (!preview) return JobStatus.Skipped;
    const { modelName } = machineLearning.clip;
    const faces = await this.albumRepository.suggestions.getFacesWithoutOutfit(id, modelName);
    if (faces.length === 0) return JobStatus.Skipped;

    const { data, info } = await this.mediaRepository.decodeImage(preview.path, {
      colorspace: image.colorspace,
      processInvalidImages: false,
    });
    const selection = await this.selectRoutedMlDestination({
      workload: MlWorkload.Clip,
      jobId: id,
      jobName: JobName.AlbumSuggestionOutfit,
      // FL-1484: the photo's owner may keep their photos at home
      ownerId: asset.ownerId,
    });
    const folder = await mkdtemp(join(tmpdir(), 'frameleaf-outfit-'));
    try {
      const rows = [];
      for (const face of faces) {
        // Face boxes are in the detection image's pixels; the preview may be another size.
        const scaleX = face.imageWidth > 0 ? info.width / face.imageWidth : 1;
        const scaleY = face.imageHeight > 0 ? info.height / face.imageHeight : 1;
        const box = torsoBox(
          { x1: face.x1 * scaleX, y1: face.y1 * scaleY, x2: face.x2 * scaleX, y2: face.y2 * scaleY },
          info,
        );
        if (!box) {
          rows.push({ faceId: face.id, modelName, embedding: null });
          continue;
        }
        const path = join(folder, `${face.id}.jpg`);
        await this.mediaRepository.generateThumbnail(
          data,
          {
            colorspace: image.colorspace,
            format: ImageFormat.Jpeg,
            raw: info,
            quality: 90,
            progressive: false,
            processInvalidImages: false,
            size: OUTFIT_CROP_SIZE,
            edits: [{ action: AssetEditAction.Crop, parameters: box }],
          },
          path,
        );
        const embedding = await this.machineLearningRepository.encodeImage(selection, path, machineLearning.clip);
        rows.push({ faceId: face.id, modelName, embedding: clipEmbeddingForStorage(embedding).embedding });
      }
      await this.albumRepository.suggestions.saveOutfits(rows);
    } finally {
      await rm(folder, { recursive: true, force: true });
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
    const tripPeople = await suggestions.getPeople(ownerId, trip.photoIds);
    const albumPeople = new Set(
      tripPeople
        .values()
        .toArray()
        .flat()
        .map(({ id }) => id),
    );
    const people = await suggestions.getPeople(
      ownerId,
      candidates.map(({ id }) => id),
    );
    const outfits = await this.getOutfits(ownerId, trip, candidates, people, tripPeople, albumPeople, references);
    const fileNames = await suggestions.getFileNames([
      ...new Set([...neighbours.map(({ referenceId }) => referenceId), ...outfits.trip.map(({ assetId }) => assetId)]),
    ]);

    const results: AlbumDateSuggestion[] = [];
    for (const candidate of candidates) {
      const doubt = suspiciousDate(candidate.originalFileName, candidate.hasCameraDetails);
      // A photo already dated inside the trip is suggested by date instead.
      if (!doubt || trip.segments.some(({ from, to }) => candidate.takenAt >= from && candidate.takenAt <= to))
        continue;
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
          located &&
          candidate.place &&
          isAtTripPlaces(trip, { latitude: candidate.latitude!, longitude: candidate.longitude! })
            ? candidate.place
            : null,
        savedAt: doubt.savedAt,
        outfit: matchOutfit(outfits.byAsset.get(candidate.id) ?? [], outfits.trip),
      });
      if (!estimate) continue;
      const anchor = estimate.datedBy ?? near.sort((a, b) => a.distance - b.distance)[0];
      const dateTimeOriginal = `${estimate.localDateTime}${utcOffset(anchor.takenAt, anchor.localDateTime)}`;
      // The final instant, offset applied, must not be after it was saved or received.
      if (doubt.savedAt && new Date(dateTimeOriginal) > doubt.savedAt) continue;
      results.push({
        assetId: candidate.id,
        fileName: candidate.originalFileName,
        source: doubt.source,
        fileDate: localDay(candidate.localDateTime),
        savedAt: doubt.savedAt?.toISOString() ?? null,
        precision: estimate.precision,
        dateTimeOriginal,
        reasons: estimate.reasons.map((reason) => toDto(reason, fileNames)),
      });
    }
    const order = { moment: 0, day: 1, trip: 2 } as Record<string, number>;
    return results.sort((a, b) => order[a.precision] - order[b.precision]);
  }

  /**
   * FL-1094: the outfits of the album's people in candidates that need a date, and in the trip photos of the
   * same people. Photos with faces not yet cropped are queued; their outfits count the next time.
   */
  private async getOutfits(
    ownerId: string,
    trip: Trip,
    candidates: { id: string; originalFileName: string; hasCameraDetails: boolean }[],
    people: Map<string, { id: string }[]>,
    tripPeople: Map<string, { id: string }[]>,
    albumPeople: Set<string>,
    references: Map<string, TripPhotoRow>,
  ): Promise<{ byAsset: Map<string, Outfit[]>; trip: TripOutfit[] }> {
    const byAsset = new Map<string, Outfit[]>();
    const worn: TripOutfit[] = [];
    const { machineLearning } = await this.getConfig({ withCache: true });
    if (!isSmartSearchEnabled(machineLearning)) return { byAsset, trip: worn };
    const candidateIds = candidates
      .filter(
        ({ id, originalFileName, hasCameraDetails }) =>
          suspiciousDate(originalFileName, hasCameraDetails) && people.get(id)?.some(({ id }) => albumPeople.has(id)),
      )
      .map(({ id }) => id);
    const wanted = new Set(candidateIds.flatMap((id) => people.get(id)!.map(({ id }) => id)));
    if (wanted.size === 0) return { byAsset, trip: worn };
    const tripIds = sample(
      // Hidden photos (such as a live photo's video) are never cropped, so they would stay pending for good.
      trip.photoIds.filter(
        (id) =>
          references.get(id)?.visibility !== AssetVisibility.Hidden &&
          tripPeople.get(id)?.some(({ id }) => wanted.has(id)),
      ),
      MAX_OUTFIT_PHOTOS,
    );

    const rows = await this.albumRepository.suggestions.getOutfits(
      ownerId,
      [...candidateIds, ...tripIds],
      machineLearning.clip.modelName,
    );
    const missing = [...new Set(rows.filter(({ encoded }) => !encoded).map(({ assetId }) => assetId))];
    if (missing.length > 0) {
      try {
        await this.jobRepository.queueAll(missing.map((id) => ({ name: JobName.AlbumSuggestionOutfit, data: { id } })));
      } catch (error) {
        // Outfits are an extra signal: the date suggestions still load without them.
        this.logger.warn(`Could not queue outfit crops: ${error instanceof Error ? error.message : error}`);
      }
    }

    const tripSet = new Set(tripIds);
    // A person whose trip photos aren't all cropped yet could match the one day that is: wait for the rest.
    const pending = new Set(
      rows.filter(({ assetId, encoded }) => !encoded && tripSet.has(assetId)).map(({ personId }) => personId),
    );
    for (const { assetId, personId, name, embedding } of rows) {
      const vector = parseOutfit(embedding);
      if (!vector || !wanted.has(personId) || pending.has(personId)) continue;
      const outfit = { personId, name, embedding: vector };
      if (!tripSet.has(assetId)) byAsset.set(assetId, [...(byAsset.get(assetId) ?? []), outfit]);
      else {
        const { takenAt, localDateTime } = references.get(assetId)!;
        worn.push({ ...outfit, assetId, takenAt, localDateTime });
      }
    }
    return { byAsset, trip: worn };
  }
}

/** ponytail: `embedding` is the JSON array the CLIP producers return; a malformed one is no outfit. */
const parseOutfit = (embedding: string | null) => {
  if (!embedding) return;
  try {
    const parsed: unknown = JSON.parse(embedding);
    return Array.isArray(parsed) && parsed.every((value) => typeof value === 'number') ? parsed : undefined;
  } catch {
    return;
  }
};

const countBy = (values: (string | null)[]) => {
  const counts = new Map<string, number>();
  for (const value of values) if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
};

const toDto = (reason: SuggestionReason, fileNames?: Map<string, string>): ReasonDto =>
  'assetId' in reason ? { ...reason, fileName: fileNames?.get(reason.assetId) } : { ...reason };
