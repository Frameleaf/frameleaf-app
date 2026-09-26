import { Injectable } from '@nestjs/common';
import { type Insertable, type Kysely, type Selectable, type Transaction, type Updateable, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { AssetType, AssetVisibility, ClassificationMatchDecision, ClassificationMediaType } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { ClassificationMatchTable } from 'src/schema/tables/classification-match.table.js';
import { ClassificationRuleTable } from 'src/schema/tables/classification-rule.table.js';
import { isLocked, isNotLocked } from 'src/utils/locked.js';

export type ClassificationRule = Selectable<ClassificationRuleTable>;
export type ClassificationRuleWithAlbum = ClassificationRule & { albumName: string; tagName: string | null };
export type ClassificationMatch = Selectable<ClassificationMatchTable>;

/** What a rule matches on. The owner is part of it: a rule never reads anybody else's media. */
export type ClassificationRuleCriteria = Pick<
  ClassificationRule,
  'ownerId' | 'personIds' | 'tagIds' | 'takenAfter' | 'takenBefore' | 'mediaType' | 'visualQueries' | 'threshold'
>;

/** What a rule applies. */
export type ClassificationRuleEffects = Pick<
  ClassificationRule,
  'id' | 'ownerId' | 'albumId' | 'action' | 'tagId' | 'archive'
>;

export type ClassificationScoredAsset = { assetId: string; score: number | null };

export type ClassificationApplyOutcome = {
  added: number;
  suggested: number;
  removed: number;
  unchanged: number;
  /** Assets this call tagged, for the sidecar events. */
  tagged: string[];
  /** Assets this call untagged, for the sidecar events. */
  untagged: string[];
};

export type ClassificationRuleCounts = Record<'matched' | 'suggested' | 'accepted' | 'rejected', number>;

type Contributions = { tagContributed: boolean; archiveContributed: boolean };
type LiveAsset = { id: string; visibility: AssetVisibility; isLocked: boolean };

const ACTIVE: ClassificationMatchDecision[] = [
  ClassificationMatchDecision.Matched,
  ClassificationMatchDecision.Accepted,
];
const MANUAL: ReadonlySet<ClassificationMatchDecision> = new Set([
  ClassificationMatchDecision.Accepted,
  ClassificationMatchDecision.Rejected,
]);
const LISTED: AssetVisibility[] = [AssetVisibility.Timeline, AssetVisibility.Archive];
const NONE: Contributions = { tagContributed: false, archiveContributed: false };

const emptyOutcome = (): ClassificationApplyOutcome => ({
  added: 0,
  suggested: 0,
  removed: 0,
  unchanged: 0,
  tagged: [],
  untagged: [],
});

const jsonb = (value: string[]) => sql<string[]>`${JSON.stringify(value)}::text::jsonb`;

/**
 * Classification rules and what they did (FL-60).
 *
 * Every read is scoped to the rule's owner, and every write is to the owner's own album, tags and
 * archive state. Locked media is never matched, never changed and never un-matched: a rule's reach
 * stops at the lock, so locking something can never cost it an album membership either.
 *
 * Manual decisions (`accepted`, `rejected`) are never overturned here. Undoing a match only reverses
 * what this rule contributed, and a tag or archive state another of the owner's rules still holds stays.
 */
@Injectable()
export class ClassificationRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /* ---------------- rules ---------------- */

  private rules() {
    return this.db
      .selectFrom('classification_rule')
      .innerJoin('album', 'album.id', 'classification_rule.albumId')
      .leftJoin('tag', 'tag.id', 'classification_rule.tagId')
      .selectAll('classification_rule')
      .select(['album.albumName', 'tag.value as tagName'])
      .where('album.deletedAt', 'is', null);
  }

  getRule(id: string): Promise<ClassificationRuleWithAlbum | undefined> {
    return this.rules().where('classification_rule.id', '=', id).executeTakeFirst();
  }

  getRules(ownerId: string, albumId?: string): Promise<ClassificationRuleWithAlbum[]> {
    let query = this.rules().where('classification_rule.ownerId', '=', ownerId);
    if (albumId) {
      query = query.where('classification_rule.albumId', '=', albumId);
    }
    return query.orderBy('album.albumName').orderBy('classification_rule.id').execute();
  }

  getEnabledRules(ownerId: string): Promise<ClassificationRuleWithAlbum[]> {
    return this.rules()
      .where('classification_rule.ownerId', '=', ownerId)
      .where('classification_rule.enabled', '=', true)
      .orderBy('classification_rule.id')
      .execute();
  }

  getRuleByAlbumId(albumId: string): Promise<ClassificationRuleWithAlbum | undefined> {
    return this.rules().where('classification_rule.albumId', '=', albumId).executeTakeFirst();
  }

  /** Which of these albums are filled by a classification rule. */
  async getRuleAlbumIds(albumIds: string[]): Promise<Set<string>> {
    if (albumIds.length === 0) {
      return new Set();
    }
    const rows = await this.db
      .selectFrom('classification_rule')
      .select('albumId')
      .where('albumId', 'in', albumIds)
      .execute();
    return new Set(rows.map(({ albumId }) => albumId));
  }

  createRule(values: Insertable<ClassificationRuleTable>): Promise<ClassificationRule> {
    return this.db
      .insertInto('classification_rule')
      .values({
        ...values,
        personIds: jsonb(values.personIds ?? []),
        tagIds: jsonb(values.tagIds ?? []),
        visualQueries: jsonb(values.visualQueries ?? []),
      } as Insertable<ClassificationRuleTable>)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async updateRule(id: string, values: Updateable<ClassificationRuleTable>): Promise<void> {
    const patch: Record<string, unknown> = { ...values, updatedAt: sql`now()` };
    for (const key of ['personIds', 'tagIds', 'visualQueries'] as const) {
      const value = values[key];
      if (value !== undefined) {
        patch[key] = jsonb(value as string[]);
      }
    }
    await this.db.updateTable('classification_rule').set(patch).where('id', '=', id).execute();
  }

  async markApplied(id: string): Promise<Date> {
    const row = await this.db
      .updateTable('classification_rule')
      .set({ lastAppliedAt: sql`now()` })
      .where('id', '=', id)
      .returning('lastAppliedAt')
      .executeTakeFirst();
    return row?.lastAppliedAt ? new Date(row.lastAppliedAt as unknown as string) : new Date();
  }

  /**
   * The rule's tag changed: the old tag stays wherever it is, and the rule stops answering for it, so
   * it can never later take away a tag it did not add under its current name.
   */
  async forgetTagContributions(ruleId: string): Promise<void> {
    await this.db
      .updateTable('classification_match')
      .set({ tagContributed: false, updatedAt: sql`now()` })
      .where('ruleId', '=', ruleId)
      .where('tagContributed', '=', true)
      .execute();
  }

  /** Remove a rule and its records. Everything it applied stays: the album, its tags, archive states. */
  async deleteRule(id: string): Promise<void> {
    await this.db.deleteFrom('classification_rule').where('id', '=', id).execute();
  }

  async getCounts(ruleIds: string[]): Promise<Map<string, ClassificationRuleCounts>> {
    const counts = new Map<string, ClassificationRuleCounts>();
    for (const id of ruleIds) {
      counts.set(id, { matched: 0, suggested: 0, accepted: 0, rejected: 0 });
    }
    if (ruleIds.length === 0) {
      return counts;
    }
    const rows = await this.db
      .selectFrom('classification_match')
      .innerJoin('classification_rule', 'classification_rule.id', 'classification_match.ruleId')
      .innerJoin('asset', (join) =>
        join
          .onRef('asset.id', '=', 'classification_match.assetId')
          .onRef('asset.ownerId', '=', 'classification_rule.ownerId'),
      )
      .select([
        'classification_match.ruleId',
        'classification_match.decision',
        (eb) => eb.fn.countAll<number>().as('count'),
      ])
      .where('classification_match.ruleId', 'in', ruleIds)
      .where('asset.deletedAt', 'is', null)
      .where('asset.visibility', 'in', LISTED)
      .where(isNotLocked('asset'))
      .groupBy(['classification_match.ruleId', 'classification_match.decision'])
      .execute();
    for (const row of rows) {
      const entry = counts.get(row.ruleId);
      if (entry && row.decision in entry) {
        entry[row.decision as keyof ClassificationRuleCounts] = Number(row.count);
      }
    }
    return counts;
  }

  /* ---------------- matching (reads only) ---------------- */

  /**
   * The owner's items a rule could ever touch: listed (timeline or archive), not in the trash, not
   * the hidden half of a live photo, and not locked.
   */
  private eligible(ownerId: string) {
    return this.db
      .selectFrom('asset')
      .where('asset.ownerId', '=', ownerId)
      .where('asset.deletedAt', 'is', null)
      .where('asset.visibility', 'in', LISTED)
      .where(isNotLocked('asset'));
  }

  /**
   * The items a rule matches, best first, with their visual score. `vectors` are the encoded visual
   * phrases; pass none for a rule without phrases. `assetIds` limits the match to those items,
   * `sampleSize` to the owner's newest eligible items, `limit` the rows returned.
   */
  findMatches(
    rule: ClassificationRuleCriteria,
    vectors: string[],
    options: { assetIds?: string[]; sampleSize?: number; limit?: number } = {},
  ): Promise<ClassificationScoredAsset[]> {
    let query = this.matching(rule, vectors, options)
      .orderBy(sql`score`, sql`desc nulls last`)
      .orderBy('asset.fileCreatedAt', 'desc');
    if (options.limit) {
      query = query.limit(options.limit);
    }
    return query.execute();
  }

  async countMatches(
    rule: ClassificationRuleCriteria,
    vectors: string[],
    options: { sampleSize?: number } = {},
  ): Promise<number> {
    const row = await this.db
      .selectFrom(this.matching(rule, vectors, options).as('matches'))
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  }

  /** How many items a preview reads: the eligible library, or the newest `sampleSize` of it. */
  async countEligible(ownerId: string, sampleSize?: number): Promise<number> {
    let inner = this.eligible(ownerId).select('asset.id');
    if (sampleSize) {
      inner = inner.orderBy('asset.fileCreatedAt', 'desc').limit(sampleSize);
    }
    const row = await this.db
      .selectFrom(inner.as('eligible'))
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  }

  private matching(
    rule: ClassificationRuleCriteria,
    vectors: string[],
    options: { assetIds?: string[]; sampleSize?: number },
  ) {
    const score =
      vectors.length > 0
        ? sql<
            number | null
          >`greatest(${sql.join(vectors.map((vector) => sql`1 - (smart_search.embedding <=> ${vector})`))})`
        : sql<number | null>`null::double precision`;

    let query = this.eligible(rule.ownerId)
      .leftJoin('smart_search', 'smart_search.assetId', 'asset.id')
      .select(['asset.id as assetId', score.as('score')]);

    if (options.assetIds) {
      query =
        options.assetIds.length === 0
          ? query.where(sql<boolean>`false`)
          : query.where('asset.id', 'in', options.assetIds);
    }

    if (options.sampleSize) {
      const newest = this.eligible(rule.ownerId)
        .select('asset.id')
        .orderBy('asset.fileCreatedAt', 'desc')
        .limit(options.sampleSize);
      query = query.where(sql<boolean>`asset.id in (select id from (${newest}) as newest)`);
    }

    if (rule.personIds.length > 0) {
      query = query.where((eb) =>
        eb.exists(
          eb
            .selectFrom('asset_face')
            .select('asset_face.id')
            .whereRef('asset_face.assetId', '=', 'asset.id')
            .where('asset_face.personGroupId', 'in', rule.personIds)
            .where('asset_face.deletedAt', 'is', null)
            .where('asset_face.isVisible', '=', true),
        ),
      );
    }

    if (rule.tagIds.length > 0) {
      query = query.where((eb) =>
        eb.exists(
          eb
            .selectFrom('tag_asset')
            .innerJoin('tag_closure', 'tag_closure.id_descendant', 'tag_asset.tagId')
            .select('tag_asset.tagId')
            .whereRef('tag_asset.assetId', '=', 'asset.id')
            .where('tag_closure.id_ancestor', 'in', rule.tagIds),
        ),
      );
    }

    if (rule.takenAfter) {
      query = query.where(sql<boolean>`(asset."localDateTime" at time zone 'UTC')::date >= ${rule.takenAfter}::date`);
    }
    if (rule.takenBefore) {
      query = query.where(sql<boolean>`(asset."localDateTime" at time zone 'UTC')::date <= ${rule.takenBefore}::date`);
    }

    if (rule.mediaType === ClassificationMediaType.Photo) {
      query = query.where('asset.type', '=', AssetType.Image);
    } else if (rule.mediaType === ClassificationMediaType.Video) {
      query = query.where('asset.type', '=', AssetType.Video);
    }

    if (vectors.length > 0) {
      query = query.where(sql<boolean>`${score} >= ${rule.threshold}`);
    }

    return query;
  }

  /* ---------------- records ---------------- */

  getMatches(ruleId: string, assetIds?: string[]): Promise<ClassificationMatch[]> {
    if (assetIds?.length === 0) {
      return Promise.resolve([]);
    }
    let query = this.db.selectFrom('classification_match').selectAll().where('ruleId', '=', ruleId);
    if (assetIds) {
      query = query.where('assetId', 'in', assetIds);
    }
    return query.execute();
  }

  /**
   * Items whose record a re-evaluation may change because they stopped matching: applied or suggested,
   * on an item the rule could still reach (listed, not in the trash, not locked).
   */
  async getUndoableAssetIds(rule: Pick<ClassificationRule, 'id' | 'ownerId'>): Promise<string[]> {
    const rows = await this.eligible(rule.ownerId)
      .innerJoin('classification_match', 'classification_match.assetId', 'asset.id')
      .select('asset.id')
      .where('classification_match.ruleId', '=', rule.id)
      .where('classification_match.decision', 'in', [
        ClassificationMatchDecision.Matched,
        ClassificationMatchDecision.Suggested,
      ])
      .execute();
    return rows.map(({ id }) => id);
  }

  async getMatchPage(
    ruleId: string,
    ownerId: string,
    { decision, offset, limit }: { decision: ClassificationMatchDecision; offset: number; limit: number },
  ): Promise<{ total: number; items: ClassificationMatch[] }> {
    // Locked items are left out of the review: it runs in an ordinary session.
    const base = this.eligible(ownerId)
      .innerJoin('classification_match', 'classification_match.assetId', 'asset.id')
      .where('classification_match.ruleId', '=', ruleId)
      .where('classification_match.decision', '=', decision);
    const [count, items] = await Promise.all([
      base.select((eb) => eb.fn.countAll<number>().as('count')).executeTakeFirst(),
      base
        .selectAll('classification_match')
        .orderBy(sql`classification_match.score`, sql`desc nulls last`)
        .orderBy('asset.fileCreatedAt', 'desc')
        .offset(offset)
        .limit(limit)
        .execute(),
    ]);
    return { total: Number(count?.count ?? 0), items };
  }

  /** What the owner's rules did to one item, for the information panel. Rejections are left out. */
  getContributions(assetId: string, ownerId: string) {
    return this.db
      .selectFrom('classification_match')
      .innerJoin('classification_rule', 'classification_rule.id', 'classification_match.ruleId')
      .innerJoin('album', 'album.id', 'classification_rule.albumId')
      .leftJoin('tag', 'tag.id', 'classification_rule.tagId')
      .select([
        'classification_rule.id as ruleId',
        'classification_rule.albumId',
        'album.albumName',
        'classification_match.decision',
        'classification_match.score',
        'classification_match.tagContributed',
        'classification_match.archiveContributed',
        'tag.id as tagId',
        'tag.value as tagName',
      ])
      .where('classification_match.assetId', '=', assetId)
      .where('classification_rule.ownerId', '=', ownerId)
      .where('album.deletedAt', 'is', null)
      .where('classification_match.decision', '!=', ClassificationMatchDecision.Rejected)
      .orderBy('album.albumName')
      .execute();
  }

  /* ---------------- writes ---------------- */

  /**
   * Bring `assetIds` in line with the rule. `matches` holds the items (of `assetIds`) the rule matches
   * now, with their scores; every other item of `assetIds` does not match.
   *
   * One transaction with the records and items locked, so two runs over the same items (a retry, a
   * new photo being processed and a person pressing Apply) end in the same state as one. Items that
   * are not the owner's, are in the trash or are locked are left alone and counted as unchanged.
   */
  async apply(
    rule: ClassificationRule,
    assetIds: string[],
    matches: Map<string, number | null>,
  ): Promise<ClassificationApplyOutcome> {
    const outcome = emptyOutcome();
    if (assetIds.length === 0) {
      return outcome;
    }

    await this.db.transaction().execute(async (trx) => {
      // Lock the rule after inference, then compare the inputs that produced the matches. An edit,
      // disable or withdrawn archive consent during inference must never apply stale effects.
      const current = await trx
        .selectFrom('classification_rule')
        .selectAll()
        .where('id', '=', rule.id)
        .forNoKeyUpdate()
        .executeTakeFirst();
      const revision = (value: ClassificationRule) =>
        JSON.stringify([
          value.ownerId,
          value.albumId,
          value.enabled,
          value.personIds,
          value.tagIds,
          value.takenAfter,
          value.takenBefore,
          value.mediaType,
          value.visualQueries,
          value.threshold,
          value.action,
          value.tagId,
          value.archive,
          value.archiveConsentAt,
          value.updatedAt,
        ]);
      if (!current || !current.enabled || revision(current) !== revision(rule)) {
        throw new Error('Classification rule changed while matching; retry with the current rule');
      }
      const assets = await this.liveAssets(trx, rule.ownerId, assetIds);
      const existing = await this.lockMatches(trx, rule.id, assetIds);

      for (const assetId of assetIds) {
        const asset = assets.get(assetId);
        const row = existing.get(assetId);
        if (!asset || asset.isLocked) {
          outcome.unchanged++;
          continue;
        }

        if (!matches.has(assetId)) {
          if (row?.decision === ClassificationMatchDecision.Suggested) {
            await this.deleteMatch(trx, rule.id, assetId);
            outcome.removed++;
          } else if (row?.decision === ClassificationMatchDecision.Matched) {
            await this.revert(trx, rule, asset, row, outcome);
            await this.deleteMatch(trx, rule.id, assetId);
            outcome.removed++;
          } else {
            outcome.unchanged++;
          }
          continue;
        }

        const score = matches.get(assetId) ?? null;
        if (row && MANUAL.has(row.decision)) {
          outcome.unchanged++;
          continue;
        }

        if (row?.decision === ClassificationMatchDecision.Matched) {
          // Applied before. If the person has since undone any part of it by hand, that is their
          // decision: record it and take back the rest of what the rule applied.
          if (await this.wasUndoneByHand(trx, rule, asset, row)) {
            await this.revert(trx, rule, asset, row, outcome);
            await this.upsertMatch(trx, rule.id, assetId, score, ClassificationMatchDecision.Rejected, NONE);
          } else {
            const effects = await this.applyEffects(trx, rule, asset, row, outcome);
            await this.upsertMatch(trx, rule.id, assetId, score, ClassificationMatchDecision.Matched, effects);
          }
          outcome.unchanged++;
          continue;
        }

        if (rule.action === 'review') {
          if (row) {
            outcome.unchanged++;
          } else {
            await this.upsertMatch(trx, rule.id, assetId, score, ClassificationMatchDecision.Suggested, NONE);
            outcome.suggested++;
          }
          continue;
        }

        const effects = await this.applyEffects(trx, rule, asset, undefined, outcome);
        await this.upsertMatch(trx, rule.id, assetId, score, ClassificationMatchDecision.Matched, effects);
        outcome.added++;
      }
    });

    return outcome;
  }

  /**
   * The owner's review of a rule's matches. Accepting applies the rule's album, tag and archive and
   * keeps the item whatever later reprocessing finds. Rejecting takes back what this rule applied and
   * keeps it from ever applying again.
   */
  async decide(
    rule: ClassificationRuleEffects,
    assetIds: string[],
    decision: ClassificationMatchDecision.Accepted | ClassificationMatchDecision.Rejected,
  ): Promise<ClassificationApplyOutcome & { updated: number; skipped: number }> {
    const outcome = { ...emptyOutcome(), updated: 0, skipped: 0 };
    if (assetIds.length === 0) {
      return outcome;
    }

    await this.db.transaction().execute(async (trx) => {
      const assets = await this.liveAssets(trx, rule.ownerId, assetIds);
      const existing = await this.lockMatches(trx, rule.id, assetIds);
      for (const assetId of assetIds) {
        const asset = assets.get(assetId);
        const row = existing.get(assetId);
        if (!asset || asset.isLocked || !row || row.decision === decision) {
          outcome.skipped++;
          continue;
        }

        if (decision === ClassificationMatchDecision.Accepted) {
          const previous = row.decision === ClassificationMatchDecision.Rejected ? undefined : row;
          const effects = await this.applyEffects(trx, rule, asset, previous, outcome);
          await this.upsertMatch(trx, rule.id, assetId, row.score, decision, effects);
        } else {
          await this.revert(trx, rule, asset, row, outcome);
          await this.upsertMatch(trx, rule.id, assetId, row.score, decision, NONE);
        }
        outcome.updated++;
      }
    });

    return outcome;
  }

  /**
   * The owner took items out of a rule's smart album by hand: a rejection that reprocessing keeps.
   * What the rule contributed besides the album (its tag, the archive state) is taken back too.
   */
  async recordAlbumRemovals(albumId: string, assetIds: string[], actorId: string): Promise<ClassificationApplyOutcome> {
    const outcome = emptyOutcome();
    const rule = assetIds.length > 0 ? await this.getRuleByAlbumId(albumId) : undefined;
    if (!rule || rule.ownerId !== actorId) {
      return outcome;
    }

    await this.db.transaction().execute(async (trx) => {
      const assets = await this.liveAssets(trx, rule.ownerId, assetIds);
      const existing = await this.lockMatches(trx, rule.id, assetIds);
      for (const assetId of assetIds) {
        const asset = assets.get(assetId);
        if (!asset) {
          continue;
        }
        const row = existing.get(assetId);
        if (row && row.decision !== ClassificationMatchDecision.Rejected) {
          await this.revert(trx, rule, asset, row, outcome, { album: false });
        }
        await this.upsertMatch(trx, rule.id, assetId, row?.score ?? null, ClassificationMatchDecision.Rejected, NONE);
      }
    });

    return outcome;
  }

  /** The owner put items in a rule's smart album by hand: an acceptance that reprocessing keeps. */
  async recordAlbumAdditions(albumId: string, assetIds: string[], actorId: string): Promise<void> {
    const rule = assetIds.length > 0 ? await this.getRuleByAlbumId(albumId) : undefined;
    if (!rule || rule.ownerId !== actorId) {
      return;
    }
    await this.db.transaction().execute(async (trx) => {
      const assets = await this.liveAssets(trx, rule.ownerId, assetIds);
      const existing = await this.lockMatches(trx, rule.id, assetIds);
      for (const assetId of assetIds) {
        if (!assets.has(assetId)) {
          continue;
        }
        const row = existing.get(assetId);
        await this.upsertMatch(trx, rule.id, assetId, row?.score ?? null, ClassificationMatchDecision.Accepted, {
          tagContributed: row?.tagContributed ?? false,
          archiveContributed: row?.archiveContributed ?? false,
        });
      }
    });
  }

  /* ---------------- helpers ---------------- */

  private async lockMatches(trx: Transaction<DB>, ruleId: string, assetIds: string[]) {
    const rows = await trx
      .selectFrom('classification_match')
      .selectAll()
      .where('ruleId', '=', ruleId)
      .where('assetId', 'in', assetIds)
      .forUpdate()
      .execute();
    return new Map(rows.map((row) => [row.assetId, row]));
  }

  private async liveAssets(trx: Transaction<DB>, ownerId: string, assetIds: string[]) {
    const rows = await trx
      .selectFrom('asset')
      .select(['asset.id', 'asset.visibility', isLocked('asset').as('isLocked')])
      .where('asset.id', 'in', assetIds)
      .where('asset.ownerId', '=', ownerId)
      .where('asset.deletedAt', 'is', null)
      .where('asset.visibility', 'in', LISTED)
      .forUpdate()
      .execute();
    return new Map<string, LiveAsset>(
      rows.map((row) => [row.id, { id: row.id, visibility: row.visibility, isLocked: !!row.isLocked }]),
    );
  }

  /** Album removals are recorded with their actor at the service boundary; only tag/archive remain inferable here. */
  private async wasUndoneByHand(
    trx: Transaction<DB>,
    rule: ClassificationRuleEffects,
    asset: LiveAsset,
    row: ClassificationMatch,
  ): Promise<boolean> {
    if (row.tagContributed && rule.tagId && !(await this.hasTag(trx, rule.tagId, asset.id))) {
      return true;
    }
    return row.archiveContributed && asset.visibility !== AssetVisibility.Archive;
  }

  /**
   * Put the item in the rule's album and apply the rule's tag and archive. A tag the item already had
   * (the person's own, or another rule's) is not claimed as this rule's contribution, so undoing the
   * match later leaves it. Returns what this rule now holds for the item.
   */
  private async applyEffects(
    trx: Transaction<DB>,
    rule: ClassificationRuleEffects,
    asset: LiveAsset,
    row: ClassificationMatch | undefined,
    outcome: ClassificationApplyOutcome,
  ): Promise<Contributions> {
    await trx
      .insertInto('album_asset')
      .values({ albumId: rule.albumId, assetId: asset.id })
      .onConflict((oc) => oc.doNothing())
      .execute();

    let tagContributed = row?.tagContributed ?? false;
    if (rule.tagId && !tagContributed) {
      const inserted = await trx
        .insertInto('tag_asset')
        .values({ tagId: rule.tagId, assetId: asset.id })
        .onConflict((oc) => oc.doNothing())
        .returning('assetId')
        .executeTakeFirst();
      if (inserted) {
        tagContributed = true;
        outcome.tagged.push(asset.id);
      } else {
        // Already tagged. When another of the owner's rules added it, this rule shares that
        // contribution, so the tag goes once the last rule holding it lets go. When the person tagged
        // it themselves, no rule ever takes it away.
        tagContributed = await this.isRuleContributedTag(trx, rule, asset.id);
      }
    }

    let archiveContributed = row?.archiveContributed ?? false;
    if (rule.archive && !archiveContributed) {
      if (asset.visibility === AssetVisibility.Timeline) {
        await trx
          .updateTable('asset')
          .set({ visibility: AssetVisibility.Archive })
          .where('id', '=', asset.id)
          .where('visibility', '=', AssetVisibility.Timeline)
          .execute();
        asset.visibility = AssetVisibility.Archive;
        archiveContributed = true;
      } else if (asset.visibility === AssetVisibility.Archive) {
        // Share an archive created by another rule, but never claim one the owner made manually.
        const holder = await trx
          .selectFrom('classification_match')
          .select('ruleId')
          .where('assetId', '=', asset.id)
          .where('ruleId', '!=', rule.id)
          .where('decision', 'in', ACTIVE)
          .where('archiveContributed', '=', true)
          .executeTakeFirst();
        archiveContributed = !!holder;
      }
    }

    return { tagContributed, archiveContributed };
  }

  /**
   * Take back what this rule applied to the item: its album membership, and its tag and archive state
   * where this rule added them and no other rule of the owner still holds them.
   */
  private async revert(
    trx: Transaction<DB>,
    rule: ClassificationRuleEffects,
    asset: LiveAsset,
    row: ClassificationMatch,
    outcome: ClassificationApplyOutcome,
    { album = true }: { album?: boolean } = {},
  ): Promise<void> {
    if (album && row.decision !== ClassificationMatchDecision.Suggested) {
      await trx.deleteFrom('album_asset').where('albumId', '=', rule.albumId).where('assetId', '=', asset.id).execute();
    }

    if (row.tagContributed && rule.tagId) {
      const heldElsewhere = await trx
        .selectFrom('classification_match')
        .innerJoin('classification_rule', 'classification_rule.id', 'classification_match.ruleId')
        .select('classification_match.ruleId')
        .where('classification_match.assetId', '=', asset.id)
        .where('classification_match.ruleId', '!=', rule.id)
        .where('classification_match.decision', 'in', ACTIVE)
        .where('classification_match.tagContributed', '=', true)
        .where('classification_rule.tagId', '=', rule.tagId)
        .executeTakeFirst();
      if (!heldElsewhere) {
        const deleted = await trx
          .deleteFrom('tag_asset')
          .where('tagId', '=', rule.tagId)
          .where('assetId', '=', asset.id)
          .returning('assetId')
          .executeTakeFirst();
        if (deleted) {
          outcome.untagged.push(asset.id);
        }
      }
    }

    if (row.archiveContributed && asset.visibility === AssetVisibility.Archive) {
      const heldElsewhere = await trx
        .selectFrom('classification_match')
        .select('ruleId')
        .where('assetId', '=', asset.id)
        .where('ruleId', '!=', rule.id)
        .where('decision', 'in', ACTIVE)
        .where('archiveContributed', '=', true)
        .executeTakeFirst();
      if (!heldElsewhere) {
        await trx
          .updateTable('asset')
          .set({ visibility: AssetVisibility.Timeline })
          .where('id', '=', asset.id)
          .where('visibility', '=', AssetVisibility.Archive)
          .execute();
        asset.visibility = AssetVisibility.Timeline;
      }
    }
  }

  private async isRuleContributedTag(trx: Transaction<DB>, rule: ClassificationRuleEffects, assetId: string) {
    const row = await trx
      .selectFrom('classification_match')
      .innerJoin('classification_rule', 'classification_rule.id', 'classification_match.ruleId')
      .select('classification_match.ruleId')
      .where('classification_match.assetId', '=', assetId)
      .where('classification_match.ruleId', '!=', rule.id)
      .where('classification_match.decision', 'in', ACTIVE)
      .where('classification_match.tagContributed', '=', true)
      .where('classification_rule.tagId', '=', rule.tagId)
      .executeTakeFirst();
    return !!row;
  }

  private async hasTag(trx: Transaction<DB>, tagId: string, assetId: string) {
    const row = await trx
      .selectFrom('tag_asset')
      .select('assetId')
      .where('tagId', '=', tagId)
      .where('assetId', '=', assetId)
      .executeTakeFirst();
    return !!row;
  }

  private async upsertMatch(
    trx: Transaction<DB>,
    ruleId: string,
    assetId: string,
    score: number | null,
    decision: ClassificationMatchDecision,
    effects: Contributions,
  ) {
    await trx
      .insertInto('classification_match')
      .values({ ruleId, assetId, score, decision, ...effects })
      .onConflict((oc) =>
        oc.columns(['ruleId', 'assetId']).doUpdateSet({ score, decision, ...effects, updatedAt: sql`now()` }),
      )
      .execute();
  }

  private async deleteMatch(trx: Transaction<DB>, ruleId: string, assetId: string) {
    await trx.deleteFrom('classification_match').where('ruleId', '=', ruleId).where('assetId', '=', assetId).execute();
  }
}
