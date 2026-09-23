import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { type AssetDevelopRecipe, AssetDevelopRevisionStatus } from 'src/dtos/asset-develop.dto.js';
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
  }): Promise<AssetDevelopRevision> {
    const { rows } = await sql<AssetDevelopRevision>`
      INSERT INTO ${TABLE} ("assetId", "ownerId", revision, "recipeVersion", recipe, label, status)
      VALUES (
        ${input.assetId}::uuid,
        ${input.ownerId}::uuid,
        (SELECT COALESCE(MAX(revision), 0) + 1 FROM ${TABLE} WHERE "assetId" = ${input.assetId}::uuid),
        ${input.recipeVersion},
        ${JSON.stringify(input.recipe)}::jsonb,
        ${input.label},
        ${input.status}
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
  async getFilePaths(assetId: string): Promise<string[]> {
    const { rows } = await sql<{ masterPath: string | null; previewPath: string | null }>`
      SELECT "masterPath", "previewPath" FROM ${TABLE} WHERE "assetId" = ${assetId}::uuid
    `.execute(this.db);
    return rows.flatMap((row) => [row.masterPath, row.previewPath]).filter((path): path is string => !!path);
  }

  async deleteByAsset(assetId: string): Promise<void> {
    await sql`DELETE FROM ${TABLE} WHERE "assetId" = ${assetId}::uuid`.execute(this.db);
  }
}
