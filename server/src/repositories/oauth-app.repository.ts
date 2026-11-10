import { Injectable } from '@nestjs/common';
import { jsonObjectFrom } from 'kysely/helpers/postgres';
import { InjectKysely } from 'nestjs-kysely';
import type { Insertable, Kysely, Selectable } from 'kysely';
import { columns } from 'src/database.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { DB } from 'src/schema/index.js';
import type {
  OAuthAuthorizationCodeTable,
  OAuthClientTable,
  OAuthGrantTable,
} from 'src/schema/tables/oauth-app.table.js';
import { asUuid } from 'src/utils/database.js';

export type OAuthClient = Selectable<OAuthClientTable>;
export type OAuthGrant = Selectable<OAuthGrantTable>;
export type OAuthAuthorizationCode = Selectable<OAuthAuthorizationCodeTable>;

const clientColumns = ['id', 'name', 'redirectUris', 'logoUri', 'dynamic', 'createdById', 'createdAt'] as const;
const grantColumns = [
  'oauth_grant.id',
  'oauth_grant.userId',
  'oauth_grant.clientId',
  'oauth_grant.scopes',
  'oauth_grant.resource',
  'oauth_grant.accessExpiresAt',
  'oauth_grant.createdAt',
  'oauth_grant.lastUsedAt',
  'oauth_grant.lastUsedVia',
  'oauth_grant.revokedAt',
] as const;

/** FL-803: connected apps (OAuth clients), the codes people allowed, and their grants. */
@Injectable()
export class OAuthAppRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  @GenerateSql({ params: [DummyValue.UUID] })
  getClient(id: string): Promise<OAuthClient | undefined> {
    return this.db.selectFrom('oauth_client').select(clientColumns).where('id', '=', asUuid(id)).executeTakeFirst();
  }

  /**
   * Registers an app (RFC 7591). Self-registered apps are capped: when there are too many, the
   * oldest ones that nobody allowed (no grant at all) and that are over a day old are removed first;
   * if that does not make room, nothing is registered and `undefined` is returned.
   */
  async createClient(values: Insertable<OAuthClientTable>, dynamicLimit: number): Promise<OAuthClient | undefined> {
    return this.db.transaction().execute(async (trx) => {
      if (values.dynamic !== false) {
        const { count } = await trx
          .selectFrom('oauth_client')
          .select((eb) => eb.fn.countAll<number>().as('count'))
          .where('dynamic', '=', true)
          .executeTakeFirstOrThrow();
        const excess = Number(count) - dynamicLimit + 1;
        if (excess > 0) {
          const unused = await trx
            .selectFrom('oauth_client')
            .select('id')
            .where('dynamic', '=', true)
            .where('createdAt', '<', new Date(Date.now() - 24 * 60 * 60 * 1000))
            .where((eb) =>
              eb.not(
                eb.exists(eb.selectFrom('oauth_grant').select('oauth_grant.id').whereRef('oauth_grant.clientId', '=', 'oauth_client.id')),
              ),
            )
            .orderBy('createdAt', 'asc')
            .limit(excess)
            .execute();
          if (unused.length < excess) {
            return undefined;
          }
          await trx
            .deleteFrom('oauth_client')
            .where(
              'id',
              'in',
              unused.map(({ id }) => id),
            )
            .execute();
        }
      }
      return trx.insertInto('oauth_client').values(values).returning(clientColumns).executeTakeFirstOrThrow();
    });
  }

  /** Every registered app with how many people currently allow it, for administrators. */
  @GenerateSql()
  getClients() {
    return this.db
      .selectFrom('oauth_client')
      .select(clientColumns)
      .select((eb) =>
        eb
          .selectFrom('oauth_grant')
          .select((eb) => eb.fn.count<number>('oauth_grant.userId').distinct().as('count'))
          .whereRef('oauth_grant.clientId', '=', 'oauth_client.id')
          .where('oauth_grant.revokedAt', 'is', null)
          .as('activeUsers'),
      )
      .orderBy('createdAt', 'desc')
      .execute();
  }

  /** Removes an app; returns the people who still allowed it, so each can be told in their activity. */
  async deleteClient(id: string): Promise<{ name: string; userIds: string[] } | undefined> {
    return this.db.transaction().execute(async (trx) => {
      const grants = await trx
        .selectFrom('oauth_grant')
        .select('userId')
        .distinct()
        .where('clientId', '=', asUuid(id))
        .where('revokedAt', 'is', null)
        .execute();
      const deleted = await trx
        .deleteFrom('oauth_client')
        .where('id', '=', asUuid(id))
        .returning('name')
        .executeTakeFirst();
      return deleted && { name: deleted.name, userIds: grants.map(({ userId }) => userId) };
    });
  }

  /** Keep a new code (by its hash), dropping any that have expired. */
  async createCode(code: Insertable<OAuthAuthorizationCodeTable>) {
    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('oauth_authorization_code').where('expiresAt', '<=', new Date()).execute();
      await trx.insertInto('oauth_authorization_code').values(code).execute();
    });
  }

  /** Take a code once: it is removed whether or not it is still valid, so it can never be tried twice. */
  @GenerateSql({ params: [DummyValue.BUFFER] })
  takeCode(codeHash: Buffer): Promise<OAuthAuthorizationCode | undefined> {
    return this.db
      .deleteFrom('oauth_authorization_code')
      .where('codeHash', '=', codeHash)
      .returningAll()
      .executeTakeFirst();
  }

  createGrant(values: Insertable<OAuthGrantTable>) {
    return this.db.insertInto('oauth_grant').values(values).returning(grantColumns).executeTakeFirstOrThrow();
  }

  /**
   * The grant behind an access token, with its user as API keys carry one (`columns.authUser`), or
   * undefined when the token is unknown. Expiry and revocation are checked by the caller, so it can
   * say which.
   */
  @GenerateSql({ params: [DummyValue.BUFFER] })
  getByAccessToken(accessTokenHash: Buffer) {
    return this.db
      .selectFrom('oauth_grant')
      .innerJoin('oauth_client', 'oauth_client.id', 'oauth_grant.clientId')
      .select(grantColumns)
      .select(['oauth_client.name as clientName', 'oauth_client.redirectUris as clientRedirectUris'])
      .select((eb) =>
        jsonObjectFrom(
          eb
            .selectFrom('user')
            .select(columns.authUser)
            .whereRef('user.id', '=', 'oauth_grant.userId')
            .where('user.deletedAt', 'is', null)
            .where('user.importClaimPending', '=', false),
        ).as('user'),
      )
      .where('oauth_grant.accessTokenHash', '=', accessTokenHash)
      .executeTakeFirst();
  }

  /** The grant whose current refresh token this is. */
  @GenerateSql({ params: [DummyValue.BUFFER] })
  getByRefreshToken(refreshTokenHash: Buffer) {
    return this.db
      .selectFrom('oauth_grant')
      .innerJoin('oauth_client', 'oauth_client.id', 'oauth_grant.clientId')
      .select(grantColumns)
      .select(['oauth_client.name as clientName', 'oauth_client.redirectUris as clientRedirectUris'])
      .where('oauth_grant.refreshTokenHash', '=', refreshTokenHash)
      .executeTakeFirst();
  }

  /** The grant that already used this refresh token, if any (presenting it again revokes the grant). */
  @GenerateSql({ params: [DummyValue.BUFFER] })
  getBySpentRefreshToken(tokenHash: Buffer) {
    return this.db
      .selectFrom('oauth_spent_refresh_token')
      .innerJoin('oauth_grant', 'oauth_grant.id', 'oauth_spent_refresh_token.grantId')
      .innerJoin('oauth_client', 'oauth_client.id', 'oauth_grant.clientId')
      .select(grantColumns)
      .select(['oauth_client.name as clientName', 'oauth_client.redirectUris as clientRedirectUris'])
      .where('oauth_spent_refresh_token.tokenHash', '=', tokenHash)
      .executeTakeFirst();
  }

  /**
   * Rotation: replaces both tokens of an active grant, only if `previousRefreshHash` is still its
   * current refresh token, and keeps the spent one. Two refreshes with the same token race on the
   * row: only one finds it current; the other gets `undefined`.
   */
  async rotate(
    grantId: string,
    previousRefreshHash: Buffer,
    next: { refreshTokenHash: Buffer; accessTokenHash: Buffer; accessExpiresAt: Date },
  ): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const updated = await trx
        .updateTable('oauth_grant')
        .set(next)
        .where('id', '=', asUuid(grantId))
        .where('refreshTokenHash', '=', previousRefreshHash)
        .where('revokedAt', 'is', null)
        .returning('id')
        .executeTakeFirst();
      if (!updated) {
        return false;
      }
      await trx
        .insertInto('oauth_spent_refresh_token')
        .values({ tokenHash: previousRefreshHash, grantId: updated.id })
        .execute();
      return true;
    });
  }

  /** Revokes a grant (optionally only one of this person's); true when it was active until now. */
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  async revoke(grantId: string, userId?: string): Promise<boolean> {
    const result = await this.db
      .updateTable('oauth_grant')
      .set({ revokedAt: new Date() })
      .where('id', '=', asUuid(grantId))
      .$if(userId !== undefined, (qb) => qb.where('userId', '=', userId!))
      .where('revokedAt', 'is', null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }

  /** A person's apps that can still use their library, newest first. */
  @GenerateSql({ params: [DummyValue.UUID] })
  getActiveGrants(userId: string) {
    return this.db
      .selectFrom('oauth_grant')
      .innerJoin('oauth_client', 'oauth_client.id', 'oauth_grant.clientId')
      .select(grantColumns)
      .select(['oauth_client.name as clientName', 'oauth_client.redirectUris as clientRedirectUris'])
      .where('oauth_grant.userId', '=', userId)
      .where('oauth_grant.revokedAt', 'is', null)
      .orderBy('oauth_grant.createdAt', 'desc')
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.STRING] })
  async recordUse(grantId: string, via: string | null) {
    await this.db
      .updateTable('oauth_grant')
      .set({ lastUsedAt: new Date(), lastUsedVia: via })
      .where('id', '=', asUuid(grantId))
      .execute();
  }
}
