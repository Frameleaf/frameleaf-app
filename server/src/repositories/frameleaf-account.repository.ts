import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { FrameleafAccess } from 'src/utils/frameleaf-sign-in.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { DB } from 'src/schema/index.js';

export type FrameleafAccountLinkRow = {
  userId: string;
  sub: string;
  email: string;
  emailVerified: boolean;
  role: 'admin' | 'user' | null;
  autoRegistered: boolean;
  linkedAt: Date;
  lastSignInAt: Date | null;
  /** FL-235: the `frameleaf_access` the cloud last gave this account on this server (fork migration 0211). */
  access: FrameleafAccess | null;
};
export type FrameleafSessionRow = {
  sessionId: string;
  userId: string;
  sid: string | null;
  sub: string;
  authTime: Date | null;
  createdAt: Date;
  handoffCodeHash: string | null;
  handoffExpiresAt: Date | null;
};
/**
 * Sign in with Frameleaf (FL-158): the Frameleaf account linked to each local account
 * (`public.frameleaf_account_link`) and the sessions a Frameleaf sign-in created
 * (`public.frameleaf_session`), the exchange tokens already used and the sign-ins Frameleaf
 * Cloud ended (FL-230), and the access the cloud gives each account on this server (FL-235).
 */
/**
 * FL-230: whether Frameleaf Cloud ended this account's (`sub`) or Frameleaf session's (`sid`)
 * sign-ins at or after `issuedAt`, with an unexpired record. The one query behind both the redemption
 * of an exchange token and the check after its session is tagged.
 */
const signInRevoked = async (
  db: Kysely<DB>,
  token: {
    sub: string;
    sid: string | null;
    issuedAt: Date;
  },
): Promise<boolean> => {
  const revoked = await sql<{
    kind: string;
  }>`
    SELECT kind FROM public.frameleaf_sign_in_revocation
    WHERE "expiresAt" >= clock_timestamp()
      AND "revokedAt" >= ${token.issuedAt}
      AND ((kind = 'sub' AND value = ${token.sub})
        OR (${token.sid}::text IS NOT NULL AND kind = 'sid' AND value = ${token.sid}))
    LIMIT 1
  `.execute(db);
  return revoked.rows.length > 0;
};
@Injectable()
export class FrameleafAccountRepository {
  constructor(
    @InjectKysely()
    private db: Kysely<DB>,
  ) {}
  /** Run each account write in a database transaction. */
  private write<T>(work: (trx: Kysely<DB>) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      return work(trx);
    });
  }
  // ------------------------------------------------------------------ account links
  @GenerateSql({ params: [DummyValue.UUID] })
  async getLinkByUser(userId: string): Promise<FrameleafAccountLinkRow | undefined> {
    const result = await sql<FrameleafAccountLinkRow>`
      SELECT * FROM public.frameleaf_account_link WHERE "userId" = ${userId}::uuid
    `.execute(this.db);
    return result.rows[0];
  }
  @GenerateSql({ params: [DummyValue.STRING] })
  async getLinkBySub(sub: string): Promise<FrameleafAccountLinkRow | undefined> {
    const result = await sql<FrameleafAccountLinkRow>`
      SELECT * FROM public.frameleaf_account_link WHERE sub = ${sub}
    `.execute(this.db);
    return result.rows[0];
  }
  @GenerateSql()
  async countLinks(): Promise<number> {
    const result = await sql<{
      count: string;
    }>`
      SELECT count(*)::text AS count FROM public.frameleaf_account_link
    `.execute(this.db);
    return Number(result.rows[0]?.count ?? 0);
  }
  /** Link a Frameleaf account to a local account (replacing its previous link). */
  async upsertLink(
    row: Pick<FrameleafAccountLinkRow, 'userId' | 'sub' | 'email' | 'emailVerified' | 'role' | 'autoRegistered'> & {
      access?: FrameleafAccess | null;
    },
  ): Promise<FrameleafAccountLinkRow> {
    return this.db.transaction().execute(async (trx) => {
      const result = await sql<FrameleafAccountLinkRow>`
        INSERT INTO public.frameleaf_account_link ("userId", sub, email, "emailVerified", role, "autoRegistered", access)
        VALUES (${row.userId}::uuid, ${row.sub}, ${row.email}, ${row.emailVerified}, ${row.role}, ${row.autoRegistered}, ${row.access ?? null})
        ON CONFLICT ("userId") DO UPDATE SET
          sub = excluded.sub,
          email = excluded.email,
          "emailVerified" = excluded."emailVerified",
          role = excluded.role,
          "autoRegistered" = excluded."autoRegistered",
          access = excluded.access,
          "linkedAt" = CASE
            WHEN public.frameleaf_account_link.sub = excluded.sub THEN public.frameleaf_account_link."linkedAt"
            ELSE clock_timestamp()
          END
        RETURNING *
      `.execute(trx);
      return result.rows[0];
    });
  }
  /** Record a sign-in: the latest email, verification, role and access the cloud reported. */
  async touchLink(
    userId: string,
    update: {
      email: string;
      emailVerified: boolean;
      role: 'admin' | 'user' | null;
      access?: FrameleafAccess | null;
    },
  ) {
    return this.write(async (trx) => {
      await sql`
        UPDATE public.frameleaf_account_link
        SET email = ${update.email}, "emailVerified" = ${update.emailVerified}, role = ${update.role},
            access = COALESCE(${update.access ?? null}, access), "lastSignInAt" = clock_timestamp()
        WHERE "userId" = ${userId}::uuid
      `.execute(trx);
    });
  }
  async deleteLink(userId: string): Promise<FrameleafAccountLinkRow | undefined> {
    return this.db.transaction().execute(async (trx) => {
      const result = await sql<FrameleafAccountLinkRow>`
        DELETE FROM public.frameleaf_account_link WHERE "userId" = ${userId}::uuid RETURNING *
      `.execute(trx);
      return result.rows[0];
    });
  }
  /** Every link, for an unlink or revoke of the whole server. Returns the people unlinked. */
  async deleteAllLinks(): Promise<FrameleafAccountLinkRow[]> {
    return this.write(async (trx) => {
      const result = await sql<FrameleafAccountLinkRow>`
        DELETE FROM public.frameleaf_account_link RETURNING *
      `.execute(trx);
      return result.rows;
    });
  }
  // ------------------------------------------------------------------ sessions
  async tagSession(row: { sessionId: string; userId: string; sid: string | null; sub: string; authTime: Date | null }) {
    return this.write(async (trx) => {
      await sql`
        INSERT INTO public.frameleaf_session ("sessionId", "userId", sid, sub, "authTime")
        VALUES (${row.sessionId}::uuid, ${row.userId}::uuid, ${row.sid}, ${row.sub}, ${row.authTime})
        ON CONFLICT ("sessionId") DO UPDATE SET sid = excluded.sid, sub = excluded.sub, "authTime" = excluded."authTime"
      `.execute(trx);
    });
  }
  @GenerateSql({ params: [DummyValue.UUID] })
  async getSession(sessionId: string): Promise<FrameleafSessionRow | undefined> {
    const result = await sql<FrameleafSessionRow>`
      SELECT * FROM public.frameleaf_session WHERE "sessionId" = ${sessionId}::uuid
    `.execute(this.db);
    return result.rows[0];
  }
  /** The sessions a back-channel logout names, by Frameleaf session id or account. */
  @GenerateSql({ params: [DummyValue.STRING, DummyValue.STRING] })
  async findSessions(filter: { sid?: string; sub?: string }): Promise<FrameleafSessionRow[]> {
    if (!filter.sid && !filter.sub) {
      return [];
    }
    const result = await sql<FrameleafSessionRow>`
      SELECT * FROM public.frameleaf_session
      WHERE (${filter.sid ?? null}::text IS NOT NULL AND sid = ${filter.sid ?? null})
         OR (${filter.sub ?? null}::text IS NOT NULL AND sub = ${filter.sub ?? null})
    `.execute(this.db);
    return result.rows;
  }
  async deleteSessions(sessionIds: string[]) {
    return this.write(async (trx) => {
      if (sessionIds.length === 0) {
        return;
      }
      await sql`
        DELETE FROM public.frameleaf_session WHERE "sessionId" = ANY(${sessionIds}::uuid[])
      `.execute(trx);
    });
  }
  /** Every tagged session, for an unlink or revoke of the whole server. */
  async deleteAllSessions(): Promise<string[]> {
    return this.write(async (trx) => {
      const result = await sql<{
        sessionId: string;
      }>`
        DELETE FROM public.frameleaf_session RETURNING "sessionId"
      `.execute(trx);
      return result.rows.map(({ sessionId }) => sessionId);
    });
  }
  /** Put a single-use handoff code (its hash) on a tagged session. */
  async setHandoff(sessionId: string, codeHash: string, expiresAt: Date) {
    return this.write(async (trx) => {
      await sql`
        UPDATE public.frameleaf_session
        SET "handoffCodeHash" = ${codeHash}, "handoffExpiresAt" = ${expiresAt}
        WHERE "sessionId" = ${sessionId}::uuid
      `.execute(trx);
    });
  }
  /** Take a handoff code once: returns its session and clears it, whether or not it expired. */
  async takeHandoff(codeHash: string): Promise<FrameleafSessionRow | undefined> {
    return this.write(async (trx) => {
      const result = await sql<FrameleafSessionRow>`
        UPDATE public.frameleaf_session AS s
        SET "handoffCodeHash" = NULL, "handoffExpiresAt" = NULL
        FROM (SELECT * FROM public.frameleaf_session WHERE "handoffCodeHash" = ${codeHash} FOR UPDATE) AS old
        WHERE s."sessionId" = old."sessionId"
        RETURNING old.*
      `.execute(trx);
      return result.rows[0];
    });
  }
  // ------------------------------------------------------------------ token exchange (FL-230)
  /**
   * Take an exchange token once. `revoked` when Frameleaf Cloud ended this account's or Frameleaf
   * session's sign-ins at or after the token was minted (`issuedAt`), `replayed` when its `jti` was
   * presented before, else it is recorded until `expiresAt` and `ok`. One transaction, so two copies
   * presented at once never both pass.
   */
  async redeemExchangeToken(token: {
    jti: string;
    sub: string;
    sid: string | null;
    issuedAt: Date;
    expiresAt: Date;
  }): Promise<'ok' | 'replayed' | 'revoked'> {
    return this.write(async (trx) => {
      await sql`DELETE FROM public.frameleaf_exchange_token WHERE "expiresAt" < clock_timestamp()`.execute(trx);
      if (await signInRevoked(trx, token)) {
        return 'revoked';
      }
      const inserted = await sql<{
        jti: string;
      }>`
        INSERT INTO public.frameleaf_exchange_token (jti, sub, "expiresAt")
        VALUES (${token.jti}, ${token.sub}, ${token.expiresAt})
        ON CONFLICT (jti) DO NOTHING
        RETURNING jti
      `.execute(trx);
      return inserted.rows.length > 0 ? 'ok' : 'replayed';
    });
  }
  /**
   * Whether Frameleaf Cloud ended this account's (`sub`) or Frameleaf session's (`sid`) sign-ins at or
   * after `issuedAt`: checked again once an exchanged session is tagged, so a back-channel logout that
   * raced the sign-in still ends it.
   */
  async isSignInRevoked(token: { sub: string; sid: string | null; issuedAt: Date }): Promise<boolean> {
    return signInRevoked(this.db, token);
  }
  /**
   * Frameleaf Cloud ended the sign-ins of an account (`sub`) or a Frameleaf session (`sid`): exchange
   * tokens minted until now are refused until `expiresAt`.
   */
  async revokeSignIns(
    filter: {
      sid?: string;
      sub?: string;
    },
    expiresAt: Date,
  ) {
    const entries = [
      ...(filter.sub ? [['sub', filter.sub]] : []),
      ...(filter.sid ? [['sid', filter.sid]] : []),
    ] as const;
    if (entries.length === 0) {
      return;
    }
    return this.write(async (trx) => {
      await sql`
        DELETE FROM public.frameleaf_sign_in_revocation WHERE "expiresAt" < clock_timestamp()
      `.execute(trx);
      for (const [kind, value] of entries) {
        await sql`
          INSERT INTO public.frameleaf_sign_in_revocation (kind, value, "expiresAt")
          VALUES (${kind}, ${value}, ${expiresAt})
          ON CONFLICT (kind, value) DO UPDATE SET
            "revokedAt" = clock_timestamp(),
            "expiresAt" = GREATEST(public.frameleaf_sign_in_revocation."expiresAt", excluded."expiresAt")
        `.execute(trx);
      }
    });
  }
}
