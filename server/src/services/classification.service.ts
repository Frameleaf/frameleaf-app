import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type {
  ClassificationApplyOutcome,
  ClassificationRuleCounts,
  ClassificationRuleCriteria,
  ClassificationRuleWithAlbum,
} from 'src/repositories/classification.repository.js';
import {
  CLASSIFICATION_INLINE_LIMIT,
  CLASSIFICATION_PREVIEW_ITEMS,
  ClassificationApplyDto,
  ClassificationApplyResponseDto,
  ClassificationContributionDto,
  ClassificationDecisionDto,
  ClassificationDecisionResponseDto,
  ClassificationMatchPageDto,
  ClassificationMatchQueryDto,
  ClassificationPlanResponseDto,
  ClassificationPreviewDto,
  ClassificationPreviewResponseDto,
  ClassificationRuleCreateDto,
  ClassificationRuleQueryDto,
  ClassificationRuleResponseDto,
  ClassificationRuleUpdateDto,
  ClassificationSettingsDto,
} from 'src/dtos/classification.dto.js';
import {
  AlbumKind,
  ClassificationMatchDecision,
  ClassificationMediaType,
  ClassificationRuleAction,
  MediaOperationItemStatus,
  MlWorkload,
  Permission,
} from 'src/enum.js';
import { AlbumService } from 'src/services/album.service.js';
import { BaseService } from 'src/services/base.service.js';
import { BULK_MAX_ITEMS, type BulkOperationItem } from 'src/utils/bulk-operation.js';
import { isSmartSearchEnabled } from 'src/utils/misc.js';
import { upsertTags } from 'src/utils/tag.js';

type CriteriaInput = Omit<ClassificationRuleCriteria, 'ownerId'>;

/**
 * Encoded visual phrases, keyed on `<model>\0<phrase>`. The promise is cached so concurrent
 * evaluations share one request; a failure is evicted so the next evaluation retries.
 */
const phraseCache = new Map<string, Promise<string>>();

const toIso = (value: unknown): string => new Date(value as string).toISOString();
const toIsoOrNull = (value: unknown): string | null => (value ? toIso(value) : null);

const isEmptyCriteria = (criteria: CriteriaInput) =>
  criteria.personIds.length === 0 &&
  criteria.tagIds.length === 0 &&
  !criteria.takenAfter &&
  !criteria.takenBefore &&
  criteria.mediaType === ClassificationMediaType.Any &&
  criteria.visualQueries.length === 0;

/**
 * Classification rules (FL-60): the rules people write for their own smart albums, the bounded
 * preview that writes nothing, the plan and apply that bring the album in line (inline up to 500
 * changes, a durable bulk job beyond), the review of suggestions and what a rule did to an item.
 *
 * A rule only ever reads and changes its owner's own, unlocked media, and writes only to the owner's
 * own album, rule-owned tag and (with explicit consent) archive state. It never grants access.
 */
@Injectable()
export class ClassificationService extends BaseService {
  private _albumService: AlbumService | undefined;

  private get albumService(): AlbumService {
    this._albumService ??= BaseService.create(AlbumService, this);
    return this._albumService;
  }

  async getSettings(): Promise<ClassificationSettingsDto> {
    const { smartAlbums, machineLearning } = await this.getConfig({ withCache: true });
    return {
      visualCategories: smartAlbums.rules.visualCategories,
      visualSearchAvailable: smartAlbums.rules.visualCategories && isSmartSearchEnabled(machineLearning),
      defaultAction: smartAlbums.rules.defaultAction,
      inlineLimit: CLASSIFICATION_INLINE_LIMIT,
    };
  }

  async getRules(auth: AuthDto, { albumId }: ClassificationRuleQueryDto): Promise<ClassificationRuleResponseDto[]> {
    const rules = await this.classificationRepository.getRules(auth.user.id, albumId);
    const counts = await this.classificationRepository.getCounts(rules.map(({ id }) => id));
    return rules.map((rule) => this.map(rule, counts.get(rule.id)));
  }

  async getRule(auth: AuthDto, id: string): Promise<ClassificationRuleResponseDto> {
    const rule = await this.requireRule(auth, id);
    return this.present(rule);
  }

  async createRule(auth: AuthDto, dto: ClassificationRuleCreateDto): Promise<ClassificationRuleResponseDto> {
    const { smartAlbums } = await this.getConfig({ withCache: false });
    const criteria = this.criteriaOf(dto);
    await this.validateCriteria(auth, criteria);
    if (dto.archive && dto.archiveConsent !== true) {
      throw new BadRequestException('Archiving matches needs your explicit consent');
    }

    const action = dto.action ?? smartAlbums.rules.defaultAction;
    const tagName = dto.tagName === undefined && action === ClassificationRuleAction.Tag ? dto.albumName : dto.tagName;
    const tagId = tagName ? await this.resolveTag(auth, tagName, criteria) : null;
    if (action === ClassificationRuleAction.Tag && !tagId) {
      throw new BadRequestException('Name the tag this rule adds');
    }

    const album = await this.albumService.create(auth, {
      albumName: dto.albumName,
      description: dto.description ?? undefined,
      icon: dto.icon,
      parentId: dto.parentId,
      kind: AlbumKind.Album,
    });

    try {
      const rule = await this.classificationRepository.createRule({
        ownerId: auth.user.id,
        albumId: album.id,
        enabled: dto.enabled,
        ...criteria,
        action,
        tagId,
        archive: dto.archive,
        archiveConsentAt: dto.archive ? new Date().toISOString() : null,
      });
      return this.present(await this.requireRule(auth, rule.id));
    } catch (error) {
      // Never leave an ordinary album behind that looks like a smart album that failed.
      await this.albumRepository.delete(album.id);
      throw error;
    }
  }

  async updateRule(
    auth: AuthDto,
    id: string,
    dto: ClassificationRuleUpdateDto,
  ): Promise<ClassificationRuleResponseDto> {
    const rule = await this.requireRule(auth, id);
    const criteria: CriteriaInput = {
      personIds: dto.personIds ?? rule.personIds,
      tagIds: dto.tagIds ?? rule.tagIds,
      takenAfter: dto.takenAfter === undefined ? rule.takenAfter : dto.takenAfter,
      takenBefore: dto.takenBefore === undefined ? rule.takenBefore : dto.takenBefore,
      mediaType: dto.mediaType ?? rule.mediaType,
      visualQueries: dto.visualQueries ?? rule.visualQueries,
      threshold: dto.threshold ?? rule.threshold,
    };
    if (criteria.takenAfter && criteria.takenBefore && criteria.takenAfter > criteria.takenBefore) {
      throw new BadRequestException('The start date must be on or before the end date');
    }
    await this.validateCriteria(auth, criteria, {
      personIds: dto.personIds !== undefined,
      tagIds: dto.tagIds !== undefined,
      visualQueries: dto.visualQueries !== undefined,
    });

    const action = dto.action ?? rule.action;
    let tagId = rule.tagId;
    if (dto.tagName !== undefined) {
      tagId = dto.tagName ? await this.resolveTag(auth, dto.tagName, criteria) : null;
    } else if (tagId && criteria.tagIds.includes(tagId)) {
      throw new BadRequestException('A rule cannot match on the tag it adds');
    }
    if (action === ClassificationRuleAction.Tag && !tagId) {
      throw new BadRequestException('Name the tag this rule adds');
    }

    const archive = dto.archive ?? rule.archive;
    const turningArchiveOn = archive && !rule.archive;
    if (turningArchiveOn && dto.archiveConsent !== true) {
      throw new BadRequestException('Archiving matches needs your explicit consent');
    }

    await this.classificationRepository.updateRule(id, {
      ...criteria,
      action,
      tagId,
      enabled: dto.enabled ?? rule.enabled,
      archive,
      archiveConsentAt: archive ? (turningArchiveOn ? new Date().toISOString() : rule.archiveConsentAt) : null,
    });

    if (tagId !== rule.tagId) {
      // What the old tag holds stays where it is; the rule no longer answers for it, so it can never
      // take a tag away that it did not add under its current name.
      await this.classificationRepository.forgetTagContributions(id);
    }

    return this.present(await this.requireRule(auth, id));
  }

  /** The rule goes; its album stays as an ordinary album with everything in it, tags and archive included. */
  async deleteRule(auth: AuthDto, id: string): Promise<void> {
    await this.requireRule(auth, id);
    await this.classificationRepository.deleteRule(id);
  }

  /**
   * What a draft rule would match, read-only. A rule without visual phrases is counted over the whole
   * library; one with phrases over the newest `sampleSize` items, and says so.
   */
  async preview(auth: AuthDto, dto: ClassificationPreviewDto): Promise<ClassificationPreviewResponseDto> {
    const criteria = this.criteriaOf(dto);
    await this.validateCriteria(auth, criteria);
    const rule = { ...criteria, ownerId: auth.user.id };

    const vectors = await this.encodePhrases(criteria.visualQueries);
    if (!vectors) {
      return { exact: false, sampled: 0, matched: 0, items: [], visualSearchAvailable: false };
    }

    if (vectors.length === 0) {
      const [sampled, matched, items] = await Promise.all([
        this.classificationRepository.countEligible(auth.user.id),
        this.classificationRepository.countMatches(rule, vectors),
        this.classificationRepository.findMatches(rule, vectors, { limit: CLASSIFICATION_PREVIEW_ITEMS }),
      ]);
      return { exact: true, sampled, matched, items, visualSearchAvailable: true };
    }

    const { sampleSize } = dto;
    const [sampled, matched, items] = await Promise.all([
      this.classificationRepository.countEligible(auth.user.id, sampleSize),
      this.classificationRepository.countMatches(rule, vectors, { sampleSize }),
      this.classificationRepository.findMatches(rule, vectors, { sampleSize, limit: CLASSIFICATION_PREVIEW_ITEMS }),
    ]);
    return { exact: false, sampled, matched, items, visualSearchAvailable: true };
  }

  /**
   * What re-evaluating the rule would change, read-only: new matches (added or suggested), applied
   * matches that stopped matching, and every item the apply has to reprocess. Manual decisions are
   * never part of it.
   */
  async plan(auth: AuthDto, id: string): Promise<ClassificationPlanResponseDto> {
    const rule = await this.requireRule(auth, id);
    const vectors = await this.encodePhrases(rule.visualQueries);
    if (!vectors) {
      throw new BadRequestException('Visual categories cannot be compared right now');
    }

    const [matches, records, undoable] = await Promise.all([
      this.classificationRepository.findMatches(rule, vectors),
      this.classificationRepository.getMatches(rule.id),
      this.classificationRepository.getUndoableAssetIds(rule),
    ]);
    const recordByAsset = new Map(records.map((record) => [record.assetId, record]));
    const matching = new Set(matches.map(({ assetId }) => assetId));

    const added = matches.filter(({ assetId }) => {
      const record = recordByAsset.get(assetId);
      return (
        !record ||
        (rule.action === ClassificationRuleAction.Tag && record.decision === ClassificationMatchDecision.Suggested)
      );
    });
    const refreshed = matches.filter(
      ({ assetId }) => recordByAsset.get(assetId)?.decision === ClassificationMatchDecision.Matched,
    );
    const removed = undoable.filter((assetId) => !matching.has(assetId));

    const all = [...added.map(({ assetId }) => assetId), ...refreshed.map(({ assetId }) => assetId), ...removed];
    const assetIds = all.slice(0, BULK_MAX_ITEMS);
    return {
      matched: matches.length,
      added: added.length,
      removed: removed.length,
      items: added.slice(0, CLASSIFICATION_PREVIEW_ITEMS),
      assetIds,
      truncated: all.length > assetIds.length,
      durable: assetIds.length > CLASSIFICATION_INLINE_LIMIT,
      visualSearchAvailable: true,
    };
  }

  /** Apply the rule to at most 500 items from its plan, now. Larger plans run as a durable bulk job. */
  async apply(auth: AuthDto, id: string, dto: ClassificationApplyDto): Promise<ClassificationApplyResponseDto> {
    const rule = await this.requireRule(auth, id);
    if (!rule.enabled) {
      throw new BadRequestException('Turn the rule on before applying it');
    }
    // An empty plan only records the check.
    const outcome =
      dto.assetIds.length === 0
        ? { added: 0, suggested: 0, removed: 0, unchanged: 0, tagged: [], untagged: [] }
        : await this.applyToAssets(rule, dto.assetIds);
    if (!outcome) {
      throw new BadRequestException('Visual categories cannot be compared right now');
    }
    const lastAppliedAt = await this.classificationRepository.markApplied(rule.id);
    return {
      added: outcome.added,
      suggested: outcome.suggested,
      removed: outcome.removed,
      unchanged: outcome.unchanged,
      lastAppliedAt: lastAppliedAt.toISOString(),
    };
  }

  /**
   * One batch of an `apply-classification-rule` bulk job. `auth` is the job owner's worker session;
   * a rule that is gone, disabled or somebody else's skips every item rather than guessing.
   */
  async applyBulkBatch(auth: AuthDto, ruleId: string | undefined, assetIds: string[]): Promise<BulkOperationItem[]> {
    const skip = (reasonKey: string) =>
      assetIds.map((id) => ({ id, status: MediaOperationItemStatus.Skipped, reasonKey }));

    const rule = ruleId ? await this.classificationRepository.getRule(ruleId) : undefined;
    if (!rule || rule.ownerId !== auth.user.id) {
      return skip('frameleaf_bulk_reason_not_found');
    }
    if (!rule.enabled) {
      return skip('frameleaf_bulk_reason_rule_disabled');
    }

    const outcome = await this.applyToAssets(rule, assetIds);
    if (!outcome) {
      // Visual matching is unavailable: fail so the job can be retried, never "un-match" everything.
      return assetIds.map((id) => ({
        id,
        status: MediaOperationItemStatus.Failed,
        reasonKey: 'frameleaf_bulk_reason_visual_unavailable',
        message: 'Visual categories cannot be compared right now',
      }));
    }
    await this.classificationRepository.markApplied(rule.id);
    return assetIds.map((id) => ({ id, status: MediaOperationItemStatus.Ok }));
  }

  async getMatches(auth: AuthDto, id: string, dto: ClassificationMatchQueryDto): Promise<ClassificationMatchPageDto> {
    const rule = await this.requireRule(auth, id);
    const offset = (dto.page - 1) * dto.size;
    const { total, items } = await this.classificationRepository.getMatchPage(rule.id, auth.user.id, {
      decision: dto.decision,
      offset,
      limit: dto.size,
    });
    return {
      total,
      items: items.map((item) => ({
        assetId: item.assetId,
        score: item.score,
        decision: item.decision,
        tagContributed: item.tagContributed,
        archiveContributed: item.archiveContributed,
        updatedAt: toIso(item.updatedAt),
      })),
      nextPage: offset + items.length < total ? dto.page + 1 : null,
    };
  }

  async decide(auth: AuthDto, id: string, dto: ClassificationDecisionDto): Promise<ClassificationDecisionResponseDto> {
    const rule = await this.requireRule(auth, id);
    const outcome = await this.classificationRepository.decide(rule, dto.assetIds, dto.decision);
    await this.emitTagEvents(rule.ownerId, outcome);
    return { updated: outcome.updated, skipped: outcome.skipped };
  }

  /** What the viewer's own rules did to one of their items. Nothing for anybody else's item. */
  async getContributions(auth: AuthDto, assetId: string): Promise<ClassificationContributionDto[]> {
    await this.requireAccess({ auth, permission: Permission.AssetRead, ids: [assetId] });
    const rows = await this.classificationRepository.getContributions(assetId, auth.user.id);
    return rows.map((row) => ({
      ruleId: row.ruleId,
      albumId: row.albumId,
      albumName: row.albumName,
      decision: row.decision,
      score: row.score,
      tag: row.tagContributed && row.tagId && row.tagName ? { id: row.tagId, name: row.tagName } : null,
      archived: row.archiveContributed,
    }));
  }

  /**
   * Evaluate one newly processed item against every enabled rule of its owner. Background work:
   * never throws, and a rule whose visual phrases cannot be compared right now is left alone.
   */
  async evaluateAsset(assetId: string, ownerId: string): Promise<void> {
    let rules: ClassificationRuleWithAlbum[];
    try {
      rules = (await this.classificationRepository.getEnabledRules(ownerId)) ?? [];
    } catch (error) {
      this.logger.warn(`Classification rules unavailable for asset ${assetId}: ${String(error)}`);
      return;
    }
    for (const rule of rules) {
      try {
        await this.applyToAssets(rule, [assetId]);
      } catch (error) {
        this.logger.warn(
          `Classification rule ${rule.id} failed for asset ${assetId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /* ---------------- internals ---------------- */

  /** Returns undefined when the rule has visual phrases that cannot be compared right now. */
  private async applyToAssets(
    rule: ClassificationRuleWithAlbum,
    assetIds: string[],
  ): Promise<ClassificationApplyOutcome | undefined> {
    const vectors = await this.encodePhrases(rule.visualQueries);
    if (!vectors) {
      return undefined;
    }
    const matches = await this.classificationRepository.findMatches(rule, vectors, { assetIds });
    const outcome = await this.classificationRepository.apply(
      rule,
      assetIds,
      new Map(matches.map(({ assetId, score }) => [assetId, score])),
    );
    await this.emitTagEvents(rule.ownerId, outcome);
    return outcome;
  }

  private async emitTagEvents(ownerId: string, outcome: Pick<ClassificationApplyOutcome, 'tagged' | 'untagged'>) {
    for (const assetId of outcome.tagged) {
      await this.eventRepository.emit('AssetTag', { assetId, userId: ownerId });
    }
    for (const assetId of outcome.untagged) {
      await this.eventRepository.emit('AssetUntag', { assetId });
    }
  }

  /**
   * Encode visual phrases. `[]` for none; `undefined` when there are phrases and visual matching is
   * off or the service cannot be reached — callers must then change nothing.
   */
  private async encodePhrases(phrases: string[]): Promise<string[] | undefined> {
    if (phrases.length === 0) {
      return [];
    }
    const { smartAlbums, machineLearning } = await this.getConfig({ withCache: true });
    if (!smartAlbums.rules.visualCategories || !isSmartSearchEnabled(machineLearning)) {
      return undefined;
    }
    try {
      return await Promise.all(phrases.map((phrase) => this.encodePhrase(machineLearning.clip.modelName, phrase)));
    } catch (error) {
      this.logger.warn(`Visual category phrases could not be encoded: ${String(error)}`);
      return undefined;
    }
  }

  private encodePhrase(modelName: string, phrase: string): Promise<string> {
    const key = `${modelName}\u{0}${phrase}`;
    const cached = phraseCache.get(key);
    if (cached) {
      return cached;
    }
    const promise = this.selectRoutedMlDestination({ workload: MlWorkload.Clip })
      .then((selection) => this.machineLearningRepository.encodeText(selection, phrase, { modelName }))
      .catch((error) => {
        phraseCache.delete(key);
        throw error;
      });
    phraseCache.set(key, promise);
    return promise;
  }

  private criteriaOf(dto: CriteriaInput): CriteriaInput {
    return {
      personIds: [...new Set(dto.personIds)],
      tagIds: [...new Set(dto.tagIds)],
      takenAfter: dto.takenAfter ?? null,
      takenBefore: dto.takenBefore ?? null,
      mediaType: dto.mediaType,
      visualQueries: [...new Set(dto.visualQueries.map((phrase) => phrase.trim()).filter(Boolean))],
      threshold: dto.threshold,
    };
  }

  /**
   * A rule may only name the owner's own people and tags, and needs at least one criterion so it can
   * never sweep the whole library into an album by accident.
   */
  private async validateCriteria(
    auth: AuthDto,
    criteria: CriteriaInput,
    changed?: { personIds: boolean; tagIds: boolean; visualQueries: boolean },
  ) {
    const check = changed ?? { personIds: true, tagIds: true, visualQueries: true };
    if (isEmptyCriteria(criteria)) {
      throw new BadRequestException('Add at least one rule');
    }
    if (check.personIds && criteria.personIds.length > 0) {
      await this.requireAccess({ auth, permission: Permission.PersonRead, ids: criteria.personIds });
    }
    if (check.tagIds && criteria.tagIds.length > 0) {
      await this.requireAccess({ auth, permission: Permission.TagRead, ids: criteria.tagIds });
    }
    if (check.visualQueries && criteria.visualQueries.length > 0) {
      const { smartAlbums } = await this.getConfig({ withCache: true });
      if (!smartAlbums.rules.visualCategories) {
        throw new BadRequestException('Visual categories are turned off on this server');
      }
    }
  }

  private async resolveTag(auth: AuthDto, name: string, criteria: CriteriaInput): Promise<string> {
    const [tag] = await upsertTags(this.tagRepository, { userId: auth.user.id, tags: [name] });
    if (!tag) {
      throw new BadRequestException('Name the tag this rule adds');
    }
    if (criteria.tagIds.includes(tag.id)) {
      throw new BadRequestException('A rule cannot match on the tag it adds');
    }
    return tag.id;
  }

  private async requireRule(auth: AuthDto, id: string): Promise<ClassificationRuleWithAlbum> {
    const rule = await this.classificationRepository.getRule(id);
    // Somebody else's rule and a rule that never existed answer the same.
    if (!rule || rule.ownerId !== auth.user.id) {
      throw new NotFoundException('Rule not found');
    }
    return rule;
  }

  private async present(rule: ClassificationRuleWithAlbum): Promise<ClassificationRuleResponseDto> {
    const counts = await this.classificationRepository.getCounts([rule.id]);
    return this.map(rule, counts.get(rule.id));
  }

  private map(rule: ClassificationRuleWithAlbum, counts?: ClassificationRuleCounts): ClassificationRuleResponseDto {
    return {
      id: rule.id,
      albumId: rule.albumId,
      albumName: rule.albumName,
      enabled: rule.enabled,
      personIds: rule.personIds,
      tagIds: rule.tagIds,
      takenAfter: rule.takenAfter,
      takenBefore: rule.takenBefore,
      mediaType: rule.mediaType,
      visualQueries: rule.visualQueries,
      threshold: rule.threshold,
      action: rule.action,
      tag: rule.tagId && rule.tagName ? { id: rule.tagId, name: rule.tagName } : null,
      archive: rule.archive,
      archiveConsentAt: toIsoOrNull(rule.archiveConsentAt),
      createdAt: toIso(rule.createdAt),
      updatedAt: toIso(rule.updatedAt),
      lastAppliedAt: toIsoOrNull(rule.lastAppliedAt),
      counts: counts ?? { matched: 0, suggested: 0, accepted: 0, rejected: 0 },
    };
  }
}
