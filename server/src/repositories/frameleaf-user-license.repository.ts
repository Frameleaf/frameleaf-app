import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { lockForkWrites } from 'src/repositories/fork-write-guard.js';
import { DB } from 'src/schema/index.js';

export type FrameleafUserLicenseRow = {
  userId: string;
  kind: 'individual';
  keyHint: string;
  keySha256: string;
  binding: string;
  certificate: string;
  activationId: string | null;
  activatedAt: Date;
};

/**
 * Personal Frameleaf supporter keys (FL-156) in `immich_fork.frameleaf_user_license` (fork migration
 * 0000000000204): one row per account, and one active activation of a key on this server. The key
 * itself is never stored; only its hash, its last four symbols and the verified certificate.
 */
@Injectable()
export class FrameleafUserLicenseRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  @GenerateSql({ params: [DummyValue.UUID] })
  async get(userId: string): Promise<FrameleafUserLicenseRow | undefined> {
    const result = await sql<FrameleafUserLicenseRow>`
      SELECT * FROM immich_fork.frameleaf_user_license WHERE "userId" = ${userId}::uuid
    `.execute(this.db);
    return result.rows[0];
  }

  /** The account a key is active for on this server, if any. */
  @GenerateSql({ params: [DummyValue.STRING] })
  async getByKeyHash(keySha256: string): Promise<FrameleafUserLicenseRow | undefined> {
    const result = await sql<FrameleafUserLicenseRow>`
      SELECT * FROM immich_fork.frameleaf_user_license WHERE "keySha256" = ${keySha256}
    `.execute(this.db);
    return result.rows[0];
  }

  /** Record (or replace) an account's key. Refused while the server is being handed over. */
  async upsert(row: Omit<FrameleafUserLicenseRow, 'kind' | 'activatedAt'>): Promise<FrameleafUserLicenseRow> {
    return this.db.transaction().execute(async (trx) => {
      await lockForkWrites(trx, 'The licence cannot be saved while the server is being handed over');
      const result = await sql<FrameleafUserLicenseRow>`
        INSERT INTO immich_fork.frameleaf_user_license
          ("userId", "keyHint", "keySha256", binding, certificate, "activationId")
        VALUES (
          ${row.userId}::uuid, ${row.keyHint}, ${row.keySha256}, ${row.binding}, ${row.certificate}, ${row.activationId}
        )
        ON CONFLICT ("userId") DO UPDATE SET
          "keyHint" = excluded."keyHint",
          "keySha256" = excluded."keySha256",
          binding = excluded.binding,
          certificate = excluded.certificate,
          "activationId" = excluded."activationId",
          "activatedAt" = clock_timestamp()
        RETURNING *
      `.execute(trx);
      return result.rows[0];
    });
  }

  async delete(userId: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await lockForkWrites(trx, 'The licence cannot be removed while the server is being handed over');
      await sql`DELETE FROM immich_fork.frameleaf_user_license WHERE "userId" = ${userId}::uuid`.execute(trx);
    });
  }
}
