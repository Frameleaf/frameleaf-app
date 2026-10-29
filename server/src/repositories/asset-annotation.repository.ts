import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { AssetAnnotationItem, AssetAnnotationItemsSchema } from 'src/dtos/asset-annotation.dto.js';
import { AssetType, AssetVisibility, LibraryScope } from 'src/enum.js';
import { DB } from 'src/schema/index.js';

/**
 * Fingerprint of the picture annotations are drawn on: the file itself, its edits and the owner's
 * current develop version. Notes, ratings and other details leave it unchanged, so writing them never
 * marks the annotations as drawn on a different picture.
 */
export const assetAnnotationRevision = (alias = 'asset') => {
  const ref = (column: string) => sql.ref(`${alias}.${column}`);
  return sql<string>`md5(jsonb_build_array(
    encode(${ref('checksum')}, 'hex'), ${ref('isEdited')},
    (select jsonb_agg(jsonb_build_array(e.action, e.parameters) order by e.sequence, e.id) from asset_edit e where e."assetId" = ${ref('id')}),
    (select d.id from asset_develop_revision d where d."assetId" = ${ref('id')} and d."ownerId" = ${ref('ownerId')} and d."isCurrent" limit 1)
  )::text)`;
};

export type AnnotatedAsset = {
  id: string;
  ownerId: string;
  type: AssetType;
  libraryScope: LibraryScope;
  sourceRevision: string;
};

export type StoredAnnotations = {
  sourceRevision: string;
  items: AssetAnnotationItem[];
  updatedAt: Date;
};

@Injectable()
export class AssetAnnotationRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /** The picture an annotation document belongs to, while it is in the library. */
  getAsset(id: string, db: Kysely<DB> = this.db): Promise<AnnotatedAsset | undefined> {
    return db
      .selectFrom('asset')
      .select(['asset.id', 'asset.ownerId', 'asset.type', 'asset.libraryScope'])
      .select(assetAnnotationRevision().as('sourceRevision'))
      .where('asset.id', '=', id)
      .where('asset.deletedAt', 'is', null)
      .where('asset.visibility', '!=', AssetVisibility.Hidden)
      .executeTakeFirst();
  }

  async get(assetId: string): Promise<StoredAnnotations | undefined> {
    const row = await this.db
      .selectFrom('asset_annotation')
      .select(['version', 'sourceRevision', 'items', 'updatedAt'])
      .where('assetId', '=', assetId)
      .executeTakeFirst();
    if (!row || row.version !== 1) {
      return;
    }
    // A stored document that no longer reads as valid is treated as none, never served half-parsed.
    const items = AssetAnnotationItemsSchema.safeParse(row.items);
    return items.success
      ? { sourceRevision: row.sourceRevision, items: items.data, updatedAt: new Date(row.updatedAt) }
      : undefined;
  }

  /**
   * Replaces the whole document. `expected` is the picture revision the caller's positions were drawn
   * on, as it read it. It must be the picture's current revision, or the revision of the document
   * already stored when the caller is editing annotations it knows were drawn on an older picture;
   * those stay marked as drawn on that older picture. Anything else means the picture changed after
   * the caller read it, and nothing is written (`'conflict'`), so stale positions are never stamped
   * as fitting the new picture. An empty list removes the document. Only this table is written: the
   * asset row, its file and its edits are never touched.
   */
  replace(
    assetId: string,
    items: AssetAnnotationItem[],
    expected: string,
  ): Promise<StoredAnnotations | 'conflict' | undefined> {
    return this.db.transaction().execute(async (tx) => {
      const asset = await tx
        .selectFrom('asset')
        .select('id')
        .where('id', '=', assetId)
        .where('deletedAt', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      const current = asset ? await this.getAsset(assetId, tx) : undefined;
      if (!current) {
        return;
      }
      const existing = await tx
        .selectFrom('asset_annotation')
        .select('sourceRevision')
        .where('assetId', '=', assetId)
        .forUpdate()
        .executeTakeFirst();
      const sourceRevision =
        expected === current.sourceRevision
          ? current.sourceRevision
          : existing && expected === existing.sourceRevision
            ? existing.sourceRevision
            : undefined;
      if (!sourceRevision) {
        return 'conflict';
      }
      if (items.length === 0) {
        await tx.deleteFrom('asset_annotation').where('assetId', '=', assetId).execute();
        return;
      }
      const values = { version: 1 as const, sourceRevision, items };
      const row = await tx
        .insertInto('asset_annotation')
        .values({ assetId, ...values })
        .onConflict((oc) => oc.column('assetId').doUpdateSet({ ...values, updatedAt: new Date() }))
        .returning(['sourceRevision', 'updatedAt'])
        .executeTakeFirstOrThrow();
      return { sourceRevision: row.sourceRevision, items, updatedAt: new Date(row.updatedAt) };
    });
  }
}

export const isBoardsScope = (scope: LibraryScope) => scope === LibraryScope.Design || scope === LibraryScope.Both;
