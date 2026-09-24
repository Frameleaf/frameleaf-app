import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { createHash } from 'node:crypto';
import type { ForkSchemaPhase } from 'src/repositories/fork-schema.repository.js';
import { isForkAuthoritative, isForkWriteEnabled } from 'src/fork-schema/authority.js';
import { DB } from 'src/schema/index.js';

export type PrivacySidecar = {
  assetId: string;
  isNsfw: boolean;
  suppression: Record<string, unknown> | null;
};

export type BatchResult = { count: number; digest: string };

export const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
};

export const digestRows = (rows: PrivacySidecar[]) =>
  createHash('sha256')
    .update(JSON.stringify(canonicalize(rows)))
    .digest('hex');

@Injectable()
export class ForkPrivacyRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  async backfillPrivacy(ids: string[]): Promise<BatchResult> {
    return this.db.transaction().execute((trx) => this.backfill(ids, trx));
  }

  async mirrorFromLegacy(assetId: string, kysely: Kysely<DB> = this.db): Promise<void> {
    await this.mirrorManyFromLegacy([assetId], kysely);
  }

  async mirrorManyFromLegacy(assetIds: string[], kysely: Kysely<DB> = this.db): Promise<void> {
    if (assetIds.length === 0) {
      return;
    }
    const phase = await this.getPhase(kysely);
    if (!isForkWriteEnabled(phase)) {
      return;
    }
    await this.backfill(assetIds, kysely);
  }

  async get(assetId: string, kysely: Kysely<DB> = this.db): Promise<PrivacySidecar | undefined> {
    const result = await sql<PrivacySidecar>`
      SELECT "assetId", "isNsfw", suppression
      FROM immich_fork.asset_privacy
      WHERE "assetId" = ${assetId}::uuid
    `.execute(kysely);
    return result.rows[0];
  }

  /**
   * Writes the privacy projection for one asset's classification (FL-34). Called with the enrichment
   * writer's transaction and per-asset metadata lock, so the projection every read filters on commits
   * with the review that produced it. A missing row is only created by an explicit owner mark or safe
   * decision; any other write to an asset without a row fails closed.
   */
  async saveClassification(
    assetId: string,
    isNsfw: boolean | undefined,
    suppression: Record<string, unknown> | null,
    kysely: Kysely<DB>,
  ): Promise<void> {
    const isManualMark = suppression?.action === 'marked-nsfw' || suppression?.action === 'marked-safe';
    const result = await sql`
      INSERT INTO immich_fork.asset_privacy ("assetId", "isNsfw", suppression)
      SELECT ${assetId}::uuid, ${isNsfw ?? true}, ${suppression}::jsonb
      WHERE ${isManualMark && isNsfw !== undefined} OR EXISTS (
        SELECT 1 FROM immich_fork.asset_privacy WHERE "assetId" = ${assetId}::uuid
      )
      ON CONFLICT ("assetId") DO UPDATE
      SET "isNsfw" = COALESCE(${isNsfw ?? null}::boolean, asset_privacy."isNsfw"),
        suppression = EXCLUDED.suppression, "updatedAt" = now()
      RETURNING "assetId"
    `.execute(kysely);
    if (result.rows.length === 0) {
      throw new Error(`Missing fork privacy sidecar for asset ${assetId}`);
    }
  }

  async delete(assetIds: string[], kysely: Kysely<DB> = this.db): Promise<void> {
    if (assetIds.length > 0 && isForkWriteEnabled(await this.getPhase(kysely))) {
      await sql`DELETE FROM immich_fork.asset_privacy WHERE "assetId" = ANY(${assetIds}::uuid[])`.execute(kysely);
    }
  }

  async shouldReadSidecar(kysely: Kysely<DB> = this.db): Promise<boolean> {
    const phase = await this.getPhase(kysely);
    return isForkAuthoritative(phase);
  }

  private async backfill(ids: string[], kysely: Kysely<DB>): Promise<BatchResult> {
    if (ids.length === 0) {
      return { count: 0, digest: digestRows([]) };
    }

    const legacy = await sql<PrivacySidecar>`
      SELECT
        asset.id::text AS "assetId",
        asset.is_nsfw AS "isNsfw",
        metadata.value -> 'nsfwDetection' -> 'review' AS suppression
      FROM asset
      LEFT JOIN asset_metadata AS metadata
        ON metadata."assetId" = asset.id
       AND metadata.key = 'ml-enrichment'
      WHERE asset.id = ANY(${ids}::uuid[])
      ORDER BY asset.id::text
    `.execute(kysely);

    await sql`
      DELETE FROM immich_fork.asset_privacy
      WHERE "assetId" = ANY(${ids}::uuid[])
        AND NOT ("assetId" = ANY(${legacy.rows.map(({ assetId }) => assetId)}::uuid[]))
    `.execute(kysely);

    for (const row of legacy.rows) {
      await sql`
        INSERT INTO immich_fork.asset_privacy ("assetId", "isNsfw", suppression)
        VALUES (${row.assetId}::uuid, ${row.isNsfw}, ${row.suppression}::jsonb)
        ON CONFLICT ("assetId") DO UPDATE
        SET
          "isNsfw" = EXCLUDED."isNsfw",
          suppression = EXCLUDED.suppression,
          "updatedAt" = now()
      `.execute(kysely);
    }

    const canonical = await this.getMany(ids, kysely);
    return { count: ids.length, digest: digestRows(canonical) };
  }

  private async getMany(ids: string[], kysely: Kysely<DB>): Promise<PrivacySidecar[]> {
    const result = await sql<PrivacySidecar>`
      SELECT "assetId"::text AS "assetId", "isNsfw", suppression
      FROM immich_fork.asset_privacy
      WHERE "assetId" = ANY(${ids}::uuid[])
      ORDER BY "assetId"::text
    `.execute(kysely);
    return result.rows;
  }

  private async getPhase(kysely: Kysely<DB>): Promise<ForkSchemaPhase> {
    const schema = await sql<{ stateTable: string | null }>`
      SELECT to_regclass('immich_fork.state')::text AS "stateTable"
    `.execute(kysely);
    if (!schema.rows[0]?.stateTable) {
      return 'legacy';
    }
    const result = await sql<{ phase: ForkSchemaPhase }>`SELECT phase FROM immich_fork.state WHERE id = 1`.execute(
      kysely,
    );
    return result.rows[0]?.phase ?? 'inactive';
  }
}
