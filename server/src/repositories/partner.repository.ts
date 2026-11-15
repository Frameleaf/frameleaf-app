import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { jsonObjectFrom } from 'kysely/helpers/postgres';
import { InjectKysely } from 'nestjs-kysely';
import type { ExpressionBuilder, Insertable, Kysely, NotNull } from 'kysely';
import { columns } from 'src/database.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { LibraryScope } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { PartnerTable } from 'src/schema/tables/partner.table.js';
import { libraryScopePredicate } from 'src/utils/library-scope.js';
import { type PartnerScopeChoice, draftScope, inScope } from 'src/utils/partner-scope.js';

export interface PartnerIds {
  sharedById: string;
  sharedWithId: string;
}

export enum PartnerDirection {
  SharedBy = 'shared-by',
  SharedWith = 'shared-with',
}

const withSharedBy = (eb: ExpressionBuilder<DB, 'partner'>) => {
  return jsonObjectFrom(
    eb.selectFrom('user as sharedBy').select(columns.user).whereRef('sharedBy.id', '=', 'partner.sharedById'),
  ).as('sharedBy');
};

const withSharedWith = (eb: ExpressionBuilder<DB, 'partner'>) => {
  return jsonObjectFrom(
    eb.selectFrom('user as sharedWith').select(columns.user).whereRef('sharedWith.id', '=', 'partner.sharedWithId'),
  ).as('sharedWith');
};

@Injectable()
export class PartnerRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  @GenerateSql({ params: [DummyValue.UUID] })
  getAll(userId: string) {
    return this.builder()
      .where((eb) => eb.or([eb('sharedWithId', '=', userId), eb('sharedById', '=', userId)]))
      .execute();
  }

  @GenerateSql({ params: [{ sharedWithId: DummyValue.UUID, sharedById: DummyValue.UUID }] })
  get({ sharedWithId, sharedById }: PartnerIds) {
    return this.builder()
      .where('sharedWithId', '=', sharedWithId)
      .where('sharedById', '=', sharedById)
      .executeTakeFirst();
  }

  create(values: Insertable<PartnerTable>) {
    return this.db
      .insertInto('partner')
      .values(values)
      .returningAll()
      .returning(withSharedBy)
      .returning(withSharedWith)
      .$narrowType<{ sharedWith: NotNull; sharedBy: NotNull }>()
      .executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [{ sharedWithId: DummyValue.UUID, sharedById: DummyValue.UUID }] })
  async remove({ sharedWithId, sharedById }: PartnerIds) {
    await this.db
      .deleteFrom('partner')
      .where('sharedWithId', '=', sharedWithId)
      .where('sharedById', '=', sharedById)
      .execute();
  }

  /** FL-774: what this partnership sends when its owner chose "Only what I choose"; undefined means Everything. */
  async getScope({ sharedById, sharedWithId }: PartnerIds): Promise<PartnerScopeChoice | undefined> {
    const row = await this.db
      .selectFrom('partner_scope')
      .select([sql<string | null>`"sinceDate"::text`.as('sinceDate'), 'albumIds', 'personIds', 'folders'])
      .where('sharedById', '=', sharedById)
      .where('sharedWithId', '=', sharedWithId)
      .executeTakeFirst();
    return row
      ? { sinceDate: row.sinceDate, albumIds: row.albumIds, personIds: row.personIds, folders: row.folders }
      : undefined;
  }

  /** FL-774: save a partnership's scope; `null` goes back to Everything. */
  async setScope({ sharedById, sharedWithId }: PartnerIds, scope: PartnerScopeChoice | null): Promise<void> {
    if (!scope) {
      await this.db
        .deleteFrom('partner_scope')
        .where('sharedById', '=', sharedById)
        .where('sharedWithId', '=', sharedWithId)
        .execute();
      return;
    }
    const values = {
      sinceDate: scope.sinceDate,
      albumIds: scope.albumIds,
      personIds: scope.personIds,
      folders: scope.folders,
      updatedAt: sql<Date>`now()`,
    };
    await this.db
      .insertInto('partner_scope')
      .values({ sharedById, sharedWithId, ...values })
      .onConflict((oc) => oc.columns(['sharedById', 'sharedWithId']).doUpdateSet(values))
      .execute();
  }

  /** FL-774: whether a partnership's scope sends this album (always, when it shares Everything). */
  async isAlbumInScope({ sharedById, sharedWithId }: PartnerIds, albumId: string): Promise<boolean> {
    const scope = await this.getScope({ sharedById, sharedWithId });
    return !scope || scope.albumIds.includes(albumId.toLowerCase());
  }

  /**
   * FL-774: the chosen albums (plain albums the owner owns) and people (the owner's) with their names, in the order
   * chosen. Ids that are not the owner's are left out, so a caller can tell they were refused.
   */
  async getScopeLabels(
    ownerId: string,
    { albumIds, personIds }: Pick<PartnerScopeChoice, 'albumIds' | 'personIds'>,
  ): Promise<{ albums: Array<{ id: string; name: string }>; people: Array<{ id: string; name: string }> }> {
    const { rows } = await sql<{ kind: 'album' | 'person'; id: string; name: string }>`
      SELECT 'album' AS kind, al.id, al."albumName" AS name FROM public.album al
      WHERE al.id = ANY(${albumIds}::uuid[]) AND al."deletedAt" IS NULL AND al.kind = 'album'
        AND EXISTS (SELECT 1 FROM public.album_user au WHERE au."albumId" = al.id
          AND au."userId" = ${ownerId}::uuid AND au.role = 'owner')
      UNION ALL
      SELECT DISTINCT ON (p."personGroupId") 'person', p."personGroupId", p.name FROM public.person p
      WHERE p."personGroupId" = ANY(${personIds}::uuid[]) AND p."ownerId" = ${ownerId}::uuid
    `.execute(this.db);
    const pick = (kind: string, ids: string[]) => {
      const found = new Map(rows.filter((row) => row.kind === kind).map((row) => [row.id, row.name]));
      return ids.filter((id) => found.has(id)).map((id) => ({ id, name: found.get(id)! }));
    };
    return { albums: pick('album', albumIds), people: pick('person', personIds) };
  }

  /** FL-774: how many of the owner's items a scope (saved or not yet) sends now; `null` counts Everything. */
  async countInScope(ownerId: string, scope: PartnerScopeChoice | null): Promise<number> {
    const { rows } = await sql<{ count: number }>`
      SELECT count(*)::int AS count FROM public.asset a ${scope ? sql`CROSS JOIN ${draftScope(scope)} s` : sql``}
      WHERE a."ownerId" = ${ownerId}::uuid AND a."deletedAt" IS NULL
        AND ${libraryScopePredicate(LibraryScope.Personal, 'a')} ${scope ? sql`AND ${inScope}` : sql``}
    `.execute(this.db);
    return rows[0]?.count ?? 0;
  }

  private builder() {
    return this.db
      .selectFrom('partner')
      .innerJoin('user as sharedBy', (join) =>
        join.onRef('partner.sharedById', '=', 'sharedBy.id').on('sharedBy.deletedAt', 'is', null),
      )
      .innerJoin('user as sharedWith', (join) =>
        join.onRef('partner.sharedWithId', '=', 'sharedWith.id').on('sharedWith.deletedAt', 'is', null),
      )
      .selectAll('partner')
      .select(withSharedBy)
      .select(withSharedWith);
  }
}
