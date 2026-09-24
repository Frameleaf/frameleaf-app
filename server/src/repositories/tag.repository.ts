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
import { InjectKysely } from 'nestjs-kysely';
import type { PostgresError } from 'postgres';
import type { HiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import { columns } from 'src/database.js';
import { Chunked, ChunkedSet, DummyValue, GenerateSql } from 'src/decorators.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { TagAssetTable } from 'src/schema/tables/tag-asset.table.js';
import { TagTable } from 'src/schema/tables/tag.table.js';
import { getHiddenContentFilter, tagHasVisibleAssetOrNoAssets, tagIsSuppressed } from 'src/utils/database.js';

export type TagSearchOptions = HiddenContentQueryOptions;

/** A tag's new leaf name, colour and parent (`null`: top level); omitted fields stay as they are. */
export type TagUpdate = { name?: string; color?: string | null; parentId?: string | null };

const TAG_VALUE_CONSTRAINT = 'tag_userId_value_uq';
const TAG_EXISTS = 'A tag with that name already exists';

@Injectable()
export class TagRepository {
  constructor(
    @InjectKysely() private db: Kysely<DB>,
    private logger: LoggingRepository,
  ) {
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

  @GenerateSql({ params: [DummyValue.UUID, { excludeNsfw: true }] })
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
      .$if(!!getHiddenContentFilter(options), (qb) =>
        qb.where(tagHasVisibleAssetOrNoAssets(sql.ref('tag.id'), getHiddenContentFilter(options))),
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

        await tx
          .selectFrom('tag')
          .select('id')
          .where('userId', '=', (eb) => eb.selectFrom('tag as moved').select('moved.userId').where('moved.id', '=', id))
          .orderBy('id')
          .forUpdate()
          .execute();
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
      });
    } catch (error) {
      if ((error as PostgresError)?.constraint_name === TAG_VALUE_CONSTRAINT) {
        throw new BadRequestException(TAG_EXISTS);
      }
      throw error;
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
  @Chunked({ paramIndex: 1 })
  async addAssetIds(tagId: string, assetIds: string[]): Promise<void> {
    if (assetIds.length === 0) {
      return;
    }

    await this.db
      .insertInto('tag_asset')
      .values(assetIds.map((assetId) => ({ tagId, assetId })))
      .execute();
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
  @Chunked()
  upsertAssetIds(items: Insertable<TagAssetTable>[]) {
    if (items.length === 0) {
      return Promise.resolve([]);
    }

    return this.db
      .insertInto('tag_asset')
      .values(items)
      .onConflict((oc) => oc.doNothing())
      .returningAll()
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID]] })
  @Chunked({ paramIndex: 1 })
  replaceAssetTags(assetId: string, tagIds: string[]) {
    return this.db.transaction().execute(async (tx) => {
      await tx.deleteFrom('tag_asset').where('assetId', '=', assetId).execute();

      if (tagIds.length === 0) {
        return;
      }

      return tx
        .insertInto('tag_asset')
        .values(tagIds.map((tagId) => ({ tagId, assetId })))
        .onConflict((oc) => oc.doNothing())
        .returningAll()
        .execute();
    });
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
