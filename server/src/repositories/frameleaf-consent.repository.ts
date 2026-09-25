import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { CloudConsentFeatures } from 'src/utils/frameleaf-cloud.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { canWriteFork } from 'src/repositories/fork-write-guard.js';
import { DB } from 'src/schema/index.js';

export type FrameleafConsentRow = {
  id: string;
  destinationId: string;
  version: string;
  features: CloudConsentFeatures;
  acceptedBy: string;
  acceptedAt: Date;
  cloudRecordedVersion: string | null;
  revokedAt: Date | null;
};

/**
 * Versioned Frameleaf Cloud consent (FL-159), in `immich_fork.frameleaf_consent` (fork migration
 * 0000000000200). Rows are appended and revoked, never rewritten, so what an administrator agreed
 * to, and when, stays readable.
 */
@Injectable()
export class FrameleafConsentRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /** Record a consent. Refused while the fork schema is not writable (a handoff is in progress). */
  async record(entry: {
    destinationId: string;
    version: string;
    features: CloudConsentFeatures;
    acceptedBy: string;
    cloudRecordedVersion: string | null;
  }): Promise<FrameleafConsentRow> {
    return this.db.transaction().execute(async (trx) => {
      if (!(await canWriteFork(trx))) {
        throw new Error('Consent cannot be recorded while the server is being handed over');
      }
      const result = await sql<FrameleafConsentRow>`
        INSERT INTO immich_fork.frameleaf_consent ("destinationId", version, features, "acceptedBy", "cloudRecordedVersion")
        VALUES (
          ${entry.destinationId}::uuid,
          ${entry.version},
          ${JSON.stringify(entry.features)}::text::jsonb,
          ${entry.acceptedBy}::uuid,
          ${entry.cloudRecordedVersion}
        )
        RETURNING *
      `.execute(trx);
      return result.rows[0];
    });
  }

  /** The consent in force for a destination: the newest one not revoked. */
  @GenerateSql({ params: [DummyValue.UUID] })
  async getCurrent(destinationId: string): Promise<FrameleafConsentRow | undefined> {
    const result = await sql<FrameleafConsentRow>`
      SELECT * FROM immich_fork.frameleaf_consent
      WHERE "destinationId" = ${destinationId}::uuid AND "revokedAt" IS NULL
      ORDER BY "acceptedAt" DESC, id DESC
      LIMIT 1
    `.execute(this.db);
    return result.rows[0];
  }

  /** Every consent recorded for a destination, newest first. */
  @GenerateSql({ params: [DummyValue.UUID] })
  async getHistory(destinationId: string): Promise<FrameleafConsentRow[]> {
    const result = await sql<FrameleafConsentRow>`
      SELECT * FROM immich_fork.frameleaf_consent
      WHERE "destinationId" = ${destinationId}::uuid
      ORDER BY "acceptedAt" DESC, id DESC
      LIMIT 50
    `.execute(this.db);
    return result.rows;
  }

  /** Revoke every consent in force for a destination. Refused, like `record`, during a handoff. */
  async revoke(destinationId: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      if (!(await canWriteFork(trx))) {
        throw new Error('Consent cannot be withdrawn while the server is being handed over');
      }
      await sql`
        UPDATE immich_fork.frameleaf_consent SET "revokedAt" = clock_timestamp()
        WHERE "destinationId" = ${destinationId}::uuid AND "revokedAt" IS NULL
      `.execute(trx);
    });
  }
}
