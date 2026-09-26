import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { chunk } from 'lodash-es';
import { InjectKysely } from 'nestjs-kysely';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Insertable } from 'kysely';
import type { SystemConfig } from 'src/config.js';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { ArgOf } from 'src/repositories/event.repository.js';
import type { ImageDescriptionResult, NsfwDetectionResult } from 'src/repositories/machine-learning.repository.js';
import type { JobItem, JobOf } from 'src/types.js';
import { JOBS_ASSET_PAGINATION_SIZE } from 'src/constants.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import { BulkIdsDto } from 'src/dtos/asset-ids.response.dto.js';
import {
  AssetImageEnrichmentAction,
  AssetImageEnrichmentActionRequestDto,
  AssetImageEnrichmentResponseDto,
} from 'src/dtos/asset.dto.js';
import {
  AssetLockReason,
  AssetMetadataKey,
  AssetStatus,
  AssetType,
  AssetVisibility,
  EnrichmentStaleReason,
  ImmichWorker,
  JobName,
  JobStatus,
  MlDestinationKind,
  MlWorkload,
  Permission,
  QueueName,
  StorageFolder,
  SystemMetadataKey,
} from 'src/enum.js';
import { ForkEnrichmentRepository } from 'src/repositories/fork-enrichment.repository.js';
import { ForkPrivacyRepository, PrivacySidecar } from 'src/repositories/fork-privacy.repository.js';
import { VideoMomentRepository } from 'src/repositories/video-moment.repository.js';
import { DB } from 'src/schema/index.js';
import { TagAssetTable } from 'src/schema/tables/tag-asset.table.js';
import { BaseService } from 'src/services/base.service.js';
import { ClassificationService } from 'src/services/classification.service.js';
import { IdentityPostValidator } from 'src/services/identity-post-validator.service.js';
import { ImageDescriptionPromptAssembler, KnownPerson, VideoContext } from 'src/services/prompt-assembler.service.js';
import { SmartAlbumService } from 'src/services/smart-album.service.js';
import { requireElevatedPermission } from 'src/utils/access.js';
import { CloudDescriptionQueueWriter, cloudDescriptionDestination } from 'src/utils/cloud-description-batch.js';
import { updateLockedColumns } from 'src/utils/database.js';
import { enrichmentStaleReason, identityHash } from 'src/utils/enrichment-plan.js';
import { isLockedRow } from 'src/utils/locked.js';
import {
  isImageDescriptionEnabled,
  isNsfwDetectionEnabled,
  isNsfwHidingEnabled,
  isSmartSearchEnabled,
} from 'src/utils/misc.js';
import { cloudRouteAllows } from 'src/utils/ml-destination.js';
import { upsertTags } from 'src/utils/tag.js';
import { ensureVideoFrames, withTemporaryFrames } from 'src/utils/video-moment-frames.js';

type EnrichmentReview = {
  action: 'accepted' | 'marked-safe' | 'marked-nsfw';
  isNsfw: boolean;
  reviewedAt: string;
  reviewedBy: string;
};

type EnrichmentTask<T> =
  | {
      status: 'success';
      modelName: string;
      updatedAt: string;
      result: T;
      /** 8-char hex truncation of SHA-256(JSON.stringify(prompt config)) at inference time. */
      configHash?: string;
      appliedDescriptionHash?: string;
      appliedTagHash?: string;
      appliedTagValues?: string[];
      /** Identity validation flags recorded after post-processing the ML description. */
      identityFlags?: { hallucinatedNames?: string[]; ambiguousReferences?: string[] };
      /** What the result was made from (FL-59); a change to any of it makes the result stale. */
      provenance?: EnrichmentResultProvenance;
    }
  | {
      status: 'failed';
      modelName: string;
      updatedAt: string;
      error: string;
    };

type DescriptionEnrichmentTask =
  | EnrichmentTask<ImageDescriptionResult>
  | {
      status: 'skipped';
      modelName?: string;
      updatedAt: string;
      reason: string;
    };

type NsfwEnrichmentTask = EnrichmentTask<NsfwDetectionResult> & {
  review?: EnrichmentReview;
};

type EnrichmentMetadata = {
  description?: DescriptionEnrichmentTask;
  nsfwDetection?: NsfwEnrichmentTask;
};

/**
 * FL-34: aborts (rolling the transaction back) when a lock group, worked out again under its row locks,
 * reaches assets outside the ones already checked and metadata-locked: a concurrent stack join.
 */
const requireUnchangedGroup = (ids: string[], checkedIds: string[]) => {
  const checked = new Set(checkedIds);
  if (ids.some((id) => !checked.has(id))) {
    throw new ConflictException('The stack or live photo changed meanwhile, try again');
  }
};

/** An owner's safe review written in a transaction, for its tag follow-up once that commits (FL-34). */
type SafeReview = { id: string; ownerId: string; metadata: EnrichmentMetadata };

/** Provenance pinned on a generated result (FL-59). */
type EnrichmentResultProvenance = {
  /** The ML destination that produced it (FL-110). */
  destinationId?: string;
  /** Digest of the confirmed names the prompt was given. */
  identityHash?: string;
  /** Fingerprint of the original it was made from. */
  sourceFingerprint?: string;
  /** The enrichment plan configuration digest, when a plan produced it. */
  planConfigHash?: string;
};

/**
 * How an enrichment plan (FL-59) runs a stage: the destinations and configuration it pinned at
 * submit. A queue job passes nothing and gets the routed destinations and the saved configuration.
 */
export type EnrichmentRunOptions = {
  enrichmentDestinationId?: string | null;
  searchDestinationId?: string | null;
  imageDescription?: Partial<
    Pick<
      SystemConfig['machineLearning']['imageDescription'],
      'modelName' | 'fallbackModelName' | 'device' | 'acceleration' | 'prompt'
    >
  >;
  nsfwDetection?: Partial<Pick<SystemConfig['machineLearning']['nsfwDetection'], 'modelName' | 'threshold' | 'device'>>;
  clipModelName?: string;
  configHash?: string;
  /** The durable job the requests belong to, recorded with the destination's accounting. */
  jobId?: string;
  /**
   * Set by an enrichment plan. A plan only ever uses the destinations it pinned: a workload it
   * pinned none for is not sent anywhere, never to the routed destination instead.
   */
  planRun?: boolean;
};

/** What one stage did to one asset, for the plan's per-asset record. */
export type EnrichmentStageResult = { status: JobStatus; reasonKey?: string; message?: string };

/** A description made with a draft model and prompt, and written nowhere (FL-59). */
export type DescriptionPreview =
  | {
      status: 'success';
      current: string | null;
      candidate: string;
      tags: string[];
      identityFlags?: { hallucinatedNames?: string[]; ambiguousReferences?: string[] };
      warnings: string[];
      modelName: string;
      destinationId: string;
      frameCount: number;
      durationMs: number;
    }
  | { status: 'failed'; current: string | null; message: string; warnings: string[] }
  | { status: 'skipped'; reasonKey: string };

/** The saved configuration with a plan's pinned values laid over it. Enable switches stay the saved ones. */
const withPinnedConfig = (
  machineLearning: SystemConfig['machineLearning'],
  options: EnrichmentRunOptions,
): SystemConfig['machineLearning'] => ({
  ...machineLearning,
  imageDescription: { ...machineLearning.imageDescription, ...options.imageDescription },
  nsfwDetection: { ...machineLearning.nsfwDetection, ...options.nsfwDetection },
  clip: { ...machineLearning.clip, ...(options.clipModelName && { modelName: options.clipModelName }) },
});

const GENERATED_DESCRIPTION_PREFIX = 'AI description:';
const HIGH_CONFIDENCE = 'high';

/**
 * FL-36: the description confidence a destination reported, as a number from 0 to 1, or null.
 * Anything else (a low/medium/high label, a percentage, a missing value) is null: a confidence is
 * never inferred or rescaled.
 */
export const descriptionConfidence = (result: { confidence?: unknown } | undefined): number | null => {
  const value = result?.confidence;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
};
const STRONG_NSFW_INDICATORS = new Set([
  'adult-nudity',
  'bare-buttocks',
  'bondage',
  'explicit',
  'exposed-genitals',
  'genital',
  'genitals',
  'naked',
  'nude',
  'nudity',
  'pornography',
  'restrained',
  'restraint',
  'sex-toy',
  'sexual-activity',
]);
const STRONG_NSFW_TEXT_PATTERN =
  /\b(naked|nude|nudity|genitals?|penis|vagina|buttocks?|sexual activity|sex toy|bondage|restrained|restraint)\b/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const getErrorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

const promptConfigHash = (promptConfig: unknown) =>
  createHash('sha256').update(JSON.stringify(promptConfig)).digest('hex').slice(0, 8);

const getGeneratedDescriptionBlock = (description: string) => {
  const trimmed = description.trim();
  return trimmed ? `${GENERATED_DESCRIPTION_PREFIX} ${trimmed}` : undefined;
};

const withoutGeneratedDescriptionBlocks = (description: string, generatedDescriptions: string[]) => {
  const blocks = new Set(
    generatedDescriptions
      .map((generatedDescription) => getGeneratedDescriptionBlock(generatedDescription))
      .filter((block): block is string => !!block),
  );

  if (blocks.size === 0) {
    return description.trim();
  }

  return description
    .split(/\n{2,}/)
    .filter((part) => !blocks.has(part.trim()))
    .join('\n\n')
    .trim();
};

const copyAppliedFields = <T extends Record<string, unknown>>(target: T, source: T, keys: Array<keyof T>) => {
  for (const key of keys) {
    if (source[key] === undefined) {
      delete target[key];
    } else {
      target[key] = source[key];
    }
  }
};

const normalizeTag = (tag: string) =>
  tag
    .toLowerCase()
    .trim()
    .replaceAll(/[^a-z0-9 _-]/g, '')
    .replaceAll(/\s+/g, '-')
    .replaceAll(/-+/g, '-')
    .replaceAll(/^-|-$/g, '');

/** Assets unlocked per transaction by a bulk unlock (FL-34); see `unlockAssets`. */
const UNLOCK_CHUNK_SIZE = 200;

@Injectable()
export class ImageEnrichmentService extends BaseService {
  @InjectKysely()
  private db?: Kysely<DB>;

  private readonly promptAssembler = new ImageDescriptionPromptAssembler();
  private readonly identityPostValidator = new IdentityPostValidator();
  /** FL-163: new photos for automatic Frameleaf Cloud batches, written to the queue in batches. */
  private readonly cloudQueue = new CloudDescriptionQueueWriter(
    () => ({ databaseRepository: this.databaseRepository, systemMetadataRepository: this.systemMetadataRepository }),
    (message) => this.logger.warn(message),
  );
  private _classificationService: ClassificationService | undefined;

  private get classificationService(): ClassificationService {
    this._classificationService ??= BaseService.create(ClassificationService, this);
    return this._classificationService;
  }

  private _smartAlbumService: SmartAlbumService | undefined;

  /** Lazy accessor — avoids referencing `this` before super() returns. */
  private get smartAlbumService(): SmartAlbumService {
    this._smartAlbumService ??= BaseService.create(SmartAlbumService, this);
    return this._smartAlbumService;
  }

  async getAssetEnrichment(auth: AuthDto, id: string): Promise<AssetImageEnrichmentResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AssetUpdate, ids: [id], ignorePrivacy: true });

    const metadata = await this.getEnrichmentMetadata(id);
    return this.toResponse(id, metadata, await this.getDescriptionStaleReason(id, metadata));
  }

  /**
   * Whether the stored generated description no longer describes what it claims to (FL-59): the
   * original was replaced, a face correction changed the confirmed names it was given, or the
   * saved prompt changed. Manual text is never judged; only the generated result is.
   */
  private async getDescriptionStaleReason(
    id: string,
    metadata: EnrichmentMetadata,
  ): Promise<EnrichmentStaleReason | null> {
    const description = metadata.description;
    if (description?.status !== 'success') {
      return null;
    }

    const asset = await this.assetRepository.getById(id);
    const { machineLearning } = await this.getConfig({ withCache: true });
    const knownPersons = asset ? await this.getKnownPersonsForAsset(id, asset.ownerId) : [];
    return enrichmentStaleReason(
      {
        sourceFingerprint: description.provenance?.sourceFingerprint,
        identityHash: description.provenance?.identityHash,
        configHash: description.configHash,
      },
      {
        sourceFingerprint: await this.getSourceFingerprint(id),
        identityHash: identityHash(knownPersons.map(({ name }) => name)),
        configHash: promptConfigHash(machineLearning.imageDescription.prompt),
      },
    );
  }

  async updateAssetEnrichment(
    auth: AuthDto,
    id: string,
    dto: AssetImageEnrichmentActionRequestDto,
  ): Promise<AssetImageEnrichmentResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AssetUpdate, ids: [id], ignorePrivacy: true });

    const asset = await this.assetRepository.getById(id, { exifInfo: true, tags: true });
    if (!asset) {
      throw new BadRequestException('Asset not found');
    }

    // FL-34: marking safe reviews and unlocks the asset's whole stack or live photo in one transaction
    if (dto.action === AssetImageEnrichmentAction.MarkSafe) {
      await this.markGroupSafe(auth, id);
      return this.toResponse(id, await this.getEnrichmentMetadata(id));
    }

    // Queue-only actions don't touch asset_metadata — no lock needed.
    if (dto.action === AssetImageEnrichmentAction.RerunImageDescription) {
      await this.jobRepository.queue({ name: JobName.ImageDescription, data: { id } });
      return this.toResponse(id, await this.getEnrichmentMetadata(id));
    }
    if (dto.action === AssetImageEnrichmentAction.RerunNsfwDetection) {
      await this.jobRepository.queue({ name: JobName.NsfwDetection, data: { id } });
      return this.toResponse(id, await this.getEnrichmentMetadata(id));
    }

    // Phase 1 (under per-asset advisory lock): read metadata, mutate the
    // review/clear fields, persist. Kept narrow so the transaction's
    // connection isn't held while tag application or job queueing runs —
    // those would compete for the same pool and deadlock under parallel
    // bulk-mark actions.
    const { metadata, locked } = await this.databaseRepository.withAssetMetadataLock(id, async (trx) => {
      // the actions that may lock the asset take its group's rows first (FL-34)
      if ([AssetImageEnrichmentAction.MarkNsfw, AssetImageEnrichmentAction.AcceptNsfwResult].includes(dto.action)) {
        await this.lockGroupRows(id, trx);
      }
      const m = await this.getEnrichmentMetadata(id, trx);

      switch (dto.action) {
        case AssetImageEnrichmentAction.AcceptNsfwResult: {
          const nsfw = this.ensureManualNsfwMetadata(m, this.getEffectiveNsfw(m) ?? false);
          nsfw.review = this.getReview(auth, 'accepted', this.getEffectiveNsfw(m) ?? false);
          break;
        }
        case AssetImageEnrichmentAction.MarkNsfw: {
          const nsfw = this.ensureManualNsfwMetadata(m, true);
          nsfw.review = this.getReview(auth, 'marked-nsfw', true);
          break;
        }
        case AssetImageEnrichmentAction.MarkSafe: {
          // Unreachable: handled above by `markGroupSafe`, for the whole group in one transaction.
          break;
        }
        case AssetImageEnrichmentAction.ClearGeneratedDescription:
        case AssetImageEnrichmentAction.ClearGeneratedTags: {
          // These actions only delete derived fields; the side-effect phase
          // below performs the deletion and persists the result.
          break;
        }
        case AssetImageEnrichmentAction.RerunImageDescription:
        case AssetImageEnrichmentAction.RerunNsfwDetection: {
          // Unreachable: queue-only actions return early above, before the
          // metadata lock is taken. Listed to keep the switch exhaustive.
          break;
        }
      }

      await this.saveEnrichmentMetadata(id, m, trx);

      // FL-34: the sensitive mark is the lock. Marking locks the asset (the owner's own lock), and
      // accepting a sensitive detection locks it as detected (marking it safe unlocks it, in
      // `markGroupSafe`). The lock record commits in the same transaction as the review and its privacy
      // projection, so no reader ever sees one without the other. Albums, favourites and the stored
      // visibility are untouched either way; stacks and live photos move as a whole.
      let locked: string[] = [];
      if (dto.action === AssetImageEnrichmentAction.MarkNsfw) {
        locked = await this.assetRepository.lock([id], AssetLockReason.Marked, auth.user.id, trx);
      } else if (dto.action === AssetImageEnrichmentAction.AcceptNsfwResult && m.nsfwDetection?.review?.isNsfw) {
        locked = await this.assetRepository.lock([id], AssetLockReason.Detected, auth.user.id, trx);
      }

      return { metadata: m, locked };
    });
    // the lock is committed: release what a locked photo may no longer be before anything below can fail
    await this.afterSensitiveLock(locked);

    // Phase 2 (no lock): tag application + finalize. These are idempotent on
    // their applied-hash bookkeeping, so the brief unlocked window between
    // phases is safe even under concurrent reviewer/detection writes.
    let changed: { visible: boolean; metadata: boolean };
    switch (dto.action) {
      case AssetImageEnrichmentAction.AcceptNsfwResult: {
        changed = metadata.nsfwDetection?.review?.isNsfw
          ? await this.applyNsfwTags(id, asset.ownerId, this.getStoredNsfw(metadata)!, metadata)
          : await this.clearAppliedNsfwTags(id, asset.ownerId, metadata);
        break;
      }
      case AssetImageEnrichmentAction.MarkNsfw: {
        changed = await this.applyNsfwTags(id, asset.ownerId, this.getStoredNsfw(metadata)!, metadata);
        break;
      }
      case AssetImageEnrichmentAction.ClearGeneratedDescription: {
        changed = await this.clearGeneratedDescription(id, asset.exifInfo?.description ?? '', metadata);
        break;
      }
      case AssetImageEnrichmentAction.ClearGeneratedTags: {
        changed = await this.clearGeneratedTags(id, asset.ownerId, this.getStoredGeneratedTags(metadata));
        if (metadata.description?.status === 'success') {
          delete metadata.description.appliedTagHash;
          delete metadata.description.appliedTagValues;
          changed.metadata = true;
        }
        if (metadata.nsfwDetection?.status === 'success') {
          delete metadata.nsfwDetection.appliedTagHash;
          delete metadata.nsfwDetection.appliedTagValues;
          changed.metadata = true;
        }
        break;
      }
      default: {
        changed = { visible: false, metadata: false };
      }
    }

    await this.finalizeRepair(id, changed, metadata);

    return this.toResponse(id, await this.getEnrichmentMetadata(id));
  }

  /**
   * Unlock (FL-34): removes the lock, whatever its reason, from assets the caller owns. Only an elevated
   * session may unlock, since it shows what was hidden. The stored visibility is untouched, so each asset
   * returns exactly where it was (its albums, the timeline or the archive); stacks and live photos
   * unlock as a whole. The owner's unlock is also their review: a sensitive verdict on each unlocked
   * asset is overridden (`recordOwnerUnlock`), so a later detection never locks it again. The unlock and
   * those reviews commit in one transaction, so no asset is ever left unlocked without its review.
   */
  async unlockAssets(auth: AuthDto, dto: BulkIdsDto): Promise<void> {
    requireElevatedPermission(auth);
    await this.requireAccess({ auth, permission: Permission.AssetUpdate, ids: dto.ids });
    // Each chunk is one transaction: a metadata lock per group member (stacks and live photos
    // included) lives in PostgreSQL's shared lock table until commit, so an unbounded request could
    // exhaust it for every connection. A group split across chunks is unlocked whole by the first.
    for (const ids of chunk(dto.ids, UNLOCK_CHUNK_SIZE)) {
      // every metadata writer takes its assets' metadata locks, in id order, before any group's rows
      const groupIds = await this.assetRepository.findLockGroupIds(ids);
      const { unlocked, reviewed } = await this.databaseRepository.withAssetMetadataLocks(groupIds, async (trx) => {
        const unlocked = [...new Set((await this.assetRepository.unlock(ids, trx)).map(({ assetId }) => assetId))];
        requireUnchangedGroup(unlocked, groupIds);
        const reviewed = await this.recordOwnerUnlock(auth, unlocked, trx);
        return { unlocked, reviewed };
      });
      await this.clearSafeReviewTags(reviewed);
      await this.notifyAssetsUpdated(unlocked, auth.user.id);
    }
  }

  /**
   * FL-34: in the caller's transaction `trx`, after its owner unlocked `assetIds`, records "safe" as
   * their own review on every one of them, whatever the sensitive-content check says now, so the owner's
   * choice wins over the model: no later detection ever locks it again. An asset already reviewed as
   * safe keeps its review. Returns what it reviewed, for `clearSafeReviewTags` once `trx` commits.
   */
  async recordOwnerUnlock(auth: AuthDto, assetIds: string[], trx: Kysely<DB>): Promise<SafeReview[]> {
    if (assetIds.length === 0) {
      return [];
    }
    const unlocked = new Set(assetIds);
    // the unlock checked access; its stack members and live-photo parts share their owner
    const members = await this.assetRepository.lockGroupMembers(assetIds, trx);
    return this.reviewSafe(
      auth,
      members.filter(({ id }) => unlocked.has(id)),
      trx,
      false,
    );
  }

  /**
   * FL-34: Mark Safe on one asset unlocks its whole stack or live photo (`AssetRepository.unlock`), so it
   * is the owner's safe review of the asset and of every member that unlock released, written in the same
   * transaction. Were only the clicked asset reviewed, a released sibling would keep its sensitive verdict
   * with no review, and the next sweep of unreviewed detections would lock the whole group again. A
   * sibling that was not locked is not reviewed: the owner never saw it, so a detection on it stands.
   *
   * The members' metadata locks are taken in id order, then the group's rows, as every other writer does.
   * Unlocking needs the owner's elevated session, checked against the group as read under its row locks;
   * should the group have changed since (a concurrent stack join), nothing is written. An explicit Mark
   * Safe is also a repair: an asset already reviewed as safe keeps its review, and its privacy projection
   * is written again (`saveClassification` creates a missing row).
   */
  private async markGroupSafe(auth: AuthDto, id: string): Promise<void> {
    const groupIds = await this.assetRepository.findLockGroupIds([id]);
    const lockIds = [...new Set([id, ...groupIds])];
    const { unlocked, reviewed } = await this.databaseRepository.withAssetMetadataLocks(lockIds, async (trx) => {
      const members = await this.assetRepository.lockGroupMembers([id], trx);
      const memberIds = members.map((member) => member.id);
      requireUnchangedGroup(memberIds, lockIds);
      if (members.some((member) => isLockedRow(member))) {
        requireElevatedPermission(auth);
      }
      // Legacy compatibility kept apart (FL-34): Mark Safe answers a sensitive verdict, so it releases
      // marked and detected locks only; an item kept in the upstream Locked folder stays Locked until
      // its owner unlocks it.
      const unlocked = (
        await this.assetRepository.unlock([id], trx, [AssetLockReason.Marked, AssetLockReason.Detected])
      ).map(({ assetId }) => assetId);
      // the unlock works the group out again: it may release only what the elevation check saw
      requireUnchangedGroup(unlocked, memberIds);
      const ownerId = members.find((member) => member.id === id)?.ownerId;
      const reviewIds = new Set([id, ...unlocked]);
      const reviewed = await this.reviewSafe(
        auth,
        members.filter((member) => reviewIds.has(member.id) && member.ownerId === ownerId),
        trx,
        true,
      );
      return { unlocked, reviewed };
    });
    await this.clearSafeReviewTags(reviewed);
    await this.notifyAssetsUpdated(unlocked, auth.user.id);
  }

  /**
   * Writes the owner's safe review on each of `members` in `trx`, with its privacy projection. An asset
   * already reviewed as safe keeps its review; with `repair` its projection is written again and it is
   * still returned, so its applied sensitive tags are cleared as a fresh review's are.
   */
  private async reviewSafe(
    auth: AuthDto,
    members: { id: string; ownerId: string }[],
    trx: Kysely<DB>,
    repair: boolean,
  ): Promise<SafeReview[]> {
    const reviewed: SafeReview[] = [];
    for (const { id, ownerId } of members) {
      const metadata = await this.getEnrichmentMetadata(id, trx);
      if (metadata.nsfwDetection?.review?.isNsfw === false) {
        if (repair) {
          await this.saveEnrichmentMetadata(id, metadata, trx);
          reviewed.push({ id, ownerId, metadata });
        }
        continue;
      }

      const nsfw = this.ensureManualNsfwMetadata(metadata, false);
      nsfw.review = this.getReview(auth, 'marked-safe', false);
      await this.saveEnrichmentMetadata(id, metadata, trx);
      reviewed.push({ id, ownerId, metadata });
    }
    return reviewed;
  }

  /** Once safe reviews are committed: removes the sensitive tags they had applied. */
  private async clearSafeReviewTags(reviewed: SafeReview[]) {
    for (const { id, ownerId, metadata } of reviewed) {
      const changed = await this.clearAppliedNsfwTags(id, ownerId, metadata);
      await this.finalizeRepair(id, changed, metadata);
    }
  }

  /**
   * FL-34: switching "hide sensitive detections" on locks what detection had already flagged and no
   * owner has reviewed, so those photos move to their owners' Locked view instead of staying in view.
   * Switching it off unlocks nothing: a lock is only ever removed by its owner.
   */
  @OnEvent({ name: 'ConfigUpdate', workers: [ImmichWorker.Microservices], server: true })
  async onConfigUpdate({ oldConfig, newConfig }: ArgOf<'ConfigUpdate'>) {
    const hideDetections = isNsfwHidingEnabled(newConfig.machineLearning);
    if (hideDetections === isNsfwHidingEnabled(oldConfig.machineLearning)) {
      return;
    }

    if (hideDetections) {
      await this.lockUnreviewedDetections();
    }
    await this.systemMetadataRepository.set(SystemMetadataKey.LockedDetectionsState, {
      hideFromLibrary: hideDetections,
    });
  }

  /**
   * FL-34: the upgrade (migration 2100000000320) locks earlier detections only when the saved
   * configuration hides them, and a configuration file can switch hiding on without saving it. On
   * start, when hiding is on now and was not on the last time the server looked, lock them exactly as
   * switching it on does. The setting seen is remembered, so this happens once per switch-on.
   */
  @OnEvent({ name: 'ConfigInit', workers: [ImmichWorker.Microservices] })
  async onConfigInit({ newConfig }: ArgOf<'ConfigInit'>) {
    const hideDetections = isNsfwHidingEnabled(newConfig.machineLearning);
    const state = await this.systemMetadataRepository.get(SystemMetadataKey.LockedDetectionsState);
    if (state?.hideFromLibrary === hideDetections) {
      return;
    }

    if (hideDetections) {
      await this.lockUnreviewedDetections();
    }
    await this.systemMetadataRepository.set(SystemMetadataKey.LockedDetectionsState, {
      hideFromLibrary: hideDetections,
    });
  }

  /** Locks what detection flagged and no owner reviewed (FL-34), a page at a time. */
  private async lockUnreviewedDetections() {
    const ids = await this.assetRepository.getUnlockedDetectionIds();
    for (let index = 0; index < ids.length; index += JOBS_ASSET_PAGINATION_SIZE) {
      await this.lockSensitive(ids.slice(index, index + JOBS_ASSET_PAGINATION_SIZE), AssetLockReason.Detected, null);
    }
  }

  /** Locks `assetIds` as sensitive (FL-34) and releases what a locked photo may no longer be. */
  private async lockSensitive(assetIds: string[], reason: AssetLockReason, lockedBy: string | null) {
    await this.afterSensitiveLock(await this.assetRepository.lock(assetIds, reason, lockedBy));
  }

  /**
   * FL-34: first in a metadata transaction that may lock or unlock `id`, takes its whole group's rows
   * in a fixed order, so parallel reviews or detections of two members of one stack or live photo
   * cannot deadlock. The unit tests' stand-in transaction is absent; there is nothing to order then.
   */
  private async lockGroupRows(id: string, trx: Kysely<DB> | undefined) {
    if (trx) {
      await this.assetRepository.lockGroupRows([id], trx);
    }
  }

  /** Once a sensitive lock is committed: releases what a locked photo may no longer be (FL-53). */
  private async afterSensitiveLock(locked: string[]) {
    if (locked.length > 0) {
      await this.afterAssetsLocked(locked);
    }
  }

  /**
   * FL-34: a sensitive detection locks the asset as `detected`, reviewable and reversible in the Locked
   * view, when the administrator has "hide sensitive detections" on. An owner's own review always
   * wins: an asset they reviewed is never locked by a detection. Never unlocks anything. Called inside
   * the metadata transaction `trx` so the lock commits with the classification that caused it; returns
   * the ids it locked for `afterSensitiveLock` once that transaction is committed.
   */
  private async lockIfDetected(
    id: string,
    metadata: EnrichmentMetadata,
    hideDetections: boolean,
    trx?: Kysely<DB>,
  ): Promise<string[]> {
    if (!hideDetections || metadata.nsfwDetection?.review || this.getEffectiveNsfw(metadata) !== true) {
      return [];
    }

    return this.assetRepository.lock([id], AssetLockReason.Detected, null, trx);
  }

  @OnJob({ name: JobName.ImageDescriptionQueueAll, queue: QueueName.ImageDescription })
  async handleQueueImageDescription({ force }: JobOf<JobName.ImageDescriptionQueueAll>): Promise<JobStatus> {
    const { machineLearning, libraryCare } = await this.getConfig({ withCache: false });
    if (!isImageDescriptionEnabled(machineLearning)) {
      return JobStatus.Skipped;
    }
    // FL-163: describing the whole library on Frameleaf Cloud is a backfill, which shows its estimate
    // before anything is queued; this job never queues it one photo at a time
    if (await cloudDescriptionDestination(this.mlDestinationRepository)) {
      this.logger.log(
        'Descriptions are routed to Frameleaf Cloud; describe the library from Frameleaf Cloud processing, where the estimate is shown first',
      );
      return JobStatus.Skipped;
    }

    // Library care → "Reprocess only affected outputs" (FL-69, settings-catalog.mjs:966-971): a full
    // rerun still visits every photo, but each keeps a current description and only one that is
    // missing, failed or out of date (its original, confirmed names or prompt changed) is redone.
    const onlyAffected = !!force && libraryCare.incrementalEnrichment;
    let jobs: JobItem[] = [];
    const assets = this.assetJobRepository.streamForImageDescriptionJob(force);

    for await (const asset of assets) {
      jobs.push({ name: JobName.ImageDescription, data: { id: asset.id, ...(onlyAffected && { onlyAffected }) } });

      if (jobs.length >= JOBS_ASSET_PAGINATION_SIZE) {
        await this.jobRepository.queueAll(jobs);
        jobs = [];
      }
    }

    await this.jobRepository.queueAll(jobs);
    return JobStatus.Success;
  }

  @OnJob({ name: JobName.NsfwDetectionQueueAll, queue: QueueName.NsfwDetection })
  async handleQueueNsfwDetection({ force }: JobOf<JobName.NsfwDetectionQueueAll>): Promise<JobStatus> {
    const { machineLearning } = await this.getConfig({ withCache: false });
    if (!isNsfwDetectionEnabled(machineLearning)) {
      return JobStatus.Skipped;
    }

    let jobs: JobItem[] = [];
    const assets = this.assetJobRepository.streamForNsfwDetectionJob(force);

    for await (const asset of assets) {
      jobs.push({ name: JobName.NsfwDetection, data: { id: asset.id } });

      if (jobs.length >= JOBS_ASSET_PAGINATION_SIZE) {
        await this.jobRepository.queueAll(jobs);
        jobs = [];
      }
    }

    await this.jobRepository.queueAll(jobs);
    return JobStatus.Success;
  }

  @OnJob({ name: JobName.NsfwDetection, queue: QueueName.NsfwDetection })
  async handleNsfwDetection({ id }: JobOf<JobName.NsfwDetection>): Promise<JobStatus> {
    return (await this.detectLockedContent(id)).status;
  }

  /**
   * The Locked-content check of one photo. The queue job runs it with the routed destination and the
   * saved model; an enrichment plan (FL-59) runs it with the destination and model it pinned.
   */
  async detectLockedContent(id: string, options: EnrichmentRunOptions = {}): Promise<EnrichmentStageResult> {
    const config = await this.getConfig({ withCache: true });
    const machineLearning = withPinnedConfig(config.machineLearning, options);
    if (!isNsfwDetectionEnabled(machineLearning)) {
      return { status: JobStatus.Skipped, reasonKey: 'disabled' };
    }

    const asset = await this.assetJobRepository.getForImageEnrichment(id);
    if (!asset || !this.isEligibleImage(asset)) {
      return {
        status: JobStatus.Skipped,
        reasonKey: asset?.type === AssetType.Video ? 'not-an-image' : 'not-eligible',
      };
    }

    if (!asset.previewFile) {
      return { status: JobStatus.Skipped, reasonKey: 'no-preview' };
    }

    // ML inference runs outside the per-asset lock — it can take hundreds of
    // ms and would otherwise hold the transaction's connection long enough to
    // starve the pool under parallel jobs.
    let result: NsfwDetectionResult;
    let destinationId: string;
    try {
      const selection = await this.selectEnrichmentDestination(
        MlWorkload.Enrichment,
        JobName.NsfwDetection,
        id,
        options,
      );
      destinationId = selection.destinationId;
      result = await this.machineLearningRepository.detectNsfw(
        selection,
        asset.previewFile!,
        machineLearning.nsfwDetection,
      );
    } catch (error) {
      await this.databaseRepository.withAssetMetadataLock(id, async (trx) => {
        const m = await this.getEnrichmentMetadata(id, trx);
        m.nsfwDetection = {
          status: 'failed',
          modelName: machineLearning.nsfwDetection.modelName,
          updatedAt: new Date().toISOString(),
          error: getErrorMessage(error),
          ...(m.nsfwDetection?.review && { review: m.nsfwDetection.review }),
        };
        await this.saveEnrichmentMetadata(id, m, trx);
      });
      return { status: JobStatus.Failed, reasonKey: 'model-error', message: getErrorMessage(error) };
    }

    // Serialize the RMW of the metadata blob against concurrent reviewer
    // actions and parallel description jobs. Side effects (tag application,
    // sidecar queueing) run afterwards on the regular pool.
    const { metadata, locked } = await this.databaseRepository.withAssetMetadataLock(id, async (trx) => {
      if (isNsfwHidingEnabled(machineLearning)) {
        await this.lockGroupRows(id, trx);
      }
      const m = await this.getEnrichmentMetadata(id, trx);
      const appliedTagHash = m.nsfwDetection?.status === 'success' ? m.nsfwDetection.appliedTagHash : undefined;
      const appliedTagValues = m.nsfwDetection?.status === 'success' ? m.nsfwDetection.appliedTagValues : undefined;
      // FL-34: the owner's review outlives every later detection, so a new result never erases it
      const review = m.nsfwDetection?.review;
      m.nsfwDetection = {
        status: 'success',
        modelName: machineLearning.nsfwDetection.modelName,
        updatedAt: new Date().toISOString(),
        result,
        appliedTagHash,
        appliedTagValues,
        provenance: { destinationId, ...(options.configHash && { planConfigHash: options.configHash }) },
        ...(review && { review }),
      };
      await this.saveEnrichmentMetadata(id, m, trx);
      const locked = await this.lockIfDetected(id, m, isNsfwHidingEnabled(machineLearning), trx);
      return { metadata: m, locked };
    });
    await this.afterSensitiveLock(locked);

    // the owner's review decides which tags apply, not the raw detection (FL-34)
    const changed = await this.applyNsfwTags(id, asset.ownerId, this.getStoredNsfw(metadata)!, metadata);
    if (changed.metadata) {
      await this.persistAppliedBookkeeping(id, metadata);
    }
    if (changed.visible) {
      await this.jobRepository.queue({ name: JobName.SidecarWrite, data: { id } });
    }

    return { status: JobStatus.Success };
  }

  @OnJob({ name: JobName.ImageDescription, queue: QueueName.ImageDescription })
  async handleImageDescription({ id, onlyAffected }: JobOf<JobName.ImageDescription>): Promise<JobStatus> {
    if (onlyAffected && !(await this.isDescriptionAffected(id))) {
      return JobStatus.Skipped;
    }
    return (await this.describeAsset(id)).status;
  }

  /**
   * Whether a description has to be redone (FL-69): there is no successful one, or the one there is
   * no longer describes what it claims to (`getDescriptionStaleReason`).
   */
  async isDescriptionAffected(id: string): Promise<boolean> {
    const metadata = await this.getEnrichmentMetadata(id);
    if (metadata.description?.status !== 'success') {
      return true;
    }
    return (await this.getDescriptionStaleReason(id, metadata)) !== null;
  }

  /**
   * FL-57: after a face or person change (rename, hide, merge, a face moved, taken off or added), the
   * generated text of only the affected assets is brought up to date: the owner's assets showing the
   * changed people, and the assets named in the job. For each one whose generated text was made with
   * other confirmed names than it has now:
   * - a generated description is described again (the regular description job, when descriptions are
   *   on), which replaces only the generated block and its description embedding; manual text is kept;
   * - generated video captions are withdrawn (their text removed, so moment search no longer finds old
   *   names) and made again by the next enrichment plan that includes captions, which stay opt-in
   *   because each one is a model request. Manual moments and transcripts are never touched.
   * Memories carry no person names (titles are places or years), so they need nothing.
   */
  @OnJob({ name: JobName.PersonIdentityRefresh, queue: QueueName.BackgroundTask })
  async handlePersonIdentityRefresh({
    ownerId,
    personGroupIds = [],
    assetIds = [],
  }: JobOf<JobName.PersonIdentityRefresh>): Promise<JobStatus> {
    const { machineLearning } = await this.getConfig({ withCache: true });
    const describe = isImageDescriptionEnabled(machineLearning);
    const seen = new Set<string>();
    let described = 0;
    let withdrawn = 0;

    const refresh = async (ids: string[]) => {
      const jobs: JobItem[] = [];
      for (const id of ids) {
        if (seen.has(id)) {
          continue;
        }
        seen.add(id);
        const outcome = await this.refreshAssetIdentity(id);
        withdrawn += outcome.withdrawnCaptions;
        if (outcome.describe && describe) {
          jobs.push({ name: JobName.ImageDescription, data: { id } });
        }
      }
      described += jobs.length;
      await this.jobRepository.queueAll(jobs);
    };

    await refresh(assetIds);
    let after: string | undefined;
    for (;;) {
      const page = await this.personRepository.getAssetIdsForPeople(ownerId, personGroupIds, {
        after,
        limit: JOBS_ASSET_PAGINATION_SIZE,
      });
      if (page.length === 0) {
        break;
      }
      await refresh(page);
      after = page.at(-1);
    }

    if (described > 0 || withdrawn > 0) {
      this.logger.log(
        `People changed: describing ${described} asset(s) again and withdrew ${withdrawn} generated caption(s)`,
      );
    }
    return JobStatus.Success;
  }

  /**
   * Whether an asset's generated text names other people than it shows now (FL-57). Read under the
   * asset's metadata lock, the one a description is published under, so a description published with
   * the old names just before is seen here, and one not yet published re-checks the names itself.
   */
  private async refreshAssetIdentity(id: string): Promise<{ describe: boolean; withdrawnCaptions: number }> {
    const asset = await this.assetRepository.getById(id);
    if (!asset || asset.deletedAt) {
      return { describe: false, withdrawnCaptions: 0 };
    }
    const names = identityHash((await this.getKnownPersonsForAsset(id, asset.ownerId)).map(({ name }) => name));
    const describe = await this.databaseRepository.withAssetMetadataLock(id, async (trx) => {
      const { description } = await this.getEnrichmentMetadata(id, trx);
      return description?.status === 'success' && description.provenance?.identityHash !== names;
    });
    const withdrawnCaptions =
      asset.type === AssetType.Video && this.videoMoments
        ? await this.videoMoments.withdrawStaleCaptions(id, names)
        : 0;
    return { describe, withdrawnCaptions };
  }

  /**
   * Describe one photo or video. The queue job runs it with the routed destination and the saved
   * model and prompt; an enrichment plan (FL-59) runs it with the destination and configuration it
   * pinned, so a plan never changes model or destination partway through.
   *
   * A video is described from its reusable frames (FL-59), cut here when it has none yet. Duplicate
   * detection is not a prerequisite any more.
   *
   * Every successful description records its provenance: the destination, the prompt digest, the
   * digest of the confirmed names it was given and the fingerprint of the original. If the original
   * is replaced while the model is working, the result is not published (`source-changed`).
   */
  async describeAsset(id: string, options: EnrichmentRunOptions = {}): Promise<EnrichmentStageResult> {
    const config = await this.getConfig({ withCache: true });
    const machineLearning = withPinnedConfig(config.machineLearning, options);
    if (!isImageDescriptionEnabled(machineLearning)) {
      return { status: JobStatus.Skipped, reasonKey: 'disabled' };
    }

    const asset = await this.assetJobRepository.getForImageEnrichment(id);
    if (!asset || !this.isEligibleForDescription(asset)) {
      return { status: JobStatus.Skipped, reasonKey: 'not-eligible' };
    }

    if (!asset.previewFile) {
      return { status: JobStatus.Skipped, reasonKey: 'no-preview' };
    }

    // FL-163: the description stage routed (or pinned) to Frameleaf Cloud runs in batches, never one
    // photo at a time, and nothing is sent from here
    const cloud = await this.cloudDescriptionDestination(options);
    if (cloud) {
      return this.leaveForCloudBatch(asset, config, machineLearning.imageDescription.modelName);
    }

    const fingerprintBefore = await this.getSourceFingerprint(id);

    // A video is described as a grid of its reusable frames. When none can be cut (too short, too
    // long, unreadable), persist a `skipped` status with `video-frames-unavailable` so the badge can
    // explain why, and bail without invoking the model — a single thumbnail is a poor input.
    let videoGrid: { path: string; videoContext: VideoContext } | undefined;
    if (asset.type === AssetType.Video) {
      videoGrid = await this.prepareVideoGrid(asset.id, asset.ownerId, config);
      if (!videoGrid) {
        await this.databaseRepository.withAssetMetadataLock(id, async (trx) => {
          const m = await this.getEnrichmentMetadata(id, trx);
          m.description = {
            status: 'skipped',
            updatedAt: new Date().toISOString(),
            reason: 'video-frames-unavailable',
          };
          await this.saveEnrichmentMetadata(id, m, trx);
        });
        return { status: JobStatus.Skipped, reasonKey: 'video-frames-unavailable' };
      }
    }

    const descriptionInputPath = videoGrid ? videoGrid.path : asset.previewFile!;

    // Snapshot the metadata to decide whether NSFW inference is needed; the
    // canonical read happens again inside the lock when we persist.
    const snapshot = await this.getEnrichmentMetadata(id);

    let nsfw = this.getStoredNsfw(snapshot);
    let nsfwIsFresh = false;
    if (!nsfw && isNsfwDetectionEnabled(machineLearning)) {
      try {
        // NSFW always runs against the preview thumbnail, not the composite
        // grid — the classifier is calibrated for single-image input.
        const selection = await this.selectEnrichmentDestination(
          MlWorkload.Enrichment,
          JobName.ImageDescription,
          id,
          options,
        );
        nsfw = await this.machineLearningRepository.detectNsfw(
          selection,
          asset.previewFile!,
          machineLearning.nsfwDetection,
        );
        nsfwIsFresh = true;
      } catch (error) {
        // NSFW failure is non-fatal for description; persist the failed
        // detection status alongside whatever description result we get.
        await this.databaseRepository.withAssetMetadataLock(id, async (trx) => {
          const m = await this.getEnrichmentMetadata(id, trx);
          m.nsfwDetection = {
            status: 'failed',
            modelName: machineLearning.nsfwDetection.modelName,
            updatedAt: new Date().toISOString(),
            error: getErrorMessage(error),
            ...(m.nsfwDetection?.review && { review: m.nsfwDetection.review }),
          };
          await this.saveEnrichmentMetadata(id, m, trx);
        });
        nsfw = undefined;
      }
    }

    const knownPersons = await this.getKnownPersonsForAsset(asset.id, asset.ownerId);

    let result: ImageDescriptionResult;
    let destinationId: string;
    try {
      const { prompt } = this.promptAssembler.build({
        config: machineLearning.imageDescription.prompt,
        knownPersons,
        nsfw: nsfw ? { isNsfw: nsfw.isNsfw } : null,
        videoContext: videoGrid?.videoContext,
      });
      const selection = await this.selectEnrichmentDestination(
        MlWorkload.Enrichment,
        JobName.ImageDescription,
        id,
        options,
      );
      destinationId = selection.destinationId;
      result = await this.machineLearningRepository.describeImage(
        selection,
        descriptionInputPath,
        machineLearning.imageDescription,
        nsfw,
        prompt,
      );
    } catch (error) {
      await this.databaseRepository.withAssetMetadataLock(id, async (trx) => {
        const m = await this.getEnrichmentMetadata(id, trx);
        m.description = {
          status: 'failed',
          modelName: machineLearning.imageDescription.modelName,
          updatedAt: new Date().toISOString(),
          error: getErrorMessage(error),
        };
        await this.saveEnrichmentMetadata(id, m, trx);
      });
      return { status: JobStatus.Failed, reasonKey: 'model-error', message: getErrorMessage(error) };
    } finally {
      // The composite grid is cheap to rebuild from the reusable frames; clean up after every run.
      if (videoGrid) {
        await this.storageRepository.unlink(videoGrid.path).catch(() => {});
      }
    }

    // FL-36: keep a reported confidence only when it is a real 0-1 number; never invent one
    result = { ...result, confidence: descriptionConfidence(result) };

    // The original was replaced while the model was working: this description is of a file the
    // library no longer holds. Publish nothing; the next run describes the new original.
    if (fingerprintBefore && (await this.getSourceFingerprint(id)) !== fingerprintBefore) {
      return { status: JobStatus.Skipped, reasonKey: 'source-changed' };
    }

    // Post-validate the ML description against known persons: strip any
    // hallucinated names and substitute unambiguous generic person references.
    // Only runs when there is at least one known person and a non-empty
    // description — the validator is a no-op otherwise.
    let identityFlags: { hallucinatedNames?: string[]; ambiguousReferences?: string[] } | undefined;
    if (result.description && knownPersons.length > 0) {
      const { description: validatedDescription, flags } = this.identityPostValidator.validate(
        result.description,
        knownPersons,
      );
      result = { ...result, description: validatedDescription };
      if (flags.hallucinatedNames || flags.ambiguousReferences) {
        identityFlags = flags;
      }
    }

    const provenance: EnrichmentResultProvenance = {
      destinationId,
      identityHash: identityHash(knownPersons.map(({ name }) => name)),
      ...(fingerprintBefore && { sourceFingerprint: fingerprintBefore }),
      ...(options.configHash && { planConfigHash: options.configHash }),
    };

    // Phase: serialize the RMW so reviewer / NSFW writes can't clobber the
    // description (and vice versa). ML inference is already done above.
    const published = await this.databaseRepository.withAssetMetadataLock(id, async (trx) => {
      // FL-57: the names the prompt was given are checked again under the lock. A face correction or
      // rename that landed while the model was working (its invalidation takes this same lock) means
      // this description may name the wrong people: publish nothing and describe the asset again.
      const namesNow = identityHash(
        (await this.getKnownPersonsForAsset(asset.id, asset.ownerId)).map(({ name }) => name),
      );
      if (namesNow !== provenance.identityHash) {
        return null;
      }

      if (isNsfwHidingEnabled(machineLearning)) {
        await this.lockGroupRows(id, trx);
      }
      const m = await this.getEnrichmentMetadata(id, trx);
      const previousDescription =
        m.description?.status === 'success' && m.description.appliedDescriptionHash
          ? m.description.result.description
          : undefined;
      const previousTagValues = m.description?.status === 'success' ? (m.description.appliedTagValues ?? []) : [];

      if (nsfwIsFresh && nsfw && !this.getStoredNsfw(m)) {
        const appliedTagHash = m.nsfwDetection?.status === 'success' ? m.nsfwDetection.appliedTagHash : undefined;
        const appliedTagValues = m.nsfwDetection?.status === 'success' ? m.nsfwDetection.appliedTagValues : undefined;
        m.nsfwDetection = {
          status: 'success',
          modelName: machineLearning.nsfwDetection.modelName,
          updatedAt: new Date().toISOString(),
          result: nsfw,
          appliedTagHash,
          appliedTagValues,
          ...(m.nsfwDetection?.review && { review: m.nsfwDetection.review }),
        };
      }

      m.description = {
        status: 'success',
        modelName: machineLearning.imageDescription.modelName,
        updatedAt: new Date().toISOString(),
        result,
        configHash: promptConfigHash(machineLearning.imageDescription.prompt),
        provenance,
        ...(identityFlags && { identityFlags }),
      };
      await this.saveEnrichmentMetadata(id, m, trx);
      // a sensitive verdict from either the detector or the description locks it (FL-34)
      const locked = await this.lockIfDetected(id, m, isNsfwHidingEnabled(machineLearning), trx);
      return { metadata: m, previousDescription, previousTagValues, locked };
    });
    if (!published) {
      this.logger.debug(`The people in asset ${id} changed while it was described; describing it again`);
      // a plan retries the stage itself with its pinned destination; the queue job is queued again
      if (!options.planRun) {
        await this.jobRepository.queue({ name: JobName.ImageDescription, data: { id } });
      }
      return { status: options.planRun ? JobStatus.Failed : JobStatus.Skipped, reasonKey: 'identity-changed' };
    }
    const { metadata, previousDescription, previousTagValues, locked } = published;
    await this.afterSensitiveLock(locked);

    // A plan that pinned no search destination (search was off when it was queued) leaves the
    // description embedding alone rather than sending the text to an unpinned destination.
    if (isSmartSearchEnabled(machineLearning) && (!options.planRun || options.searchDestinationId)) {
      await this.upsertDescriptionEmbedding(id, result.description, machineLearning.clip, options);
    }

    const changed = await this.applyVisibleMetadata({
      id,
      keepManual: config.libraryCare.manualMetadata,
      ownerId: asset.ownerId,
      existingDescription: asset.description ?? '',
      result,
      nsfw,
      metadata,
      previousDescription,
      previousTagValues,
    });

    if (changed.metadata) {
      await this.persistAppliedBookkeeping(id, metadata);
    }
    if (changed.visible) {
      await this.jobRepository.queue({ name: JobName.SidecarWrite, data: { id } });
    }

    // Smart-album evaluation: outside the metadata lock to keep the lock window
    // small. Non-fatal — description has already succeeded; smart-album
    // bookkeeping is best-effort.
    try {
      await this.smartAlbumService.evaluate({
        assetId: asset.id,
        ownerId: asset.ownerId,
        tags: result.tags ?? [],
      });
    } catch (error) {
      this.logger.warn(`Smart-album evaluation failed for asset ${asset.id}: ${getErrorMessage(error)}`);
    }
    // The owner's own classification rules (FL-60) see the new description tags. Never throws.
    await this.classificationService.evaluateAsset(asset.id, asset.ownerId);

    return { status: JobStatus.Success };
  }

  /**
   * Describe one asset with a draft model and prompt, and write nothing (FL-59, sample-first
   * enrichment). The stored description, tags, Locked state, embeddings and frames are untouched:
   * a video without reusable frames is cut into a temporary folder that is removed afterwards, and
   * the Locked-content verdict is read, not recomputed. The only record is the destination's own
   * request accounting (FL-110).
   */
  async previewDescription(
    id: string,
    options: { imageDescription: SystemConfig['machineLearning']['imageDescription']; destinationId: string },
  ): Promise<DescriptionPreview> {
    const config = await this.getConfig({ withCache: true });
    const asset = await this.assetJobRepository.getForImageEnrichment(id);
    if (!asset || !this.isEligibleForDescription(asset) || !asset.previewFile) {
      return { status: 'skipped', reasonKey: 'not-eligible' };
    }

    const stored = await this.getEnrichmentMetadata(id);
    const nsfw = this.getStoredNsfw(stored);
    const knownPersons = await this.getKnownPersonsForAsset(asset.id, asset.ownerId);
    const current = stored.description?.status === 'success' ? stored.description.result.description : null;
    const startedAt = Date.now();

    const describe = async (inputPath: string, videoContext?: VideoContext): Promise<DescriptionPreview> => {
      const { prompt, warnings } = this.promptAssembler.build({
        config: options.imageDescription.prompt,
        knownPersons,
        nsfw: nsfw ? { isNsfw: nsfw.isNsfw } : null,
        videoContext,
      });
      try {
        const selection = await this.selectMlDestination({
          workload: MlWorkload.Enrichment,
          destinationId: options.destinationId,
          jobId: id,
          jobName: 'enrichment-preview',
        });
        let result = await this.machineLearningRepository.describeImage(
          selection,
          inputPath,
          options.imageDescription,
          nsfw,
          prompt,
        );
        let identityFlags: { hallucinatedNames?: string[]; ambiguousReferences?: string[] } | undefined;
        if (result.description && knownPersons.length > 0) {
          const { description, flags } = this.identityPostValidator.validate(result.description, knownPersons);
          result = { ...result, description };
          if (flags.hallucinatedNames || flags.ambiguousReferences) {
            identityFlags = flags;
          }
        }
        return {
          status: 'success',
          current,
          candidate: result.description,
          tags: result.tags ?? [],
          identityFlags,
          warnings,
          modelName: options.imageDescription.modelName,
          destinationId: selection.destinationId,
          frameCount: videoContext?.timestampsMs.length ?? 0,
          durationMs: Date.now() - startedAt,
        };
      } catch (error) {
        return { status: 'failed', current, message: getErrorMessage(error), warnings };
      }
    };

    if (asset.type !== AssetType.Video) {
      return describe(asset.previewFile);
    }

    const moments = this.videoMoments;
    if (!moments) {
      return { status: 'skipped', reasonKey: 'video-frames-unavailable' };
    }

    const folder = await mkdtemp(join(tmpdir(), 'frameleaf-description-preview-'));
    try {
      const gridPath = join(folder, 'grid.jpeg');
      const fingerprint = await this.getSourceFingerprint(id);
      const [index, frames] = await Promise.all([moments.getIndex(id), moments.getFrames(id)]);
      if (index && frames.length >= 2 && index.sourceFingerprint === fingerprint) {
        const grid = await this.composeGrid(frames, gridPath, id);
        return grid
          ? describe(grid.path, grid.videoContext)
          : { status: 'skipped', reasonKey: 'video-frames-unavailable' };
      }

      const described = await withTemporaryFrames(
        { media: this.mediaRepository, storage: this.storageRepository, moments, logger: this.logger },
        id,
        config,
        async (cut) => {
          const grid = await this.composeGrid(cut, gridPath, id);
          return grid ? describe(grid.path, grid.videoContext) : undefined;
        },
      );
      return described ?? { status: 'skipped', reasonKey: 'video-frames-unavailable' };
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }

  /**
   * FL-163: the Frameleaf Cloud destination this description would go to (the one a plan pinned, else
   * the routed one), or undefined when it goes to this server or a home-network worker. Only the row is
   * read: nothing is admitted or contacted here.
   */
  private cloudDescriptionDestination(options: EnrichmentRunOptions) {
    if (options.planRun && !options.enrichmentDestinationId) {
      return Promise.resolve(undefined);
    }
    return cloudDescriptionDestination(this.mlDestinationRepository, options.enrichmentDestinationId);
  }

  /**
   * FL-163: a description routed to Frameleaf Cloud waits for a batch. With "Describe new photos
   * automatically" on, a photo joins the automatic queue; otherwise (and for a video, which Frameleaf
   * Cloud does not describe) it waits for a backfill, which shows its estimate first. While processing
   * is turned off or descriptions are kept on this server it is refused, and says so: it is not waiting
   * for anything. It is never described on this server instead.
   */
  private async leaveForCloudBatch(
    asset: { id: string; ownerId: string; type: AssetType },
    config: SystemConfig,
    modelName: string,
  ): Promise<EnrichmentStageResult> {
    const { cloudMl } = config.frameleafCloud;
    if (!cloudMl.enabled || !cloudRouteAllows(cloudMl, MlWorkload.Enrichment)) {
      const error =
        'Descriptions are routed to Frameleaf Cloud, but Frameleaf Cloud processing is turned off or Where each job runs keeps descriptions on this server. Nothing was sent.';
      await this.databaseRepository.withAssetMetadataLock(asset.id, async (trx) => {
        const m = await this.getEnrichmentMetadata(asset.id, trx);
        m.description = { status: 'failed', modelName, updatedAt: new Date().toISOString(), error };
        await this.saveEnrichmentMetadata(asset.id, m, trx);
      });
      return { status: JobStatus.Failed, reasonKey: 'cloud-turned-off', message: error };
    }
    if (asset.type !== AssetType.Image) {
      return { status: JobStatus.Skipped, reasonKey: 'cloud-photos-only' };
    }
    if (cloudMl.autoDescribe.enabled) {
      await this.cloudQueue.add({ assetId: asset.id, ownerId: asset.ownerId });
    }
    return { status: JobStatus.Skipped, reasonKey: 'cloud-batch' };
  }

  /** FL-163: write the new photos waiting in memory to the automatic queue now. */
  flushCloudDescriptionQueue(): Promise<void> {
    return this.cloudQueue.flush();
  }

  @OnEvent({ name: 'AppShutdown' })
  async onShutdownFlushCloudDescriptionQueue() {
    try {
      await this.cloudQueue.flush();
    } catch (error) {
      this.logger.warn(`The Frameleaf Cloud description queue was not written: ${getErrorMessage(error)}`);
    }
  }

  /**
   * Admit one request against the destination a plan pinned (FL-110) or, without one, the routed
   * destination. Never a different one: a pinned destination that is gone or refuses fails the
   * stage in place.
   */
  private selectEnrichmentDestination(
    workload: MlWorkload,
    jobName: JobName,
    assetId: string,
    options: EnrichmentRunOptions,
  ) {
    const destinationId = workload === MlWorkload.Clip ? options.searchDestinationId : options.enrichmentDestinationId;
    const jobId = options.jobId ?? assetId;
    if (options.planRun && !destinationId) {
      throw new BadRequestException(`This plan has no processing destination for ${workload}`);
    }
    return destinationId
      ? this.selectMlDestination({ workload, destinationId, jobId, jobName })
      : this.selectRoutedMlDestination({ workload, jobId, jobName });
  }

  /** Reusable frames (FL-59), on the injected database. Tests hand one in with `useVideoMomentRepository`. */
  private _videoMoments?: VideoMomentRepository;

  private get videoMoments(): VideoMomentRepository | undefined {
    if (!this._videoMoments && this.db) {
      this._videoMoments = new VideoMomentRepository(this.db);
    }
    return this._videoMoments;
  }

  useVideoMomentRepository(repository: VideoMomentRepository) {
    this._videoMoments = repository;
  }

  /** The fingerprint of the asset's original now, or undefined when it cannot be read. */
  private async getSourceFingerprint(id: string): Promise<string | undefined> {
    const moments = this.videoMoments;
    if (!moments) {
      return undefined;
    }
    return (await moments.getFingerprints([id])).get(id);
  }

  private toResponse(
    id: string,
    metadata: EnrichmentMetadata,
    staleReason: EnrichmentStaleReason | null = null,
  ): AssetImageEnrichmentResponseDto {
    const description = metadata.description;
    const nsfwDetection = metadata.nsfwDetection;

    return {
      assetId: id,
      description:
        description?.status === 'success'
          ? {
              status: 'success',
              modelName: description.modelName,
              updatedAt: description.updatedAt,
              description: description.result.description,
              confidence: descriptionConfidence(description.result),
              tags: description.result.tags,
              objects: description.result.objects,
              people: description.result.people,
              environment: description.result.environment,
              visibleText: description.result.visible_text,
              context: description.result.context,
              appliedDescription: !!description.appliedDescriptionHash,
              appliedTags: !!description.appliedTagHash,
              destinationId: description.provenance?.destinationId,
              staleReason: staleReason ?? undefined,
            }
          : {
              status: description?.status ?? 'missing',
              modelName: description?.modelName,
              updatedAt: description?.updatedAt,
              error: description?.status === 'failed' ? description.error : undefined,
              skipReason: description?.status === 'skipped' ? description.reason : undefined,
              confidence: null,
              appliedDescription: false,
              appliedTags: false,
            },
      nsfwDetection:
        nsfwDetection?.status === 'success'
          ? {
              status: 'success',
              modelName: nsfwDetection.modelName,
              updatedAt: nsfwDetection.updatedAt,
              isNsfw: nsfwDetection.result.isNsfw,
              effectiveIsNsfw: this.getEffectiveNsfw(metadata) ?? false,
              score: nsfwDetection.result.score,
              labels: nsfwDetection.result.labels,
              review: nsfwDetection.review,
              appliedTags: !!nsfwDetection.appliedTagHash,
            }
          : {
              status: nsfwDetection?.status ?? 'missing',
              modelName: nsfwDetection?.modelName,
              updatedAt: nsfwDetection?.updatedAt,
              error: nsfwDetection?.status === 'failed' ? nsfwDetection.error : undefined,
              effectiveIsNsfw: this.getEffectiveNsfw(metadata) ?? false,
              review: nsfwDetection?.review,
              appliedTags: false,
            },
    };
  }

  private getReview(auth: AuthDto, action: EnrichmentReview['action'], isNsfw: boolean): EnrichmentReview {
    return {
      action,
      isNsfw,
      reviewedAt: new Date().toISOString(),
      reviewedBy: auth.user.id,
    };
  }

  private async finalizeRepair(
    id: string,
    changed: { visible: boolean; metadata: boolean },
    metadata: EnrichmentMetadata,
  ) {
    if (changed.metadata) {
      await this.persistAppliedBookkeeping(id, metadata);
    }

    if (changed.visible) {
      await this.jobRepository.queue({ name: JobName.SidecarWrite, data: { id } });
    }
  }

  /**
   * Re-lock and merge only the tag-application bookkeeping fields
   * (`appliedDescriptionHash`, `appliedTagHash`, `appliedTagValues`) from an
   * in-memory snapshot into the freshly-read metadata, then persist.
   *
   * Tag application and ML inference happen outside the per-asset lock to
   * keep the lock window short. Naively saving the post-side-effect snapshot
   * would clobber any concurrent writes to other JSON keys (e.g. a reviewer
   * setting `nsfwDetection.review` between phases). This helper preserves
   * those concurrent writes while still recording the bookkeeping deltas the
   * caller computed.
   */
  private async persistAppliedBookkeeping(id: string, snapshot: EnrichmentMetadata) {
    await this.databaseRepository.withAssetMetadataLock(id, async (trx) => {
      const m = await this.getEnrichmentMetadata(id, trx);

      if (m.description?.status === 'success' && snapshot.description?.status === 'success') {
        copyAppliedFields(m.description, snapshot.description, [
          'appliedDescriptionHash',
          'appliedTagHash',
          'appliedTagValues',
        ]);
      }

      if (m.nsfwDetection?.status === 'success' && snapshot.nsfwDetection?.status === 'success') {
        copyAppliedFields(m.nsfwDetection, snapshot.nsfwDetection, ['appliedTagHash', 'appliedTagValues']);
      }

      await this.saveEnrichmentMetadata(id, m, trx);
    });
  }

  private ensureManualNsfwMetadata(metadata: EnrichmentMetadata, isNsfw: boolean): NsfwEnrichmentTask {
    if (metadata.nsfwDetection?.status === 'success') {
      return metadata.nsfwDetection;
    }

    metadata.nsfwDetection = {
      status: 'success',
      modelName: 'manual-review',
      updatedAt: new Date().toISOString(),
      result: {
        isNsfw,
        score: isNsfw ? 1 : 0,
        labels: {},
      },
    };
    return metadata.nsfwDetection;
  }

  private getEffectiveNsfw(metadata: EnrichmentMetadata) {
    const nsfw = metadata.nsfwDetection;

    if (nsfw?.review) {
      return nsfw.review.isNsfw;
    }

    if (nsfw?.status === 'success' && nsfw.result.isNsfw) {
      return true;
    }

    const description = metadata.description?.status === 'success' ? metadata.description.result : undefined;
    if (this.isDescriptionNsfwLikely(description)) {
      return true;
    }

    return nsfw?.status === 'success' ? false : undefined;
  }

  private async clearGeneratedDescription(id: string, existingDescription: string, metadata: EnrichmentMetadata) {
    if (metadata.description?.status !== 'success' || !metadata.description.appliedDescriptionHash) {
      return { visible: false, metadata: false };
    }

    const description = withoutGeneratedDescriptionBlocks(existingDescription, [
      metadata.description.result.description,
    ]);

    const sidecarOnly = await this.isEnrichmentSidecarAuthoritative();
    const visible = !sidecarOnly && description !== existingDescription.trim();
    if (visible) {
      await this.assetRepository.upsertExif({
        exif: updateLockedColumns({ assetId: id, description }),
        lockedPropertiesBehavior: 'append',
      });
    }

    delete metadata.description.appliedDescriptionHash;
    return { visible, metadata: true };
  }

  private getStoredGeneratedTags(metadata: EnrichmentMetadata) {
    const tags = new Set<string>();

    if (metadata.description?.status === 'success' && metadata.description.appliedTagValues) {
      for (const tag of metadata.description.appliedTagValues) {
        tags.add(tag);
      }
    }

    if (metadata.nsfwDetection?.status === 'success' && metadata.nsfwDetection.appliedTagValues) {
      for (const tag of metadata.nsfwDetection.appliedTagValues) {
        tags.add(tag);
      }
    }

    return [...tags];
  }

  private async clearGeneratedTags(id: string, ownerId: string, tags: string[]) {
    if (await this.isEnrichmentSidecarAuthoritative()) {
      return { visible: false, metadata: false };
    }
    let visible = false;
    for (const tag of tags) {
      const existing = await this.tagRepository.getByValue(ownerId, tag);
      if (!existing) {
        continue;
      }

      await this.tagRepository.removeAssetIds(existing.id, [id]);
      visible = true;
    }

    if (visible) {
      await this.updateExifTags(id);
      await this.eventRepository.emit('AssetUntag', { assetId: id });
    }

    return { visible, metadata: false };
  }

  // Encodes the freshly generated description through CLIP's text encoder
  // and persists the result alongside the visual embedding. Smart search
  // blends this in so an asset can match a query via what the VLM said
  // about it, not only via what the visual encoder saw. Failures are
  // logged but never fail the enrichment job.
  private async upsertDescriptionEmbedding(
    assetId: string,
    description: string,
    clipConfig: { modelName: string },
    options: EnrichmentRunOptions = {},
  ): Promise<void> {
    const text = description?.trim();
    if (!text) {
      await this.searchRepository.deleteDescriptionEmbedding(assetId).catch((error) => {
        this.logger.warn(`Failed to clear description embedding for asset ${assetId}: ${getErrorMessage(error)}`);
      });
      return;
    }
    try {
      const selection = await this.selectEnrichmentDestination(
        MlWorkload.Clip,
        JobName.ImageDescription,
        assetId,
        options,
      );
      const embedding = await this.machineLearningRepository.encodeText(selection, text, {
        modelName: clipConfig.modelName,
      });
      await this.searchRepository.upsertDescriptionEmbedding(assetId, embedding);
    } catch (error) {
      this.logger.warn(`Failed to embed description for asset ${assetId}: ${getErrorMessage(error)}`);
    }
  }

  private getStoredNsfw(metadata: EnrichmentMetadata) {
    if (metadata.nsfwDetection?.status !== 'success') {
      return;
    }

    const isNsfw = this.getEffectiveNsfw(metadata);
    return isNsfw === undefined ? metadata.nsfwDetection.result : { ...metadata.nsfwDetection.result, isNsfw };
  }

  private isEligibleImage(
    asset:
      | {
          type: AssetType;
          status: AssetStatus;
          deletedAt: Date | null;
          visibility: AssetVisibility;
        }
      | undefined,
  ) {
    return (
      asset?.type === AssetType.Image &&
      asset.status === AssetStatus.Active &&
      asset.deletedAt === null &&
      (asset.visibility === AssetVisibility.Timeline || asset.visibility === AssetVisibility.Archive)
    );
  }

  private isEligibleForDescription(
    asset:
      | {
          type: AssetType;
          status: AssetStatus;
          deletedAt: Date | null;
          visibility: AssetVisibility;
        }
      | undefined,
  ) {
    return (
      !!asset &&
      (asset.type === AssetType.Image || asset.type === AssetType.Video) &&
      asset.status === AssetStatus.Active &&
      asset.deletedAt === null &&
      (asset.visibility === AssetVisibility.Timeline || asset.visibility === AssetVisibility.Archive)
    );
  }

  /**
   * Once the sidecars are authoritative the privacy row decides the sensitive verdict and review.
   * A missing row is "no classification yet" (FL-34): the stored enrichment is read as it is, with no
   * verdict laid over it, and the next save creates the row (`ForkPrivacyRepository.saveClassification`).
   */
  private async getEnrichmentMetadata(id: string, kysely?: Kysely<DB>): Promise<EnrichmentMetadata> {
    const database = kysely ?? this.db;
    let authoritativePrivacy: PrivacySidecar | undefined;
    if (this.db) {
      const privacyRepository = new ForkPrivacyRepository(this.db);
      if (await privacyRepository.shouldReadSidecar(database)) {
        authoritativePrivacy = await privacyRepository.get(id, database);
      }
    }
    let metadata: EnrichmentMetadata;
    if (this.db && database && (await new ForkEnrichmentRepository(this.db).shouldReadSidecar(database))) {
      const sidecar = await new ForkEnrichmentRepository(this.db).get(id, database);
      if (!sidecar) {
        throw new Error(`Missing fork enrichment sidecar for asset ${id}`);
      }
      metadata = sidecar.provenance as EnrichmentMetadata;
    } else {
      const row = await this.assetRepository.getMetadataByKey(id, AssetMetadataKey.MlEnrichment, kysely);
      metadata = isRecord(row?.value) ? (row.value as EnrichmentMetadata) : {};
    }
    if (!this.db) {
      return metadata;
    }

    if (!authoritativePrivacy) {
      return metadata;
    }
    return this.applyPrivacySidecar(metadata, authoritativePrivacy);
  }

  private async saveEnrichmentMetadata(id: string, value: EnrichmentMetadata, kysely?: Kysely<DB>) {
    const database = kysely ?? this.db;
    if (!this.db || !database) {
      await this.assetRepository.upsertMetadata(
        id,
        [{ key: AssetMetadataKey.MlEnrichment, value: value as Record<string, unknown> }],
        kysely,
      );
      return;
    }
    const repository = new ForkEnrichmentRepository(this.db);
    const sidecarOnly = await repository.shouldReadSidecar(database);
    if (!sidecarOnly) {
      await this.assetRepository.upsertMetadata(
        id,
        [{ key: AssetMetadataKey.MlEnrichment, value: value as Record<string, unknown> }],
        kysely,
      );
    }
    await repository.save(id, value as Record<string, unknown>, database);
    if (sidecarOnly) {
      // FL-34: once the sidecars are authoritative, the privacy projection that every read filters on
      // is written with the enrichment in the caller's transaction (before the cutover
      // `upsertMetadata` keeps `asset.is_nsfw` and the mirror in step the same way).
      await new ForkPrivacyRepository(this.db).saveClassification(
        id,
        this.getEffectiveNsfw(value),
        (value.nsfwDetection?.review as Record<string, unknown> | undefined) ?? null,
        database,
      );
    }
  }

  private applyPrivacySidecar(metadata: EnrichmentMetadata, privacy: PrivacySidecar): EnrichmentMetadata {
    const current = metadata.nsfwDetection;
    const suppression = privacy.suppression as EnrichmentReview | null;
    if (current?.status === 'success') {
      const nsfwDetection: NsfwEnrichmentTask = {
        ...current,
        result: { ...current.result, isNsfw: privacy.isNsfw },
      };
      if (suppression) {
        nsfwDetection.review = suppression;
      } else {
        delete nsfwDetection.review;
      }
      return { ...metadata, nsfwDetection };
    }

    return {
      ...metadata,
      nsfwDetection: {
        status: 'success',
        modelName: 'privacy-sidecar',
        updatedAt: suppression?.reviewedAt ?? new Date(0).toISOString(),
        result: { isNsfw: privacy.isNsfw, score: privacy.isNsfw ? 1 : 0, labels: {} },
        ...(suppression && { review: suppression }),
      },
    };
  }

  private async applyVisibleMetadata({
    id,
    keepManual = true,
    ownerId,
    existingDescription,
    result,
    nsfw,
    metadata,
    previousDescription,
    previousTagValues,
  }: {
    id: string;
    /**
     * Library care → "Preserve manual metadata on rerun" (FL-69, settings-catalog.mjs:972-977). On,
     * the rerun replaces only the generated block its provenance identifies and keeps what a person
     * wrote; off, the generated description replaces the whole visible description. Tags a person
     * added are never touched either way: only the generated ones are recorded, so only they go.
     */
    keepManual?: boolean;
    ownerId: string;
    existingDescription: string;
    result: ImageDescriptionResult;
    nsfw?: NsfwDetectionResult;
    metadata: EnrichmentMetadata;
    previousDescription?: string;
    previousTagValues: string[];
  }) {
    let visible = false;
    let metadataChanged = false;
    const enrichmentRepository = this.db ? new ForkEnrichmentRepository(this.db) : undefined;
    const sidecarOnly = !!enrichmentRepository && (await enrichmentRepository.shouldReadSidecar());

    const descriptionHash = hash(result.description);
    if (
      result.description &&
      metadata.description?.status === 'success' &&
      metadata.description.appliedDescriptionHash !== descriptionHash
    ) {
      const block = getGeneratedDescriptionBlock(result.description);
      const baseDescription = keepManual
        ? withoutGeneratedDescriptionBlocks(existingDescription, previousDescription ? [previousDescription] : [])
        : '';

      if (!sidecarOnly && block && !baseDescription.includes(block)) {
        const description = baseDescription ? `${baseDescription}\n\n${block}` : block;
        await this.assetRepository.upsertExif({
          exif: updateLockedColumns({ assetId: id, description }),
          lockedPropertiesBehavior: 'append',
        });
        visible = true;
      }
      metadata.description.appliedDescriptionHash = descriptionHash;
      metadataChanged = true;
    }

    const tags = this.getTags(result, nsfw, metadata);
    const tagHash = hash(tags);
    const descriptionMetadata = metadata.description?.status === 'success' ? metadata.description : undefined;
    const hasStoredTagApplication =
      !!descriptionMetadata?.appliedTagHash || !!descriptionMetadata?.appliedTagValues?.length;
    if (
      descriptionMetadata &&
      (tags.length > 0 || hasStoredTagApplication) &&
      descriptionMetadata.appliedTagHash !== tagHash
    ) {
      if (!sidecarOnly) {
        const cleared = await this.clearGeneratedTags(id, ownerId, previousTagValues);
        visible ||= cleared.visible;
      }

      if (tags.length > 0) {
        const tagsChanged = sidecarOnly
          ? { visible: false, appliedTagValues: tags }
          : await this.upsertAssetTags(id, ownerId, tags);
        visible ||= tagsChanged.visible;

        descriptionMetadata.appliedTagHash = tagHash;
        descriptionMetadata.appliedTagValues = tagsChanged.appliedTagValues;
      } else {
        delete descriptionMetadata.appliedTagHash;
        delete descriptionMetadata.appliedTagValues;
      }
      metadataChanged = true;
    }

    return { visible, metadata: metadataChanged };
  }

  private async applyNsfwTags(id: string, ownerId: string, nsfw: NsfwDetectionResult, metadata: EnrichmentMetadata) {
    if (metadata.nsfwDetection?.status !== 'success') {
      return { visible: false, metadata: false };
    }

    if (!nsfw.isNsfw) {
      return this.clearAppliedNsfwTags(id, ownerId, metadata);
    }

    const tags = this.getNsfwTags(nsfw);
    const tagHash = hash(tags);
    if (metadata.nsfwDetection.appliedTagHash === tagHash) {
      return { visible: false, metadata: false };
    }

    if (await this.isEnrichmentSidecarAuthoritative()) {
      metadata.nsfwDetection.appliedTagHash = tagHash;
      metadata.nsfwDetection.appliedTagValues = tags;
      return { visible: false, metadata: true };
    }

    const cleared = await this.clearGeneratedTags(id, ownerId, metadata.nsfwDetection.appliedTagValues ?? []);
    const tagsChanged = await this.upsertAssetTags(id, ownerId, tags);
    metadata.nsfwDetection.appliedTagHash = tagHash;
    metadata.nsfwDetection.appliedTagValues = tagsChanged.appliedTagValues;
    return { visible: cleared.visible || tagsChanged.visible, metadata: true };
  }

  private async clearAppliedNsfwTags(id: string, ownerId: string, metadata: EnrichmentMetadata) {
    const changed = await this.clearGeneratedTags(
      id,
      ownerId,
      metadata.nsfwDetection?.status === 'success' ? (metadata.nsfwDetection.appliedTagValues ?? []) : [],
    );

    if (metadata.nsfwDetection?.status === 'success') {
      delete metadata.nsfwDetection.appliedTagHash;
      delete metadata.nsfwDetection.appliedTagValues;
      changed.metadata = true;
    }

    return changed;
  }

  private async isEnrichmentSidecarAuthoritative(kysely?: Kysely<DB>): Promise<boolean> {
    return !!this.db && new ForkEnrichmentRepository(this.db).shouldReadSidecar(kysely ?? this.db);
  }

  private getTags(result: ImageDescriptionResult, nsfw?: NsfwDetectionResult, metadata?: EnrichmentMetadata) {
    // Privacy-derived tags always apply, regardless of the 24-tag truncation
    // budget. The model's free-form tag list is variable-quality and may
    // legitimately span many topics, but NSFW and medical classifications are
    // load-bearing for fork filtering — dropping them silently would
    // misclassify an asset.
    const required = new Set<string>();
    const effectiveNsfw = metadata ? this.getEffectiveNsfw(metadata) : nsfw?.isNsfw;

    if (effectiveNsfw) {
      const effectiveNsfwResult = nsfw?.isNsfw ? nsfw : this.getDescriptionNsfwResult(result);
      for (const tag of this.getNsfwTags(effectiveNsfwResult)) {
        required.add(tag);
      }
    }

    if (result.medical?.is_medical_likely) {
      required.add('medical');
      for (const indicator of result.medical.indicators) {
        const normalized = normalizeTag(indicator);
        if (normalized) {
          required.add(normalized);
        }
      }
    }

    const TAG_BUDGET = 24;
    const remaining = Math.max(0, TAG_BUDGET - required.size);
    const optional = new Set<string>();
    for (const tag of result.tags ?? []) {
      if (optional.size >= remaining) {
        break;
      }
      const normalized = normalizeTag(tag);
      if (normalized && !required.has(normalized) && (effectiveNsfw || !this.isNsfwTag(normalized))) {
        optional.add(normalized);
      }
    }

    return [...required, ...optional];
  }

  private isNsfwTag(tag: string) {
    return tag === 'nsfw' || STRONG_NSFW_INDICATORS.has(tag);
  }

  private isDescriptionNsfwLikely(result?: ImageDescriptionResult) {
    const safety = result?.safety;
    if (!result || !safety?.is_nsfw_likely || safety.confidence.toLowerCase() !== HIGH_CONFIDENCE) {
      return false;
    }

    for (const indicator of safety.indicators) {
      if (STRONG_NSFW_INDICATORS.has(normalizeTag(indicator))) {
        return true;
      }
    }

    return STRONG_NSFW_TEXT_PATTERN.test([result.description, safety.reason].join(' '));
  }

  private getDescriptionNsfwResult(result: ImageDescriptionResult): NsfwDetectionResult {
    const labels: Record<string, number> = {};
    for (const indicator of result.safety?.indicators ?? []) {
      const normalized = normalizeTag(indicator);
      if (normalized) {
        labels[normalized] = 1;
      }
    }
    return {
      isNsfw: true,
      score: 1,
      labels,
    };
  }

  private getNsfwTags(nsfw: NsfwDetectionResult) {
    const tags = new Set(['nsfw']);
    for (const [label, score] of Object.entries(nsfw.labels)) {
      const normalized = normalizeTag(label);
      if (score >= 0.5 && normalized && normalized !== 'normal' && normalized !== 'safe') {
        tags.add(normalized);
      }
    }
    return [...tags];
  }

  private async upsertAssetTags(id: string, ownerId: string, tags: string[]) {
    const upsertedTags = await upsertTags(this.tagRepository, { userId: ownerId, tags });
    const items: Insertable<TagAssetTable>[] = upsertedTags.map((tag) => ({ tagId: tag.id, assetId: id }));
    const results = await this.tagRepository.upsertAssetIds(items);
    const insertedTagIds = new Set(results.map(({ tagId }) => tagId));
    const appliedTagValues = upsertedTags.filter(({ id }) => insertedTagIds.has(id)).map(({ value }) => value);

    if (results.length === 0) {
      return { visible: false, appliedTagValues };
    }

    await this.updateExifTags(id);
    await this.eventRepository.emit('AssetTag', { assetId: id, userId: ownerId });
    return { visible: true, appliedTagValues };
  }

  private async updateExifTags(assetId: string) {
    const { tags } = await this.assetRepository.getForUpdateTags(assetId);
    await this.assetRepository.upsertExif({
      exif: updateLockedColumns({ assetId, tags: tags.map(({ value }) => value) }),
      lockedPropertiesBehavior: 'append',
    });
  }

  /**
   * Build the list of named persons detected in the asset for identity-aware
   * prompt assembly.
   *
   * Faces are only included when:
   * - `personId` is set (face is linked to a person record)
   * - `person.name` is non-empty (the person has been given a name)
   * - `person.isHidden` is false (hidden persons are not surfaced)
   * - Both `imageWidth` and `imageHeight` are non-zero (avoids NaN in boxCenter)
   *
   * `faceConfidence` is always 1.0 because Immich's `asset_face` table has no
   * per-face recognition-confidence column; named faces are considered
   * user-curated ground truth.
   */
  private async getKnownPersonsForAsset(assetId: string, ownerId: string): Promise<KnownPerson[]> {
    let faces;
    try {
      faces = await this.personRepository.getFaces(assetId, { isVisible: true, viewingUserId: ownerId });
    } catch (error) {
      // Non-fatal: identity injection is best-effort. If face lookup fails
      // (DB hiccup, transient error), the description proceeds without
      // known-person hints rather than failing the whole enrichment job.
      // Log so persistent issues remain observable.
      this.logger.warn(`Failed to fetch faces for identity injection on asset ${assetId}: ${getErrorMessage(error)}`);
      return [];
    }
    const knownPersons: KnownPerson[] = [];

    for (const face of faces) {
      // Trim before checking so whitespace-only names ('   ') are rejected the same
      // as empty strings — both would degrade the identity hint to "Known people: -".
      const name = face.person?.name?.trim();
      if (!face.personGroupId || !name || face.person?.isHidden) {
        continue;
      }

      const { imageWidth, imageHeight, boundingBoxX1, boundingBoxX2, boundingBoxY1, boundingBoxY2 } = face;

      // Skip faces with degenerate dimensions to avoid division by zero or NaN.
      if (!imageWidth || !imageHeight) {
        continue;
      }

      knownPersons.push({
        name,
        // Always 1 — see method docstring (Immich has no per-face confidence column).
        faceConfidence: 1,
        boxCenter: [
          (boundingBoxX1 + boundingBoxX2) / 2 / imageWidth,
          (boundingBoxY1 + boundingBoxY2) / 2 / imageHeight,
        ],
      });
    }

    return knownPersons;
  }

  /**
   * Build a composite frame-grid image of a video from its reusable frames (FL-59), cutting them
   * first when the video has none or its original changed. Duplicate detection plays no part.
   * Returns undefined when no frames can be had — the caller surfaces this as a `skipped`
   * description with reason `video-frames-unavailable`.
   */
  private async prepareVideoGrid(
    assetId: string,
    ownerId: string,
    config: SystemConfig,
  ): Promise<{ path: string; videoContext: VideoContext } | undefined> {
    const moments = this.videoMoments;
    if (!moments) {
      return undefined;
    }

    const outcome = await ensureVideoFrames(
      { media: this.mediaRepository, storage: this.storageRepository, moments, logger: this.logger },
      assetId,
      config,
    );
    if (outcome.status !== 'cut' && outcome.status !== 'current') {
      return undefined;
    }

    const outputPath = StorageCore.getNestedPath(StorageFolder.Thumbnails, ownerId, `${assetId}_description_grid.jpeg`);
    this.storageCore.ensureFolders(outputPath);
    return this.composeGrid(outcome.frames, outputPath, assetId);
  }

  /**
   * Lay frames out in time order as one grid image. Layout escalates with frame count: 2 → 1×2,
   * 3-4 → 2×2, 5-6 → 2×3, 7+ → 3×3 (subsampling evenly when more than nine exist).
   */
  private async composeGrid(
    frames: readonly { path: string; timestampMs: number }[],
    outputPath: string,
    assetId: string,
  ): Promise<{ path: string; videoContext: VideoContext } | undefined> {
    if (frames.length < 2) {
      return undefined;
    }

    const ordered = [...frames].sort((a, b) => a.timestampMs - b.timestampMs);
    const layout = chooseGridLayout(ordered.length);
    const selected = subsampleFrames(ordered, layout.cols * layout.rows);

    try {
      await this.mediaRepository.composeImageGrid(
        selected.map((f) => f.path),
        { cols: layout.cols, rows: layout.rows, cellSize: 512, output: outputPath },
      );
    } catch (error) {
      this.logger.warn(`Failed to compose video frame grid for asset ${assetId}: ${getErrorMessage(error)}`);
      return undefined;
    }

    return {
      path: outputPath,
      videoContext: {
        cols: layout.cols,
        rows: layout.rows,
        timestampsMs: selected.map((f) => f.timestampMs),
      },
    };
  }
}

const chooseGridLayout = (frameCount: number): { cols: number; rows: number } => {
  if (frameCount <= 2) {
    return { cols: 2, rows: 1 };
  }
  if (frameCount <= 4) {
    return { cols: 2, rows: 2 };
  }
  if (frameCount <= 6) {
    return { cols: 3, rows: 2 };
  }
  return { cols: 3, rows: 3 };
};

const subsampleFrames = <T>(frames: T[], target: number): T[] => {
  if (frames.length <= target) {
    return frames;
  }
  const step = frames.length / target;
  const picked: T[] = [];
  for (let i = 0; i < target; i++) {
    picked.push(frames[Math.min(Math.floor(i * step), frames.length - 1)]);
  }
  return picked;
};
