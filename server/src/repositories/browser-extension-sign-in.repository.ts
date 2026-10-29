import { Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { Insertable, Selectable } from 'kysely';
import type {
  BrowserExtensionClient,
  BrowserExtensionSignInCodeTable,
} from 'src/schema/tables/browser-extension-sign-in.table.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { Permission } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { asUuid } from 'src/utils/database.js';

export type BrowserExtensionSignInCode = Selectable<BrowserExtensionSignInCodeTable>;

export type BrowserExtensionAccessGrant = {
  userId: string;
  client: BrowserExtensionClient;
  redirectOrigin: string;
  installationId: string;
  name: string;
  /** The SHA-256 of the new key. */
  key: Buffer;
  permissions: Permission[];
};

/** FL-655: Save to Frameleaf's sign-in codes and the accesses they became. */
@Injectable()
export class BrowserExtensionSignInRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /** Keep a new code (by its hash), dropping any that have expired. */
  async createCode(code: Insertable<BrowserExtensionSignInCodeTable>) {
    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('browser_extension_sign_in_code').where('expiresAt', '<=', new Date()).execute();
      await trx.insertInto('browser_extension_sign_in_code').values(code).execute();
    });
  }

  /** Take a code once: it is removed whether or not it is still valid, so it can never be tried twice. */
  @GenerateSql({ params: [DummyValue.BUFFER] })
  takeCode(codeHash: Buffer): Promise<BrowserExtensionSignInCode | undefined> {
    return this.db
      .deleteFrom('browser_extension_sign_in_code')
      .where('codeHash', '=', codeHash)
      .returningAll()
      .executeTakeFirst();
  }

  /** This installation's access to the account, when it still has one. */
  @GenerateSql({ params: [DummyValue.UUID, 'chrome', DummyValue.STRING, DummyValue.STRING] })
  getAccess(userId: string, client: BrowserExtensionClient, redirectOrigin: string, installationId: string) {
    return this.db
      .selectFrom('browser_extension_access')
      .innerJoin('api_key', 'api_key.id', 'browser_extension_access.apiKeyId')
      .select(['browser_extension_access.apiKeyId', 'api_key.name'])
      .where('browser_extension_access.userId', '=', userId)
      .where('browser_extension_access.client', '=', client)
      .where('browser_extension_access.redirectOrigin', '=', redirectOrigin)
      .where('browser_extension_access.installationId', '=', installationId)
      .executeTakeFirst();
  }

  /** Every access added by signing in, by key, for the API keys list. */
  @GenerateSql({ params: [DummyValue.UUID] })
  getAccessByUser(userId: string) {
    return this.db
      .selectFrom('browser_extension_access')
      .select(['apiKeyId', 'client', 'createdAt'])
      .where('userId', '=', userId)
      .execute();
  }

  /** Whether a key was added by signing in from the extension. */
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  getAccessByKey(userId: string, apiKeyId: string) {
    return this.db
      .selectFrom('browser_extension_access')
      .select(['apiKeyId', 'client'])
      .where('userId', '=', userId)
      .where('apiKeyId', '=', asUuid(apiKeyId))
      .executeTakeFirst();
  }

  /**
   * One access per installation: the new key replaces this installation's previous access to the
   * account (never another browser's), in one transaction, and is recorded as added by signing in.
   */
  async replaceAccess(grant: BrowserExtensionAccessGrant) {
    return this.db.transaction().execute(async (trx) => {
      const previous = await trx
        .selectFrom('browser_extension_access')
        .select('apiKeyId')
        .where('userId', '=', grant.userId)
        .where('client', '=', grant.client)
        .where('redirectOrigin', '=', grant.redirectOrigin)
        .where('installationId', '=', grant.installationId)
        .execute();
      if (previous.length > 0) {
        await trx
          .deleteFrom('api_key')
          .where('userId', '=', grant.userId)
          .where(
            'id',
            'in',
            previous.map(({ apiKeyId }) => apiKeyId),
          )
          .execute();
      }
      const apiKey = await trx
        .insertInto('api_key')
        .values({ key: grant.key, name: grant.name, userId: grant.userId, permissions: grant.permissions })
        .returning(['id', 'name'])
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('browser_extension_access')
        .values({
          apiKeyId: apiKey.id,
          userId: grant.userId,
          client: grant.client,
          redirectOrigin: grant.redirectOrigin,
          installationId: grant.installationId,
        })
        .execute();
      return apiKey;
    });
  }

  /** Sign out: delete this access's key (and so the access). Only a key added by signing in. */
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  async removeAccess(userId: string, apiKeyId: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('api_key')
      .where('userId', '=', userId)
      .where('id', '=', asUuid(apiKeyId))
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('browser_extension_access')
            .select('browser_extension_access.apiKeyId')
            .whereRef('browser_extension_access.apiKeyId', '=', 'api_key.id'),
        ),
      )
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }
}
