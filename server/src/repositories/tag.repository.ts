import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  type InsertQueryBuilder,
  type Insertable,
  type Kysely,
  type QueryCreator,
  type Selectable,
  type Transaction,
  sql,
} from 'kysely';
import { chunk } from 'lodash-es';
import { InjectKysely } from 'nestjs-kysely';
import type { PostgresError } from 'postgres';
import type { HiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import { type Tag, columns } from 'src/database.js';
import { Chunked, ChunkedSet, DATABASE_PARAMETER_CHUNK_SIZE, DummyValue, GenerateSql } from 'src/decorators.js';
import { publicationDatabase } from 'src/queue/transaction.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { TagAssetTable } from 'src/schema/tables/tag-asset.table.js';
import { TagTable } from 'src/schema/tables/tag.table.js';
import {
  asUuid,
  dummy,
  getHiddenContentFilter,
  tagHasVisibleAssetOrNoAssets,
  tagIsSuppressed,
} from 'src/utils/database.js';

/**
 * `hideLocked`: the session is not unlocked, so a tag carried only by locked items is left out
 * (owner decision, September 27, 2026; see `tagHasVisibleAssetOrNoAssets`).
 */
export type TagSearchOptions = HiddenContentQueryOptions & { hideLocked?: boolean };

/** A tag's new leaf name, colour and parent (`null`: top level); omitted fields stay as they are. */
export type TagUpdate = { name?: string; color?: string | null; parentId?: string | null };

/** What a merge did, for the service to finish outside the tag tables. */
export type TagMergeResult = {
  /** The tag merged into, as it is afterwards. */
  tag: Tag;
  /** Every tag the merge removed, with the tag that took its place. */
  merged: { id: string; targetId: string }[];
  /** Assets that now carry a tag they did not carry before. */
  taggedAssetIds: string[];
  /** Every asset that carried the merged tag or a tag inside it: its tags changed or took a new path. */
  assetIds: string[];
};

const TAG_VALUE_CONSTRAINT = 'tag_userId_value_uq';
const TAG_EXISTS = 'A tag with that name already exists';
const TAGS_CHANGED = 'The tags changed while they were being merged. Try again';
const jsonb = (value: string[]) => sql<string[]>`${JSON.stringify(value)}::text::jsonb`;

@Injectable()
export class TagRepository {
  constructor(
    @InjectKysely() private db: Kysely<DB>,
    private logger: LoggingRepository,
  ) {
    this.db = publicationDatabase(this.db);
    this.logger.setContext(TagRepository.name);
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  get(id: string) {
    return this.db.selectFrom('tag').select(columns.tag).where('id', '=', id).executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.STRING] })
  getByValue(userId: string, value: string) {
    return this.db
      .selectFrom('tag')
      .select(columns.tag)
      .where('userId', '=', userId)
      .where('value', '=', value)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [{ userId: DummyValue.UUID, value: DummyValue.STRING, parentId: DummyValue.UUID }] })
  async upsertValue({ userId, value, parentId: _parentId }: { userId: string; value: string; parentId?: string }) {
    const parentId = _parentId ?? null;
    return this.insertTagWithClosures((db) =>
      db
        .insertInto('tag')
        .values({ userId, value, parentId })
        .onConflict((oc) => oc.columns(['userId', 'value']).doUpdateSet({ parentId }))
        .returningAll(),
    );
  }

  @GenerateSql({ params: [DummyValue.UUID, { excludeNsfw: true, hideLocked: true }] })
  getAll(userId: string, options: TagSearchOptions = {}) {
    // FL-46: a session that is not unlocked never lists a suppressed tag or one nested under it,
    // even an empty one, so the list agrees with the 404 its own page answers
    const suppressedTagIds = options.hiddenContent?.tagIds ?? [];
    return this.db
      .selectFrom('tag')
      .select(columns.tag)
      .where('userId', '=', userId)
      .$if(suppressedTagIds.length > 0, (qb) =>
        qb.where(sql<boolean>`not ${tagIsSuppressed(sql.ref('tag.id'), suppressedTagIds)}`),
      )
      .where(
        tagHasVisibleAssetOrNoAssets(sql.ref('tag.id'), getHiddenContentFilter(options), {
          hideLocked: options.hideLocked,
        }),
      )
      .orderBy('value')
      .execute();
  }

  @GenerateSql({ params: [{ userId: DummyValue.UUID, color: DummyValue.STRING, value: DummyValue.STRING }] })
  create(tag: Insertable<TagTable>) {
    return this.insertTagWithClosures((db) => db.insertInto('tag').values(tag).returningAll());
  }

  /**
   * Renames, recolours or moves a tag (FL-46). `parentId: null` moves it to the top level, a tag id
   * under that tag; the tag's and every descendant's value follow, and the subtree's closure rows are
   * re-rooted.
   *
   * A rename or move locks all of the owner's tags (in id order, so two of them cannot deadlock) before
   * it reads anything, then checks for a cycle and a taken path inside the same transaction: two
   * concurrent moves (A under B, B under A) cannot both pass, and a unique-violation that still slips
   * through (a tag created meanwhile by an upsert) is answered as the same 400.
   */
  @GenerateSql({ params: [DummyValue.UUID, { name: DummyValue.STRING, color: DummyValue.STRING }] })
  async update(id: string, { name, color, parentId }: TagUpdate) {
    try {
      return await this.db.transaction().execute(async (tx) => {
        if (name === undefined && parentId === undefined) {
          return tx
            .updateTable('tag')
            .set({ color })
            .where('id', '=', id)
            .returningAll()
            .executeTakeFirstOrThrow(() => new NotFoundException('Tag not found'));
        }

        await this.lockOwnerTags(tx, id);
        return this.moveOrRename(tx, id, { name, color, parentId });
      });
    } catch (error) {
      if ((error as PostgresError)?.constraint_name === TAG_VALUE_CONSTRAINT) {
        throw new BadRequestException(TAG_EXISTS);
      }
      throw error;
    }
  }

  /** Locks every tag of the owner of this tag, in id order, for the rest of the transaction. */
  private async lockOwnerTags(tx: Transaction<DB>, id: string) {
    await tx
      .selectFrom('tag')
      .select('id')
      .where('userId', '=', (eb) => eb.selectFrom('tag as moved').select('moved.userId').where('moved.id', '=', id))
      .orderBy('id')
      .forUpdate()
      .execute();
  }

  /**
   * The rename and move of `update`, for a caller that already holds the owner's tags locked
   * (`lockOwnerTags`): the path, cycle and duplicate checks, the tag's and every descendant's value,
   * and the subtree's closure rows.
   */
  private async moveOrRename(tx: Transaction<DB>, id: string, { name, color, parentId }: TagUpdate) {
    const existing = await tx
      .selectFrom('tag')
      .select(['userId', 'value', 'parentId'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow(() => new NotFoundException('Tag not found'));

    const leaf = name || (existing.value.split('/').at(-1) as string);
    let value: string;
    if (parentId === undefined) {
      const parts = existing.value.split('/');
      parts[parts.length - 1] = leaf;
      value = parts.join('/');
    } else if (parentId === null) {
      value = leaf;
    } else {
      if (parentId === id || (await this.isAncestor(tx, id, parentId))) {
        throw new BadRequestException('A tag cannot be moved under itself or one of its descendants');
      }
      const parent = await tx
        .selectFrom('tag')
        .select('value')
        .where('id', '=', parentId)
        .where('userId', '=', existing.userId)
        .executeTakeFirstOrThrow(() => new NotFoundException('Tag not found'));
      value = `${parent.value}/${leaf}`;
    }

    if (value !== existing.value) {
      const taken = await tx
        .selectFrom('tag')
        .select('id')
        .where('userId', '=', existing.userId)
        .where('value', '=', value)
        .executeTakeFirst();
      if (taken) {
        throw new BadRequestException(TAG_EXISTS);
      }
    }

    const updated = await tx
      .updateTable('tag')
      .set({ value, color, ...(parentId !== undefined && { parentId }) })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();

    // FL-46: a moved tag takes its whole subtree along, so the subtree's closure rows are re-rooted:
    // links to the old ancestors are dropped and links to the new parent's ancestors added
    if (parentId !== undefined && parentId !== existing.parentId) {
      const subtree = tx.selectFrom('tag_closure').select('id_descendant').where('id_ancestor', '=', id);
      await tx
        .deleteFrom('tag_closure')
        .where('id_descendant', 'in', subtree)
        .where('id_ancestor', 'not in', subtree)
        .execute();
      if (parentId !== null) {
        await tx
          .insertInto('tag_closure')
          .columns(['id_ancestor', 'id_descendant'])
          .expression((eb) =>
            eb
              .selectFrom('tag_closure as ancestor')
              .innerJoin('tag_closure as descendant', (join) => join.on('descendant.id_ancestor', '=', id))
              .where('ancestor.id_descendant', '=', parentId)
              .select(['ancestor.id_ancestor', 'descendant.id_descendant']),
          )
          .onConflict((oc) => oc.doNothing())
          .execute();
      }
    }

    if (value !== existing.value) {
      await this.renameDescendants(tx, id, value);
    }
    return updated;
  }

  /**
   * Merges a tag into another tag of the same owner, inside the caller's transaction (the service
   * rewrites what names a tag outside these tables in the same one).
   *
   * Every item the merged tag is on carries the other tag afterwards, whatever its state: archived,
   * trashed and Locked items too, which is why this is not left to a client. The tags directly inside
   * the merged tag move under the other tag by the same code a move uses; one that meets a tag of its
   * own name there is merged into it the same way, so no two siblings share a name. The merged tag is
   * then deleted. The tag merged into keeps its name, colour and place.
   *
   * The deletes run as a delete of the tag's items and of the tag itself, so the audit triggers record
   * exactly what untagging every item and deleting the tag would have.
   */
  async merge(tx: Transaction<DB>, id: string, targetId: string): Promise<TagMergeResult> {
    try {
      await this.lockOwnerTags(tx, id);
      const source = await tx
        .selectFrom('tag')
        .select('userId')
        .where('id', '=', id)
        .executeTakeFirstOrThrow(() => new NotFoundException('Tag not found'));
      await tx
        .selectFrom('tag')
        .select('id')
        .where('id', '=', targetId)
        .where('userId', '=', source.userId)
        .executeTakeFirstOrThrow(() => new NotFoundException('Tag not found'));
      // the closure holds a row for the tag itself, so this is the tag as well as every tag inside it
      if (await this.isAncestor(tx, id, targetId)) {
        throw new BadRequestException('A tag cannot be merged into itself or one of its descendants');
      }

      const carried = await tx
        .selectFrom('tag_asset')
        .innerJoin('tag_closure', 'tag_closure.id_descendant', 'tag_asset.tagId')
        .select('tag_asset.assetId')
        .distinct()
        .where('tag_closure.id_ancestor', '=', id)
        .execute();

      // The merged tag gives up its name first. Merged into a tag above it, a tag inside it may be about
      // to take the very path it holds ("Trips/2019/2019" into "Trips"); nothing is ever moved to or
      // merged with a tag that is on its way out.
      await this.moveOrRename(tx, id, { name: id });

      const merged: TagMergeResult['merged'] = [];
      const tagged = new Set<string>();
      const mergeInto = async (sourceId: string, intoId: string) => {
        const gained = await tx
          .insertInto('tag_asset')
          .columns(['tagId', 'assetId'])
          .expression((eb) =>
            eb
              .selectFrom('tag_asset as carried')
              .select([sql<string>`${intoId}::uuid`.as('tagId'), 'carried.assetId'])
              .where('carried.tagId', '=', sourceId),
          )
          .onConflict((oc) => oc.doNothing())
          .returning('assetId')
          .execute();
        for (const { assetId } of gained) {
          tagged.add(assetId);
        }

        const into = await tx.selectFrom('tag').select('value').where('id', '=', intoId).executeTakeFirstOrThrow();
        const children = await tx
          .selectFrom('tag')
          .select(['id', 'value'])
          .where('parentId', '=', sourceId)
          .orderBy('id')
          .execute();
        for (const child of children) {
          const leaf = child.value.split('/').at(-1) as string;
          const twin = await tx
            .selectFrom('tag')
            .select('id')
            .where('userId', '=', source.userId)
            .where('value', '=', `${into.value}/${leaf}`)
            .executeTakeFirst();
          await (twin ? mergeInto(child.id, twin.id) : this.moveOrRename(tx, child.id, { parentId: intoId }));
        }

        await this.followMergedTagInRules(tx, source.userId, sourceId, intoId);
        await tx.deleteFrom('tag_asset').where('tagId', '=', sourceId).execute();
        await tx.deleteFrom('tag').where('id', '=', sourceId).execute();
        merged.push({ id: sourceId, targetId: intoId });
      };
      await mergeInto(id, targetId);

      const tag = await tx.selectFrom('tag').select(columns.tag).where('id', '=', targetId).executeTakeFirstOrThrow();
      return { tag, merged, taggedAssetIds: [...tagged], assetIds: carried.map(({ assetId }) => assetId) };
    } catch (error) {
      // a tag created meanwhile (an upsert takes no lock) on a path a moved tag was about to take
      if ((error as PostgresError)?.constraint_name === TAG_VALUE_CONSTRAINT) {
        throw new BadRequestException(TAGS_CHANGED);
      }
      throw error;
    }
  }

  /**
   * A smart album rule that names a merged tag follows it to the tag it was merged into: as a tag it
   * matches on, and as the tag it adds. A rule that would then add the very tag it matches on stops
   * adding one, as it does when its tag is deleted. A rule whose tag changed no longer answers for
   * what it added before (as `ClassificationRepository.forgetTagContributions`), so it can never take
   * the surviving tag off an item that carried it already.
   */
  private async followMergedTagInRules(tx: Transaction<DB>, ownerId: string, id: string, targetId: string) {
    const rules = await tx
      .selectFrom('classification_rule')
      .select(['id', 'tagIds', 'tagId'])
      .where('ownerId', '=', ownerId)
      .where((eb) => eb.or([eb('tagId', '=', id), sql<boolean>`"tagIds" @> ${jsonb([id])}`]))
      .orderBy('id')
      .forUpdate()
      .execute();
    for (const rule of rules) {
      const tagIds = [...new Set(rule.tagIds.map((tagId) => (tagId === id ? targetId : tagId)))];
      const followed = rule.tagId === id ? targetId : rule.tagId;
      const tagId = followed && tagIds.includes(followed) ? null : followed;
      await tx
        .updateTable('classification_rule')
        .set({ tagIds: jsonb(tagIds), tagId, updatedAt: sql`now()` })
        .where('id', '=', rule.id)
        .execute();
      if (tagId !== rule.tagId) {
        await tx
          .updateTable('classification_match')
          .set({ tagContributed: false, updatedAt: sql`now()` })
          .where('ruleId', '=', rule.id)
          .where('tagContributed', '=', true)
          .execute();
      }
    }
  }

  /** Rewrites every descendant's value under a tag whose value became `value`. */
  private async renameDescendants(tx: Transaction<DB>, id: string, value: string) {
    await tx
      // Use a recursive cte to get all levels of nested child tags that need to be updated
      .withRecursive('descendants(id, value)', (qb) => {
        const directChildren = qb
          .selectFrom('tag as child')
          .select((eb) => [
            'child.id as id',
            eb
              .fn<string>('concat', [
                eb.cast<string>(eb.val(value), 'text'),
                eb.cast<string>(eb.val('/'), 'text'),
                eb.fn<string>('regexp_replace', ['child.value', eb.val('^.*/'), eb.val('')]),
              ])
              .as('value'),
          ])
          .where('child.parentId', '=', id);

        const nestedChildren = qb
          .selectFrom('tag as child')
          .innerJoin('descendants as parent', 'parent.id', 'child.parentId')
          .select((eb) => [
            'child.id as id',
            eb
              .fn<string>('concat', [
                'parent.value',
                eb.cast<string>(eb.val('/'), 'text'),
                eb.fn<string>('regexp_replace', ['child.value', eb.val('^.*/'), eb.val('')]),
              ])
              .as('value'),
          ]);

        return directChildren.unionAll(nestedChildren);
      })
      .updateTable('tag')
      .from('descendants')
      .set((eb) => ({
        value: eb.ref('descendants.value'),
      }))
      .whereRef('tag.id', '=', 'descendants.id')
      .execute();
  }

  /** Whether `ancestorId` is `descendantId` or one of its ancestors. */
  private async isAncestor(tx: Transaction<DB>, ancestorId: string, descendantId: string) {
    const row = await tx
      .selectFrom('tag_closure')
      .select('id_ancestor')
      .where('id_ancestor', '=', ancestorId)
      .where('id_descendant', '=', descendantId)
      .executeTakeFirst();
    return !!row;
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async delete(id: string) {
    await this.db.deleteFrom('tag').where('id', '=', id).execute();
  }

  /** A rename or move changes the values carried by the entire subtree's assets. */
  async getSubtreeAssetIds(tagId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom('tag_asset')
      .innerJoin('tag_closure', 'tag_closure.id_descendant', 'tag_asset.tagId')
      .where('tag_closure.id_ancestor', '=', tagId)
      .select('tag_asset.assetId')
      .distinct()
      .execute();
    return rows.map(({ assetId }) => assetId);
  }

  @ChunkedSet({ paramIndex: 1 })
  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID]] })
  async getAssetIds(tagId: string, assetIds: string[]): Promise<Set<string>> {
    if (assetIds.length === 0) {
      return new Set();
    }

    const results = await this.db
      .selectFrom('tag_asset')
      .select(['assetId as assetId'])
      .where('tagId', '=', tagId)
      .where('assetId', 'in', assetIds)
      .execute();

    return new Set(results.map(({ assetId }) => assetId));
  }

  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID]] })
  async addAssetIds(tagId: string, assetIds: string[]): Promise<void> {
    if (assetIds.length === 0) {
      return;
    }

    await this.upsertAssetIds(assetIds.map((assetId) => ({ tagId, assetId })));
  }

  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID]] })
  @Chunked({ paramIndex: 1 })
  async removeAssetIds(tagId: string, assetIds: string[]): Promise<void> {
    if (assetIds.length === 0) {
      return;
    }

    await this.db.deleteFrom('tag_asset').where('tagId', '=', tagId).where('assetId', 'in', assetIds).execute();
  }

  @GenerateSql({ params: [[{ assetId: DummyValue.UUID, tagIds: DummyValue.UUID }]] })
  upsertAssetIds(items: Insertable<TagAssetTable>[]) {
    if (items.length === 0) {
      return Promise.resolve([]);
    }

    const execute = async (tx: Kysely<DB>) => {
      const results: Selectable<TagAssetTable>[] = [];
      // Each membership can bind assetId, tagId and a supplied updateId.
      for (const batch of chunk(items, Math.floor(DATABASE_PARAMETER_CHUNK_SIZE / 3))) {
        const inserted = await tx
          .insertInto('tag_asset')
          .values(batch)
          .onConflict((oc) => oc.doNothing())
          .returningAll()
          .execute();
        results.push(...inserted);
      }
      return results;
    };
    return this.db.isTransaction ? execute(this.db) : this.db.transaction().execute(execute);
  }

  /** Removes the owner's tags with these exact values from one asset, leaving every other tag on it. */
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID, [DummyValue.STRING]] })
  async removeAssetTagValues(assetId: string, userId: string, values: string[]): Promise<void> {
    if (values.length === 0) {
      return;
    }

    await this.db
      .deleteFrom('tag_asset')
      .where('assetId', '=', assetId)
      .where('tagId', 'in', (eb) =>
        eb.selectFrom('tag').select('tag.id').where('tag.userId', '=', userId).where('tag.value', 'in', values),
      )
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID]] })
  replaceAssetTags(assetId: string, tagIds: string[]) {
    const execute = async (tx: Kysely<DB>) => {
      await tx.deleteFrom('tag_asset').where('assetId', '=', assetId).execute();

      if (tagIds.length === 0) {
        return;
      }

      return tx
        .insertInto('tag_asset')
        .columns(['assetId', 'tagId'])
        .expression((eb) =>
          eb
            .selectFrom(dummy)
            .select([asUuid(assetId).as('assetId'), sql<string>`unnest(${tagIds}::uuid[])`.as('tagId')]),
        )
        .onConflict((oc) => oc.doNothing())
        .returningAll()
        .execute();
    };
    return this.db.isTransaction ? execute(this.db) : this.db.transaction().execute(execute);
  }

  async deleteEmptyTags() {
    const result = await this.db
      .deleteFrom('tag')
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('tag_closure')
              .whereRef('tag.id', '=', 'tag_closure.id_ancestor')
              .innerJoin('tag_asset', 'tag_closure.id_descendant', 'tag_asset.tagId'),
          ),
        ),
      )
      .executeTakeFirst();

    const deletedRows = Number(result.numDeletedRows);
    if (deletedRows > 0) {
      this.logger.log(`Deleted ${deletedRows} empty tags`);
    }
  }

  insertTagWithClosures(insertTag: (db: QueryCreator<DB>) => InsertQueryBuilder<DB, 'tag', Selectable<TagTable>>) {
    return this.db
      .with('created_tag', insertTag)
      .with('created_tag_closures', (db) =>
        db
          .insertInto('tag_closure')
          .columns(['id_ancestor', 'id_descendant'])
          .expression((eb) =>
            eb
              .selectFrom('created_tag')
              .select(['created_tag.id as id_ancestor', 'created_tag.id as id_descendant'])
              .unionAll(
                eb
                  .selectFrom('created_tag')
                  .innerJoin('tag_closure', 'tag_closure.id_descendant', 'created_tag.parentId')
                  .select(['tag_closure.id_ancestor', 'created_tag.id as id_descendant']),
              ),
          )
          .onConflict((oc) => oc.doNothing()),
      )
      .selectFrom('created_tag')
      .selectAll()
      .executeTakeFirstOrThrow();
  }
}
