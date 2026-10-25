import { ConflictException, Injectable } from '@nestjs/common';
import {
  type Insertable,
  type Kysely,
  type Selectable,
  type SqlBool,
  type Transaction,
  type Updateable,
  sql,
} from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { HiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import type { SourceReference } from 'src/utils/source-reference.js';
import { AssetEditAction } from 'src/dtos/editing.dto.js';
import { AssetStatus, AssetVisibility, ChecksumAlgorithm, DocumentEditAction, UserStatus } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { AssetDocumentEditTable } from 'src/schema/tables/asset-document-edit.table.js';
import { type AssetSourceSnapshot, readAssetSource } from 'src/utils/asset-source-authority.js';
import { asUuid, tokenizeForSearch, withEdits, withHiddenContentFilter } from 'src/utils/database.js';
import { isLocked, revealedLockScope } from 'src/utils/locked.js';
import { canonicalJson } from 'src/utils/object.js';
import { paginationHelper } from 'src/utils/pagination.js';

export type DocumentEdit = Selectable<AssetDocumentEditTable>;

export type DocumentSearchOptions = HiddenContentQueryOptions & {
  ownerId: string;
  /**
   * The owner, only when their session is elevated: then the Locked photos their timeline reveals
   * (their own marks and detections) are documents too, exactly as the timeline shows them.
   */
  lockedOwnerId?: string;
  query?: string;
  page: number;
  size: number;
};

/** Thrown when a write lost a race: the decision changed, or another one for the same key appeared. */
export class DocumentEditConflictError extends Error {}

const isUniqueViolation = (error: unknown): boolean => (error as { code?: string } | null)?.code === '23505';

const escapeLike = (value: string) => value.replaceAll(/[\\%_]/g, String.raw`\$&`);
const SOURCE_VERSION_ARCHIVE_PREFIX = 'source-version:';
const archivedSourcePattern = `${SOURCE_VERSION_ARCHIVE_PREFIX}%`;

/**
 * Documents (FL-63): photos with recognized text, and the owner's decisions about that text.
 *
 * The recognized text itself is read through `OcrRepository` (visible lines only); this repository
 * never writes `asset_ocr` or `ocr_search`.
 */
@Injectable()
export class DocumentRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /**
   * The owner's photos that currently show recognized text, newest first. A photo whose every line a
   * crop removed has an empty `ocr_search` row and is not a document. `query` matches the recognized
   * text the way "Text in photos" search does, or the owner's own corrections and confirmed values.
   * Without a query the timeline is listed; with one, the archive too, as every library collection
   * in the design does (`collection !== "Locked" ? filter.visibility || query.text ? true : asset.visibility
   * !== "archive"` in design/frameleaf/template/src/App.jsx).
   *
   * A correction only matches while the crop cannot have removed its text: on a cropped photo only
   * decisions without a region (a value the owner typed) are searched, besides the visible text.
   */
  async search(options: DocumentSearchOptions) {
    const text = options.query?.trim() ?? '';
    const tokens = text ? tokenizeForSearch(text).join(' ') : '';

    const base = this.db
      .selectFrom('asset')
      .where('asset.ownerId', '=', asUuid(options.ownerId))
      .where('asset.deletedAt', 'is', null)
      .where('asset.status', '=', sql.lit(AssetStatus.Active))
      .where('asset.visibility', 'in', [
        sql.lit(AssetVisibility.Timeline),
        ...(text ? [sql.lit(AssetVisibility.Archive)] : []),
      ])
      .where(revealedLockScope(options.lockedOwnerId, 'asset'))
      .$call((qb) => withHiddenContentFilter(qb, options))
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('ocr_search')
            .select(sql`1`.as('found'))
            .whereRef('ocr_search.assetId', '=', 'asset.id')
            .where('ocr_search.text', '!=', ''),
        ),
      )
      .$if(!!text, (qb) =>
        qb.where((eb) =>
          eb.or([
            eb.exists(
              eb
                .selectFrom('ocr_search')
                .select(sql`1`.as('found'))
                .whereRef('ocr_search.assetId', '=', 'asset.id')
                .where(
                  tokens ? sql<SqlBool>`f_unaccent(ocr_search.text) %>> f_unaccent(${tokens})` : sql<SqlBool>`false`,
                ),
            ),
            eb.exists(
              eb
                .selectFrom('asset_document_edit')
                .select(sql`1`.as('found'))
                .where('asset_document_edit.key', 'not like', archivedSourcePattern)
                .whereRef('asset_document_edit.assetId', '=', 'asset.id')
                .where('asset_document_edit.action', 'in', [
                  sql.lit(DocumentEditAction.Correct),
                  sql.lit(DocumentEditAction.Confirm),
                ])
                .where(
                  sql<SqlBool>`f_unaccent(asset_document_edit.value) ilike '%' || f_unaccent(${escapeLike(text)}) || '%'`,
                )
                .where((edit) =>
                  edit.or([
                    edit('asset_document_edit.x1', 'is', null),
                    edit.not(
                      edit.exists(
                        edit
                          .selectFrom('asset_edit')
                          .select(sql`1`.as('found'))
                          .where('asset.isEdited', '=', true)
                          .whereRef('asset_edit.assetId', '=', 'asset.id')
                          .where('asset_edit.action', '=', sql.lit(AssetEditAction.Crop)),
                      ),
                    ),
                  ]),
                ),
            ),
          ]),
        ),
      );

    const [{ count }, items] = await Promise.all([
      base.select((eb) => eb.fn.countAll().as('count')).executeTakeFirstOrThrow(),
      base
        .selectAll('asset')
        .select(isLocked('asset').as('isLocked'))
        .orderBy('asset.fileCreatedAt', 'desc')
        .orderBy('asset.id', 'desc')
        .limit(options.size + 1)
        .offset((options.page - 1) * options.size)
        .execute(),
    ]);

    return { ...paginationHelper(items, options.size), total: Number(count) };
  }

  /** What a document read needs about the photo itself: owner, state, edits and original size. */
  getAsset(id: string) {
    return this.db
      .selectFrom('asset')
      .where('asset.id', '=', asUuid(id))
      .select(['asset.id', 'asset.ownerId', 'asset.visibility', 'asset.deletedAt', 'asset.type'])
      .select(withEdits)
      .leftJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .select(['asset_exif.exifImageWidth', 'asset_exif.exifImageHeight', 'asset_exif.orientation'])
      .leftJoin('asset_job_status', 'asset_job_status.assetId', 'asset.id')
      .select('asset_job_status.ocrAt')
      .executeTakeFirst();
  }

  getEdits(assetId: string): Promise<DocumentEdit[]> {
    return this.db
      .selectFrom('asset_document_edit')
      .selectAll()
      .where('assetId', '=', asUuid(assetId))
      .where('key', 'not like', archivedSourcePattern)
      .orderBy('createdAt', 'asc')
      .execute();
  }

  readSource(assetId: string) {
    return readAssetSource(this.db, assetId, true);
  }

  /** Cached-text decisions need stable pixels and projection, not permission to fetch the original again. */
  withSource<T>(expected: AssetSourceSnapshot, write: (repository: DocumentRepository) => Promise<T>): Promise<T> {
    const execute = async (tx: Transaction<DB>) => {
      const owner = await tx
        .selectFrom('user')
        .select('id')
        .where('id', '=', expected.ownerId)
        .where('deletedAt', 'is', null)
        .where('status', '=', UserStatus.Active)
        .forShare()
        .executeTakeFirst();
      if (!owner) throw new DocumentEditConflictError('The document owner is unavailable');
      const asset = await tx
        .selectFrom('asset')
        .select('id')
        .where('id', '=', expected.assetId)
        .where('ownerId', '=', expected.ownerId)
        .forShare()
        .executeTakeFirst();
      const check = async () => {
        const current = await readAssetSource(tx, expected.assetId, true);
        if (!asset || !current || canonicalJson(current) !== canonicalJson(expected))
          throw new DocumentEditConflictError('The document original or projection changed');
      };
      await check();
      const result = await write(new DocumentRepository(tx));
      await check();
      return result;
    };
    return this.db.isTransaction ? execute(this.db as Transaction<DB>) : this.db.transaction().execute(execute);
  }

  /** A new decision. Refused when one for the same key already exists (someone was first). */
  async create(values: Insertable<AssetDocumentEditTable>): Promise<DocumentEdit> {
    try {
      return await this.db.insertInto('asset_document_edit').values(values).returningAll().executeTakeFirstOrThrow();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DocumentEditConflictError('A decision for this text already exists');
      }
      throw error;
    }
  }

  /** Changes a decision only if it is still at `revision`, and moves it to the next one. */
  async update(
    id: string,
    revision: number,
    values: Omit<Updateable<AssetDocumentEditTable>, 'id' | 'assetId' | 'revision' | 'createdAt'>,
  ): Promise<DocumentEdit> {
    const updated = await this.db
      .updateTable('asset_document_edit')
      .set({ ...values, revision: sql<number>`"revision" + 1`, updatedAt: new Date() })
      .where('id', '=', asUuid(id))
      .where('revision', '=', revision)
      .where('key', 'not like', archivedSourcePattern)
      .returningAll()
      .executeTakeFirst();
    if (!updated) {
      throw new DocumentEditConflictError('The decision changed since it was read');
    }
    return updated;
  }

  /** Removes a decision only if it is still at `revision`. */
  async delete(id: string, assetId: string, revision: number): Promise<void> {
    const result = await this.db
      .deleteFrom('asset_document_edit')
      .where('id', '=', asUuid(id))
      .where('assetId', '=', asUuid(assetId))
      .where('revision', '=', revision)
      .where('key', 'not like', archivedSourcePattern)
      .executeTakeFirst();
    if (Number(result.numDeletedRows) === 0) {
      throw new DocumentEditConflictError('The decision changed since it was read');
    }
  }

  /** Retire decisions inside the owner's source-publication transaction; this does not grant original-read authority. */
  archiveForSourceChange(assetId: string, expected: SourceReference): Promise<number> {
    const execute = async (tx: Transaction<DB>) => {
      const { rows } = await sql`SELECT b."assetId" FROM source_original b
        JOIN photo_source_resource r ON r.id=b."resourceId" AND r."assetId"=b."assetId"
        JOIN photo_source_run run ON run.id=r."runId"
        JOIN photo_source s ON s.id=run."sourceId" AND s.mode='reference'
        JOIN asset a ON a.id=b."assetId" AND a."ownerId"=s."ownerId" AND a."isExternal"
          AND a."checksumAlgorithm"=${ChecksumAlgorithm.sha1Path}
          AND a."originalPath"='frameleaf-source://' || s.id::text || '/' || r."resourceKey"
        WHERE b."assetId"=${assetId}::uuid AND r.id=${expected.resourceId}::uuid
          AND r.version=${expected.version} AND encode(r.checksum,'hex')=${expected.sha256}
          AND r.state='verified' AND r."verifiedAt" IS NOT NULL FOR SHARE OF b,r`.execute(tx);
      if (!rows[0]) throw new ConflictException('document_source_changed');
      const result = await tx
        .updateTable('asset_document_edit')
        .set({
          key: sql<string>`${SOURCE_VERSION_ARCHIVE_PREFIX} || ${expected.resourceId}::text || ':' || id::text || ':' || key`,
          revision: sql<number>`revision + 1`,
          updatedAt: new Date(),
        })
        .where('assetId', '=', assetId)
        .where('key', 'not like', archivedSourcePattern)
        .executeTakeFirst();
      return Number(result.numUpdatedRows);
    };
    return this.db.isTransaction ? execute(this.db as Transaction<DB>) : this.db.transaction().execute(execute);
  }
}
