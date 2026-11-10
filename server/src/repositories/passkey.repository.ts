import { Injectable } from '@nestjs/common';
import { type Insertable, type Kysely } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { DB } from 'src/schema/index.js';
import { AuthChallengeTable, UserPasskeyTable } from 'src/schema/tables/user-passkey.table.js';

/** FL-836: what a passkey ceremony or a password check is for (`auth_challenge.purpose`). */
export type AuthChallengePurpose = 'register' | 'login' | 'password-proof';

const passkeyColumns = [
  'id',
  'userId',
  'credentialId',
  'publicKey',
  'counter',
  'transports',
  'name',
  'rpId',
  'aaguid',
  'backedUp',
  'createdAt',
  'lastUsedAt',
] as const;

/** A passkey removed, and the sessions it had started (now signed out). */
export type RemovedPasskeys = { count: number; sessionIds: string[] };

/**
 * FL-836: passkeys of local accounts, their ceremony challenges and password checks, and the
 * sessions they started. Challenges are taken (deleted) when used, so each answers once.
 */
@Injectable()
export class PasskeyRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  @GenerateSql({ params: [DummyValue.UUID] })
  getByUser(userId: string) {
    return this.db
      .selectFrom('user_passkey')
      .select(passkeyColumns)
      .where('userId', '=', userId)
      .orderBy('createdAt', 'asc')
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async countByUser(userId: string): Promise<number> {
    const { count } = await this.db
      .selectFrom('user_passkey')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('userId', '=', userId)
      .executeTakeFirstOrThrow();
    return Number(count);
  }

  @GenerateSql({ params: [DummyValue.BUFFER] })
  getByCredentialId(credentialId: Buffer) {
    return this.db
      .selectFrom('user_passkey')
      .select(passkeyColumns)
      .where('credentialId', '=', credentialId)
      .executeTakeFirst();
  }

  /** Undefined when this credential is already saved (for any account). */
  async create(passkey: Insertable<UserPasskeyTable>) {
    return this.db
      .insertInto('user_passkey')
      .values(passkey)
      .onConflict((oc) => oc.column('credentialId').doNothing())
      .returning(passkeyColumns)
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID, DummyValue.STRING] })
  rename(userId: string, id: string, name: string) {
    return this.db
      .updateTable('user_passkey')
      .set({ name })
      .where('id', '=', id)
      .where('userId', '=', userId)
      .returning(passkeyColumns)
      .executeTakeFirst();
  }

  /**
   * A sign-in with the passkey: the new signature count (`counter` is a bigint, which the database
   * driver reads back as a number), conditional on the one just checked, so two
   * sign-ins racing with one assertion cannot both pass.
   */
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.NUMBER, DummyValue.NUMBER, DummyValue.BOOLEAN] })
  async recordUse(id: string, counter: number, newCounter: number, backedUp: boolean): Promise<boolean> {
    const row = await this.db
      .updateTable('user_passkey')
      .set({ counter: String(newCounter), backedUp, lastUsedAt: new Date() })
      .where('id', '=', id)
      .where('counter', '=', String(counter))
      .returning('id')
      .executeTakeFirst();
    return !!row;
  }

  /**
   * One passkey of the account, and the sessions it started other than `keepSessionId` (the one
   * removing it); nothing when it isn't theirs.
   */
  async delete(
    userId: string,
    id: string,
    keepSessionId?: string,
  ): Promise<(RemovedPasskeys & { name: string }) | undefined> {
    return this.db.transaction().execute(async (trx) => {
      const owned = await trx
        .selectFrom('user_passkey')
        .select('id')
        .where('id', '=', id)
        .where('userId', '=', userId)
        .forUpdate()
        .executeTakeFirst();
      if (!owned) {
        return;
      }
      // before the passkey goes: its link to the sessions it started goes with it
      const sessionIds = await deleteSessions(trx, userId, [id], keepSessionId);
      const row = await trx.deleteFrom('user_passkey').where('id', '=', id).returning('name').executeTakeFirstOrThrow();
      return { name: row.name, count: 1, sessionIds };
    });
  }

  /** Every passkey of the account (an administrator's reset), and the sessions they started. */
  async deleteAll(userId: string): Promise<RemovedPasskeys> {
    return this.db.transaction().execute(async (trx) => {
      const ids = (await trx.selectFrom('user_passkey').select('id').where('userId', '=', userId).execute()).map(
        ({ id }) => id,
      );
      const sessionIds = await deleteSessions(trx, userId, ids);
      await trx.deleteFrom('user_passkey').where('userId', '=', userId).execute();
      return { count: ids.length, sessionIds };
    });
  }

  async linkSession(sessionId: string, passkeyId: string): Promise<void> {
    await this.db.insertInto('session_passkey').values({ sessionId, passkeyId }).execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async isPasskeySession(sessionId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('session_passkey')
      .select('sessionId')
      .where('sessionId', '=', sessionId)
      .executeTakeFirst();
    return !!row;
  }

  /** Stores a challenge (or a password check), dropping every expired one first. */
  async createChallenge(challenge: Insertable<AuthChallengeTable> & { purpose: AuthChallengePurpose }): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('auth_challenge').where('expiresAt', '<', new Date()).execute();
      await trx.insertInto('auth_challenge').values(challenge).execute();
    });
  }

  /** Takes an unexpired challenge: it is deleted, so it answers only once. */
  @GenerateSql({ params: ['login', DummyValue.STRING] })
  takeChallenge(purpose: AuthChallengePurpose, challenge: string) {
    return this.db
      .deleteFrom('auth_challenge')
      .where('purpose', '=', purpose)
      .where('challenge', '=', challenge)
      .where('expiresAt', '>', new Date())
      .returning(['userId', 'sessionId', 'origin', 'rpId'])
      .executeTakeFirst();
  }

  /** Whether the session's password was checked recently enough (an unexpired `password-proof`). */
  @GenerateSql({ params: [DummyValue.UUID] })
  async hasPasswordProof(sessionId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('auth_challenge')
      .select('id')
      .where('purpose', '=', 'password-proof')
      .where('sessionId', '=', sessionId)
      .where('expiresAt', '>', new Date())
      .executeTakeFirst();
    return !!row;
  }
}

/** Signs out the account's sessions that these passkeys started. */
const deleteSessions = async (
  trx: Kysely<DB>,
  userId: string,
  passkeyIds: string[],
  keepSessionId?: string,
): Promise<string[]> => {
  if (passkeyIds.length === 0) {
    return [];
  }
  const rows = await trx
    .deleteFrom('session')
    .where('userId', '=', userId)
    .$if(!!keepSessionId, (qb) => qb.where('id', '!=', keepSessionId!))
    .where('id', 'in', (eb) =>
      eb.selectFrom('session_passkey').select('sessionId').where('passkeyId', 'in', passkeyIds),
    )
    .returning('id')
    .execute();
  return rows.map(({ id }) => id);
};
