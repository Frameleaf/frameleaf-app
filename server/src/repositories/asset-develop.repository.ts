import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import {
  type AssetDevelopRecipe,
  AssetDevelopRevisionKind,
  AssetDevelopRevisionStatus,
} from 'src/dtos/asset-develop.dto.js';
import { canWriteFork } from 'src/repositories/fork-write-guard.js';
import { DB } from 'src/schema/index.js';

export type AssetDevelopRevision = {
  id: string;
  assetId: string;
  ownerId: string;
  revision: number;
  recipeVersion: number;
  recipe: AssetDevelopRecipe;
  label: string | null;
  status: AssetDevelopRevisionStatus;
  progress: number;
  cancelRequested: boolean;
  error: string | null;
  rendererVersion: string | null;
  masterPath: string | null;
  previewPath: string | null;
  width: number | null;
  height: number | null;
  isCurrent: boolean;
  kind: AssetDevelopRevisionKind;
  sourceChecksum: Buffer | null;
  renditionChecksum: Buffer | null;
  exportId: string | null;
  fileName: string | null;
  software: string | null;
  attempts: number;
  createdAt: Date;
  updatedAt: Date;
  renderedAt: Date | null;
};

export type AssetDevelopRevisionUpdate = Partial<
  Pick<
    AssetDevelopRevision,
    | 'status'
    | 'progress'
    | 'cancelRequested'
    | 'error'
    | 'rendererVersion'
    | 'masterPath'
    | 'previewPath'
    | 'width'
    | 'height'
    | 'renderedAt'
    | 'sourceChecksum'
    | 'renditionChecksum'
    | 'attempts'
  >
>;

const TABLE = sql`immich_fork.asset_develop_revision`;

/**
 * Storage for still-image develop revisions (FL-113). Rows are append-only history: a new
 * save always creates the next revision number, revert only moves the `isCurrent` flag, and
 * nothing here ever points at the original file.
 */
@Injectable()
export class AssetDevelopRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  async listByAsset(assetId: string): Promise<AssetDevelopRevision[]> {
    const { rows } = await sql<AssetDevelopRevision>`
      SELECT * FROM ${TABLE} WHERE "assetId" = ${assetId}::uuid ORDER BY revision DESC
    `.execute(this.db);
    return rows;
  }

  async get(id: string): Promise<AssetDevelopRevision | undefined> {
    const { rows } = await sql<AssetDevelopRevision>`SELECT * FROM ${TABLE} WHERE id = ${id}::uuid`.execute(this.db);
    return rows[0];
  }

  async getCurrent(assetId: string): Promise<AssetDevelopRevision | undefined> {
    const { rows } = await sql<AssetDevelopRevision>`
      SELECT * FROM ${TABLE} WHERE "assetId" = ${assetId}::uuid AND "isCurrent" LIMIT 1
    `.execute(this.db);
    return rows[0];
  }

  /** Inserts the next revision for the asset; the number is assigned inside the statement. */
  async create(input: {
    assetId: string;
    ownerId: string;
    recipe: AssetDevelopRecipe;
    recipeVersion: number;
    label: string | null;
    status: AssetDevelopRevisionStatus;
    kind?: AssetDevelopRevisionKind;
    sourceChecksum?: Buffer | null;
    renditionChecksum?: Buffer | null;
    exportId?: string | null;
    fileName?: string | null;
    software?: string | null;
    masterPath?: string | null;
  }): Promise<AssetDevelopRevision> {
    // Serialised per asset: two saves racing for the same next number would otherwise collide on
    // the (assetId, revision) unique key and one of them would fail.
    return this.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`asset_develop_revision:${input.assetId}`}, 0))`.execute(
        trx,
      );
      const { rows } = await sql<AssetDevelopRevision>`
        INSERT INTO ${TABLE} (
          "assetId", "ownerId", revision, "recipeVersion", recipe, label, status,
          kind, "sourceChecksum", "renditionChecksum", "exportId", "fileName", software, "masterPath"
        )
        VALUES (
          ${input.assetId}::uuid,
          ${input.ownerId}::uuid,
          (SELECT COALESCE(MAX(revision), 0) + 1 FROM ${TABLE} WHERE "assetId" = ${input.assetId}::uuid),
          ${input.recipeVersion},
          ${JSON.stringify(input.recipe)}::text::jsonb,
          ${input.label},
          ${input.status},
          ${input.kind ?? AssetDevelopRevisionKind.Recipe},
          ${input.sourceChecksum ?? null},
          ${input.renditionChecksum ?? null},
          ${input.exportId ?? null}::uuid,
          ${input.fileName ?? null},
          ${input.software ?? null},
          ${input.masterPath ?? null}
        )
        RETURNING *
      `.execute(trx);
      return rows[0];
    });
  }

  /** Revisions whose render the queue may have lost (a restart, a flushed queue): queued or rendering. */
  async listUnfinished(): Promise<Pick<AssetDevelopRevision, 'id' | 'status' | 'updatedAt'>[]> {
    const { rows } = await sql<Pick<AssetDevelopRevision, 'id' | 'status' | 'updatedAt'>>`
      SELECT id, status, "updatedAt" FROM ${TABLE}
      WHERE status IN (${AssetDevelopRevisionStatus.Queued}, ${AssetDevelopRevisionStatus.Rendering})
      ORDER BY "updatedAt"
    `.execute(this.db);
    return rows;
  }

  /**
   * Records the start of a render attempt and returns the attempt number, or undefined when the
   * revision is gone, finished, cancelled meanwhile, or held by a render whose lease has not
   * lapsed. One guarded statement, so two deliveries of the same job can never both claim it.
   */
  async beginAttempt(
    id: string,
    rendererVersion: string,
    leaseSeconds: number,
  ): Promise<AssetDevelopRevision | undefined> {
    const { rows } = await sql<AssetDevelopRevision>`
      UPDATE ${TABLE}
      SET status = ${AssetDevelopRevisionStatus.Rendering}, progress = 5, error = NULL,
          attempts = attempts + 1, "rendererVersion" = ${rendererVersion}, "updatedAt" = now()
      WHERE id = ${id}::uuid
        AND NOT "cancelRequested"
        AND (
          status = ${AssetDevelopRevisionStatus.Queued}
          OR (
            status = ${AssetDevelopRevisionStatus.Rendering}
            AND "updatedAt" < now() - make_interval(secs => ${leaseSeconds})
          )
        )
      RETURNING *
    `.execute(this.db);
    return rows[0];
  }

  async update(id: string, patch: AssetDevelopRevisionUpdate): Promise<AssetDevelopRevision | undefined> {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
    if (entries.length === 0) {
      return this.get(id);
    }
    const assignments = entries.map(([key, value]) => sql`${sql.ref(key)} = ${value}`);
    const { rows } = await sql<AssetDevelopRevision>`
      UPDATE ${TABLE}
      SET ${sql.join(assignments, sql`, `)}, "updatedAt" = now()
      WHERE id = ${id}::uuid
      RETURNING *
    `.execute(this.db);
    return rows[0];
  }

  /**
   * Moves the asset's current flag to the given revision, or clears it entirely for the
   * original. One statement pair inside a transaction so the partial unique index never
   * sees two current rows.
   */
  async setCurrent(assetId: string, revisionId: string | null): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await sql`
        UPDATE ${TABLE} SET "isCurrent" = false, "updatedAt" = now()
        WHERE "assetId" = ${assetId}::uuid AND "isCurrent"
      `.execute(trx);
      if (revisionId) {
        await sql`
          UPDATE ${TABLE} SET "isCurrent" = true, "updatedAt" = now()
          WHERE id = ${revisionId}::uuid AND "assetId" = ${assetId}::uuid
        `.execute(trx);
      }
    });
  }

  /** Marks a revision as wanting to stop; the renderer checks the flag between stages. */
  async requestCancel(id: string): Promise<void> {
    await sql`UPDATE ${TABLE} SET "cancelRequested" = true, "updatedAt" = now() WHERE id = ${id}::uuid`.execute(
      this.db,
    );
  }

  async isCancelRequested(id: string): Promise<boolean> {
    const { rows } = await sql<{ cancelRequested: boolean }>`
      SELECT "cancelRequested" FROM ${TABLE} WHERE id = ${id}::uuid
    `.execute(this.db);
    return rows[0]?.cancelRequested;
  }

  /** Every rendered file path for an asset, used when the asset itself is deleted. */
  /**
   * Deletes the revisions of assets that no longer exist (of `assetId` only, when given) and returns
   * their rendered files for deletion. The revisions have no foreign key to the asset. FL-179: nothing
   * is deleted while fork writes are refused (a disabled phase, or a handoff or return reconciliation
   * running), as the asset's removal does; the nightly sweep releases those revisions later.
   */
  async releaseRemovedAssetRevisions(assetId?: string): Promise<string[]> {
    return this.db.transaction().execute(async (tx) => {
      if (!(await canWriteFork(tx))) {
        return [];
      }
      const { rows } = await sql<{ masterPath: string | null; previewPath: string | null }>`
        DELETE FROM ${TABLE} revision
        WHERE NOT EXISTS (SELECT 1 FROM public.asset asset WHERE asset.id = revision."assetId")
        ${assetId ? sql`AND revision."assetId" = ${assetId}::uuid` : sql``}
        RETURNING revision."masterPath", revision."previewPath"
      `.execute(tx);
      return rows.flatMap((row) => [row.masterPath, row.previewPath]).filter((path): path is string => !!path);
    });
  }
}
