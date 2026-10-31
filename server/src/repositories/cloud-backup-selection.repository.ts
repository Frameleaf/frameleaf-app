import { Injectable } from '@nestjs/common';
import { Kysely, RawBuilder, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { Selectable } from 'kysely';
import type { CloudBackupCoverageReportTable } from 'src/schema/tables/cloud-backup-selection.table.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { AssetStatus } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import {
  type BackupLicenceScope,
  CLOUD_BACKUP_DESTINATION,
  type CloudBackupChosen,
  type CloudBackupDecisionReason,
  type CloudBackupSelection,
  backupUserFingerprint,
  isLicenceEligible,
  selectionHash,
} from 'src/utils/cloud-backup-selection.js';
import { isLocked } from 'src/utils/locked.js';

export type CloudBackupDecisionRun = {
  runId: string;
  manifestKey: string;
  inventoryAt: Date;
  licenceScope: BackupLicenceScope['scope'];
};
export type CloudBackupDecisionAccount = {
  userId: string;
  userFingerprint: string;
  selectionHash: string | null;
  totalOriginals: number;
  selectedOriginals: number;
  licenceEligible: boolean;
  includedOriginals: number | null;
};
export type CloudBackupCoverageReport = Selectable<CloudBackupCoverageReportTable>;
export type CloudBackupInventoryItem = {
  id: string;
  ownerId: string;
  originalFileName: string;
  /** Locked: its name is never shown in a restore list. */
  locked: boolean;
  reason: CloudBackupDecisionReason | null;
};

/** The assets a Cloud Backup run walks: every owner's, Locked and trashed included; never external files. */
const WALK_STATUSES = [AssetStatus.Active, AssetStatus.Trashed];

/**
 * FL-362: whether the asset `a` matches the choice `s` (any of its parts). `inventoryAt` anchors "the last
 * N months". Collections are albums that hold albums; a tag also chooses the tags inside it.
 */
const matchesChoice = (inventoryAt: RawBuilder<Date> | Date) => sql<boolean>`(
  (s.favorites AND a."isFavorite")
  OR EXISTS (
    SELECT 1 FROM public.album_asset aa
    JOIN public.album al ON al.id = aa."albumId" AND al."deletedAt" IS NULL
    WHERE aa."assetId" = a.id AND aa."albumId" = ANY(s."albumIds"))
  OR EXISTS (
    SELECT 1 FROM public.album_asset aa
    JOIN public.album al ON al.id = aa."albumId" AND al."deletedAt" IS NULL
    JOIN public.album_closure c ON c.id_descendant = aa."albumId"
    JOIN public.album collection ON collection.id = c.id_ancestor
      AND collection."deletedAt" IS NULL AND collection.kind = 'collection'
    WHERE aa."assetId" = a.id AND c.id_ancestor = ANY(s."collectionIds"))
  OR EXISTS (
    SELECT 1 FROM public.asset_face f
    WHERE f."assetId" = a.id AND f."personGroupId" = ANY(s."personIds")
      AND f."deletedAt" IS NULL AND f."isVisible" IS TRUE)
  OR EXISTS (
    SELECT 1 FROM public.tag_asset ta
    JOIN public.tag_closure tc ON tc.id_descendant = ta."tagId"
    WHERE ta."assetId" = a.id AND tc.id_ancestor = ANY(s."tagIds"))
  OR EXISTS (
    SELECT 1 FROM unnest(s.folders) AS folder(path)
    WHERE folder.path <> '' AND a."originalPath" LIKE
      replace(replace(replace(folder.path, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '/%')
  OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(s."dateRanges") AS chosen(range)
    WHERE CASE chosen.range ->> 'kind'
      WHEN 'between' THEN (a."localDateTime" AT TIME ZONE 'UTC')::date
        BETWEEN (chosen.range ->> 'from')::date AND (chosen.range ->> 'to')::date
      WHEN 'recent' THEN (a."localDateTime" AT TIME ZONE 'UTC')
        >= (${inventoryAt}::timestamptz AT TIME ZONE 'UTC') - make_interval(months => (chosen.range ->> 'months')::int)
      ELSE false END)
)`;

/** A choice passed in rather than read from the table, as `s`. */
const choiceRow = (chosen: CloudBackupChosen) => sql`(SELECT
  ${chosen.albumIds}::uuid[] AS "albumIds",
  ${chosen.collectionIds}::uuid[] AS "collectionIds",
  ${chosen.personIds}::uuid[] AS "personIds",
  ${chosen.tagIds}::uuid[] AS "tagIds",
  ${chosen.folders}::text[] AS folders,
  ${chosen.favorites}::boolean AS favorites,
  ${chosen.dateRanges}::jsonb AS "dateRanges")`;

const toChosen = (row: {
  albumIds: string[];
  collectionIds: string[];
  personIds: string[];
  tagIds: string[];
  folders: string[];
  favorites: boolean;
  dateRanges: unknown;
}): CloudBackupChosen => ({
  albumIds: row.albumIds,
  collectionIds: row.collectionIds,
  personIds: row.personIds,
  tagIds: row.tagIds,
  folders: row.folders,
  favorites: row.favorites,
  dateRanges: Array.isArray(row.dateRanges) ? (row.dateRanges as CloudBackupChosen['dateRanges']) : [],
});

/**
 * FL-362: each account's Cloud Backup choice, the inventory and decision each run takes before its
 * database copy (the decision a restore of that copy labels by), and the numeric coverage reports for
 * Frameleaf Cloud. Backend work: Locked items count like any other, and nothing here is shown to anyone
 * but the account itself (its own choice and items) or, as numbers only, an administrator.
 */
@Injectable()
export class CloudBackupSelectionRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /* ---------------------------------------------------------------- choices */

  /** An account's choice, without the albums, collections, people and tags that are gone since. */
  @GenerateSql({ params: [DummyValue.UUID] })
  async getSelection(userId: string): Promise<CloudBackupSelection> {
    const row = await this.db
      .selectFrom('cloud_backup_selection')
      .selectAll()
      .where('userId', '=', userId)
      .where('destination', '=', CLOUD_BACKUP_DESTINATION)
      .executeTakeFirst();
    if (!row) {
      return null;
    }
    const chosen = toChosen(row);
    const choosable = await this.choosable(userId, chosen);
    return { ...chosen, ...choosable };
  }

  /** Save an account's choice; `null` is Everything and removes it. */
  async setSelection(userId: string, chosen: CloudBackupSelection): Promise<void> {
    if (!chosen) {
      await this.db
        .deleteFrom('cloud_backup_selection')
        .where('userId', '=', userId)
        .where('destination', '=', CLOUD_BACKUP_DESTINATION)
        .execute();
      return;
    }
    const values = {
      albumIds: chosen.albumIds,
      collectionIds: chosen.collectionIds,
      personIds: chosen.personIds,
      tagIds: chosen.tagIds,
      folders: chosen.folders,
      favorites: chosen.favorites,
      dateRanges: chosen.dateRanges,
      updatedAt: sql`now()` as never,
    };
    await this.db
      .insertInto('cloud_backup_selection')
      .values({ userId, destination: CLOUD_BACKUP_DESTINATION, ...values })
      .onConflict((oc) => oc.columns(['userId', 'destination']).doUpdateSet(values))
      .execute();
  }

  /**
   * Of the albums, collections, people and tags a choice names, the ones this account may choose from its
   * own library: albums it owns or that are shared with it (`album_user`), the collections it owns, its own
   * people and tags.
   */
  @GenerateSql({
    params: [
      DummyValue.UUID,
      {
        albumIds: [DummyValue.UUID],
        collectionIds: [DummyValue.UUID],
        personIds: [DummyValue.UUID],
        tagIds: [DummyValue.UUID],
        folders: [],
        favorites: false,
        dateRanges: [],
      },
    ],
  })
  async choosable(
    userId: string,
    chosen: Pick<CloudBackupChosen, 'albumIds' | 'collectionIds' | 'personIds' | 'tagIds'>,
  ): Promise<Pick<CloudBackupChosen, 'albumIds' | 'collectionIds' | 'personIds' | 'tagIds'>> {
    const { rows } = await sql<{ kind: 'album' | 'collection' | 'person' | 'tag'; id: string }>`
      SELECT 'album' AS kind, al.id FROM public.album al
      WHERE al.id = ANY(${chosen.albumIds}::uuid[]) AND al."deletedAt" IS NULL AND al.kind = 'album'
        AND EXISTS (SELECT 1 FROM public.album_user au WHERE au."albumId" = al.id AND au."userId" = ${userId}::uuid)
      UNION ALL
      SELECT 'collection', al.id FROM public.album al
      WHERE al.id = ANY(${chosen.collectionIds}::uuid[]) AND al."deletedAt" IS NULL AND al.kind = 'collection'
        AND EXISTS (SELECT 1 FROM public.album_user au WHERE au."albumId" = al.id
          AND au."userId" = ${userId}::uuid AND au.role = 'owner')
      UNION ALL
      SELECT DISTINCT 'person', p."personGroupId" FROM public.person p
      WHERE p."personGroupId" = ANY(${chosen.personIds}::uuid[]) AND p."ownerId" = ${userId}::uuid
      UNION ALL
      SELECT 'tag', t.id FROM public.tag t
      WHERE t.id = ANY(${chosen.tagIds}::uuid[]) AND t."userId" = ${userId}::uuid
    `.execute(this.db);
    const of = (kind: string, ids: string[]) => {
      const found = new Set(rows.filter((row) => row.kind === kind).map((row) => row.id));
      return ids.filter((id) => found.has(id));
    };
    return {
      albumIds: of('album', chosen.albumIds),
      collectionIds: of('collection', chosen.collectionIds),
      personIds: of('person', chosen.personIds),
      tagIds: of('tag', chosen.tagIds),
    };
  }

  /** How many originals the account owns in the backup's walk set, and how many a choice keeps, now. */
  @GenerateSql({
    params: [
      DummyValue.UUID,
      {
        albumIds: [DummyValue.UUID],
        collectionIds: [],
        personIds: [],
        tagIds: [],
        folders: ['/data/library/user'],
        favorites: true,
        dateRanges: [{ kind: 'recent', months: 12 }],
      },
    ],
  })
  async estimate(userId: string, chosen: CloudBackupSelection): Promise<{ total: number; selected: number }> {
    const now = new Date();
    const query = chosen
      ? sql<{ total: number; selected: number }>`
          SELECT count(*)::int AS total, count(*) FILTER (WHERE ${matchesChoice(now)})::int AS selected
          FROM public.asset a CROSS JOIN ${choiceRow(chosen)} s
          WHERE a."ownerId" = ${userId}::uuid AND a.status = ANY(${WALK_STATUSES}::assets_status_enum[])
            AND a."isExternal" = false`
      : sql<{ total: number; selected: number }>`
          SELECT count(*)::int AS total, count(*)::int AS selected FROM public.asset a
          WHERE a."ownerId" = ${userId}::uuid AND a.status = ANY(${WALK_STATUSES}::assets_status_enum[])
            AND a."isExternal" = false`;
    const { rows } = await query.execute(this.db);
    return { total: rows[0]?.total ?? 0, selected: rows[0]?.selected ?? 0 };
  }

  /* ---------------------------------------------------------------- inventory */

  /**
   * The run's inventory, taken once in one consistent snapshot: every account (an empty one and one the
   * licence leaves out included), each owned original of the walk set with why it is or is not backed up,
   * and each account's totals. Every other run's record goes, so the database copy taken next carries this
   * run's alone. A second call for the same run answers the first inventory and changes nothing.
   */
  async captureInventory(input: {
    runId: string;
    manifestKey: string;
    instanceId: string;
    licence: BackupLicenceScope;
  }): Promise<{ inventoryAt: Date; created: boolean }> {
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .execute(async (trx) => {
        const existing = await trx
          .selectFrom('cloud_backup_decision_run')
          .select('inventoryAt')
          .where('runId', '=', input.runId)
          .executeTakeFirst();
        if (existing) {
          return { inventoryAt: new Date(existing.inventoryAt as unknown as string), created: false };
        }
        const {
          rows: [{ now }],
        } = await sql<{ now: Date }>`SELECT now() AS now`.execute(trx);
        const inventoryAt = new Date(now);
        await trx.deleteFrom('cloud_backup_decision_run').where('runId', '!=', input.runId).execute();
        await trx
          .insertInto('cloud_backup_decision_run')
          .values({
            runId: input.runId,
            manifestKey: input.manifestKey,
            inventoryAt,
            licenceScope: input.licence.scope,
          })
          .execute();

        const users = await trx.selectFrom('user').select('id').orderBy('id').execute();
        const choices = await trx
          .selectFrom('cloud_backup_selection')
          .selectAll()
          .where('destination', '=', CLOUD_BACKUP_DESTINATION)
          .execute();
        const choiceOf = new Map(choices.map((row) => [row.userId, toChosen(row)]));
        const accounts = users.map(({ id }) => {
          const userFingerprint = backupUserFingerprint(input.instanceId, id);
          return {
            userId: id,
            userFingerprint,
            selectionHash: selectionHash(choiceOf.get(id) ?? null),
            licenceEligible: isLicenceEligible(input.licence, userFingerprint),
          };
        });
        const eligible = accounts.filter((account) => account.licenceEligible).map(({ userId }) => userId);

        await sql`
          INSERT INTO public.cloud_backup_decision_asset ("runId", "assetId", "ownerId", reason)
          SELECT ${input.runId}::uuid, a.id, a."ownerId",
            CASE
              WHEN s."userId" IS NOT NULL AND NOT ${matchesChoice(inventoryAt)} THEN 'selection'
              WHEN NOT (a."ownerId" = ANY(${eligible}::uuid[])) THEN 'licence'
              ELSE 'included'
            END
          FROM public.asset a
          LEFT JOIN public.cloud_backup_selection s
            ON s."userId" = a."ownerId" AND s.destination = ${CLOUD_BACKUP_DESTINATION}
          WHERE a.status = ANY(${WALK_STATUSES}::assets_status_enum[]) AND a."isExternal" = false
        `.execute(trx);

        const counts = await trx
          .selectFrom('cloud_backup_decision_asset')
          .select((eb) => [
            'ownerId',
            eb.fn.countAll<number>().as('total'),
            eb.fn.count<number>('assetId').filterWhere('reason', '!=', 'selection').as('selected'),
          ])
          .where('runId', '=', input.runId)
          .groupBy('ownerId')
          .execute();
        const countOf = new Map(counts.map((row) => [row.ownerId, row]));
        if (accounts.length > 0) {
          await trx
            .insertInto('cloud_backup_decision_account')
            .values(
              accounts.map((account) => ({
                runId: input.runId,
                ...account,
                totalOriginals: Number(countOf.get(account.userId)?.total ?? 0),
                selectedOriginals: Number(countOf.get(account.userId)?.selected ?? 0),
                includedOriginals: null,
              })),
            )
            .execute();
        }
        return { inventoryAt, created: true };
      });
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async getDecisionRun(runId: string): Promise<CloudBackupDecisionRun | undefined> {
    const row = await this.db
      .selectFrom('cloud_backup_decision_run')
      .select(['runId', 'manifestKey', 'inventoryAt', 'licenceScope'])
      .where('runId', '=', runId)
      .executeTakeFirst();
    return row && { ...row, inventoryAt: new Date(row.inventoryAt as unknown as string) };
  }

  /** The decision of the backup that wrote this manifest, when this database holds it. */
  @GenerateSql({ params: [DummyValue.STRING] })
  async findDecisionRunByManifest(manifestKey: string): Promise<CloudBackupDecisionRun | undefined> {
    const row = await this.db
      .selectFrom('cloud_backup_decision_run')
      .select(['runId', 'manifestKey', 'inventoryAt', 'licenceScope'])
      .where('manifestKey', '=', manifestKey)
      .orderBy('createdAt', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row && { ...row, inventoryAt: new Date(row.inventoryAt as unknown as string) };
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async getDecisionAccounts(runId: string): Promise<CloudBackupDecisionAccount[]> {
    return this.db
      .selectFrom('cloud_backup_decision_account')
      .select([
        'userId',
        'userFingerprint',
        'selectionHash',
        'totalOriginals',
        'selectedOriginals',
        'licenceEligible',
        'includedOriginals',
      ])
      .where('runId', '=', runId)
      .orderBy('userFingerprint')
      .execute();
  }

  /** The accounts whose originals and profile images this run may upload. */
  @GenerateSql({ params: [DummyValue.UUID] })
  async getEligibleOwners(runId: string): Promise<Set<string>> {
    const rows = await this.db
      .selectFrom('cloud_backup_decision_account')
      .select('userId')
      .where('runId', '=', runId)
      .where('licenceEligible', '=', true)
      .execute();
    return new Set(rows.map(({ userId }) => userId));
  }

  /**
   * Each account's originals in the run's committed manifest, counted from the manifest's recorded
   * originals of the run's included items, before those records are removed. Counted once.
   */
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  async recordIncluded(runId: string, manifestId: string): Promise<void> {
    await sql`
      UPDATE public.cloud_backup_decision_account account
      SET "includedOriginals" = (
        SELECT count(*)::int FROM public.cloud_backup_manifest_entry entry
        JOIN public.cloud_backup_decision_asset decision
          ON decision."runId" = account."runId" AND decision."assetId" = entry."assetId"
          AND decision.reason = 'included'
        WHERE entry."manifestId" = ${manifestId}::uuid AND entry.role = 'original'
          AND decision."ownerId" = account."userId")
      WHERE account."runId" = ${runId}::uuid AND account."includedOriginals" IS NULL
    `.execute(this.db);
  }

  /**
   * The walk set as this database holds it now, after `afterId`, with each item's reason in the run's
   * decision (null when the run has none for it). Optionally one owner's items only.
   */
  @GenerateSql({ params: [DummyValue.UUID, null, DummyValue.NUMBER, DummyValue.UUID] })
  async getInventoryPage(
    runId: string | null,
    afterId: string | null,
    limit: number,
    ownerId?: string,
  ): Promise<CloudBackupInventoryItem[]> {
    const { rows } = await sql<CloudBackupInventoryItem>`
      SELECT a.id, a."ownerId", a."originalFileName", ${isLocked('a')} AS locked, decision.reason
      FROM public.asset a
      LEFT JOIN public.cloud_backup_decision_asset decision
        ON decision."runId" = ${runId}::uuid AND decision."assetId" = a.id
      WHERE a.status = ANY(${WALK_STATUSES}::assets_status_enum[]) AND a."isExternal" = false
        AND (${afterId}::uuid IS NULL OR a.id > ${afterId}::uuid)
        AND (${ownerId ?? null}::uuid IS NULL OR a."ownerId" = ${ownerId ?? null}::uuid)
      ORDER BY a.id
      LIMIT ${limit}
    `.execute(this.db);
    return rows;
  }

  /** Every account on this server, for the administrator's coverage view (names resolved here, never sent). */
  @GenerateSql()
  async listAccounts(): Promise<Array<{ id: string; name: string; email: string; deletedAt: Date | null }>> {
    const rows = await this.db
      .selectFrom('user')
      .select(['id', 'name', 'email', 'deletedAt'])
      .orderBy('name')
      .orderBy('id')
      .execute();
    return rows.map((row) => ({
      ...row,
      deletedAt: row.deletedAt ? new Date(row.deletedAt as unknown as string) : null,
    }));
  }

  /* ---------------------------------------------------------------- coverage reports */

  @GenerateSql({ params: [DummyValue.UUID] })
  getCoverageReport(runId: string): Promise<CloudBackupCoverageReport | undefined> {
    return this.db.selectFrom('cloud_backup_coverage_report').selectAll().where('runId', '=', runId).executeTakeFirst();
  }

  /** The newest run's report, whatever happened to it. */
  @GenerateSql()
  getLatestCoverageReport(): Promise<CloudBackupCoverageReport | undefined> {
    return this.db
      .selectFrom('cloud_backup_coverage_report')
      .selectAll()
      .orderBy('inventoryAt', 'desc')
      .orderBy('runId', 'desc')
      .limit(1)
      .executeTakeFirst();
  }

  /** The newest report Frameleaf Cloud has published. */
  @GenerateSql()
  getLatestPublishedCoverageReport(): Promise<CloudBackupCoverageReport | undefined> {
    return this.db
      .selectFrom('cloud_backup_coverage_report')
      .selectAll()
      .where('status', '=', 'published')
      .orderBy('inventoryAt', 'desc')
      .orderBy('runId', 'desc')
      .limit(1)
      .executeTakeFirst();
  }

  /** Writes a run's report once; a report already written for the run stays as it was. */
  async createCoverageReport(report: {
    runId: string;
    instanceId: string | null;
    revisionId: string;
    sequence: number;
    inventoryAt: Date;
    accountCount: number;
    pageCount: number;
    snapshot: Record<string, unknown> | null;
    pages: string[];
    runReport: Record<string, unknown> | null;
    status: 'local' | 'pending';
  }): Promise<CloudBackupCoverageReport> {
    await this.db
      .insertInto('cloud_backup_coverage_report')
      .values(report)
      .onConflict((oc) => oc.column('runId').doNothing())
      .execute();
    return (await this.getCoverageReport(report.runId))!;
  }

  async updateCoverageReport(
    runId: string,
    patch: Partial<
      Pick<
        CloudBackupCoverageReport,
        | 'instanceId'
        | 'revisionId'
        | 'sequence'
        | 'status'
        | 'attempts'
        | 'nextAttemptAt'
        | 'lastError'
        | 'publishedAt'
        | 'revisionAccepted'
        | 'pages'
        | 'accountCount'
        | 'pageCount'
      > & { snapshot: Record<string, unknown> | null; runReport: Record<string, unknown> | null }
    >,
  ): Promise<void> {
    await this.db.updateTable('cloud_backup_coverage_report').set(patch).where('runId', '=', runId).execute();
  }

  /** Reports still to publish whose next try is due, oldest first. */
  @GenerateSql({ params: [DummyValue.DATE, DummyValue.NUMBER] })
  listDueCoverageReports(now: Date, limit: number): Promise<CloudBackupCoverageReport[]> {
    return this.db
      .selectFrom('cloud_backup_coverage_report')
      .selectAll()
      .where('status', '=', 'pending')
      .where((eb) => eb.or([eb('nextAttemptAt', 'is', null), eb('nextAttemptAt', '<=', now)]))
      .orderBy('inventoryAt')
      .limit(limit)
      .execute();
  }
}
