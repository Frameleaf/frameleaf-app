import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { createHash } from 'node:crypto';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { ICloudIdentityReuseAuthorityDto, ICloudIdentityReuseAuthorityStatusDto } from 'src/dtos/icloud-sync.dto.js';
import { UserMetadataKey } from 'src/enum.js';
import { lockAuditOwner } from 'src/repositories/icloud-audit.repository.js';
import { ICloudConnection } from 'src/repositories/icloud-sync.repository.js';
import { DB } from 'src/schema/index.js';
import { canonicalJson } from 'src/utils/studio-project.js';

type Grant = {
  id: string;
  generation: number;
  enabled: boolean;
  includeProtected: boolean;
  configFingerprint: string;
  privacyFingerprint: string;
  pinBinding: string | null;
  requestKey: string;
  inputFingerprint: string;
  requestHistory: Record<string, string>;
};
const fingerprint = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const pinBinding = (pin: string | null) => (pin === null ? null : fingerprint(['weekly-pin-v1', pin]));

/** Private consent foundation. No method returns worker authority or creates a cohort/operation. */
@Injectable()
export class ICloudWeeklyRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  async status(connectionId: string, ownerId: string, db = this.db): Promise<ICloudIdentityReuseAuthorityStatusDto> {
    const connection = await sql<ICloudConnection>`SELECT * FROM immich_fork.icloud_connection
      WHERE id=${connectionId}::uuid AND "ownerId"=${ownerId}::uuid`.execute(db);
    const owner = await db
      .selectFrom('user')
      .select(['pinCode', 'deletedAt'])
      .where('id', '=', ownerId)
      .executeTakeFirst();
    const {
      rows: [metadata],
    } = await sql<{ privacy: unknown }>`SELECT coalesce(value->'privacy','{}'::jsonb) AS privacy
      FROM public.user_metadata WHERE "userId"=${ownerId}::uuid AND key=${UserMetadataKey.Preferences}`.execute(db);
    const grant = await sql<Grant>`SELECT * FROM immich_fork.icloud_weekly_grant
      WHERE "connectionId"=${connectionId}::uuid AND "ownerId"=${ownerId}::uuid`.execute(db);
    const current = grant.rows[0];
    const connected = connection.rows[0];
    const privacy = metadata?.privacy ?? {};
    const available =
      !!current?.enabled &&
      !!owner &&
      !owner.deletedAt &&
      !!connected &&
      connected.state === 'connected' &&
      !!connected.encryptedSession &&
      connected.lastError !== 'owner_removed' &&
      current.configFingerprint === fingerprint(connected.config) &&
      current.privacyFingerprint === fingerprint(privacy) &&
      (!current.includeProtected || (!!owner.pinCode && current.pinBinding === pinBinding(owner.pinCode)));
    return {
      enabled: !!current?.enabled,
      includeProtected: !!current?.includeProtected,
      available,
      regrantRequired: !!current && !available,
      executionAvailable: false,
    };
  }

  async setAuthority(
    auth: AuthDto,
    connectionId: string,
    input: ICloudIdentityReuseAuthorityDto,
  ): Promise<ICloudIdentityReuseAuthorityStatusDto> {
    if (!auth.session || auth.apiKey || auth.sharedLink) {
      throw new ForbiddenException('A current owner session is required');
    }
    // UUID equality is case-insensitive in PostgreSQL; the private replay ledger uses that identity.
    const requestKey = input.requestKey.toLowerCase();
    return this.db.transaction().execute(async (db) => {
      // Every input row precedes grant. Retirement triggers take only the affected grant rows,
      // never an earlier input lock; rollback restores both changed input and retirement.
      await lockAuditOwner(db, auth.user.id);
      await db
        .selectFrom('session')
        .select('id')
        .where('id', '=', auth.session!.id)
        .where('userId', '=', auth.user.id)
        .forShare()
        .executeTakeFirst();
      const owner = await db
        .selectFrom('user')
        .select('pinCode')
        .where('id', '=', auth.user.id)
        .executeTakeFirstOrThrow();
      // Materialize the ordinary empty preference row if absent, so INSERT/DELETE races
      // cannot pass through a missing-row lock gap. Existing preferences are never overwritten.
      await sql`INSERT INTO public.user_metadata ("userId",key,value)
        VALUES (${auth.user.id}::uuid,${UserMetadataKey.Preferences},'{}'::jsonb)
        ON CONFLICT ("userId",key) DO NOTHING`.execute(db);
      const {
        rows: [metadata],
      } = await sql<{ privacy: unknown }>`SELECT coalesce(value->'privacy','{}'::jsonb) AS privacy
        FROM public.user_metadata WHERE "userId"=${auth.user.id}::uuid AND key=${UserMetadataKey.Preferences} FOR SHARE`.execute(
        db,
      );
      const {
        rows: [connection],
      } = await sql<ICloudConnection>`SELECT * FROM immich_fork.icloud_connection
        WHERE id=${connectionId}::uuid AND "ownerId"=${auth.user.id}::uuid FOR UPDATE`.execute(db);
      if (!connection) {
        throw new NotFoundException();
      }
      if (
        input.enabled &&
        (connection.state !== 'connected' || !connection.encryptedSession || connection.lastError === 'owner_removed')
      ) {
        throw new ConflictException('Connect this account before granting consent');
      }
      const configFingerprint = fingerprint(connection.config);
      const privacyFingerprint = fingerprint(metadata.privacy);
      const binding = input.includeProtected ? pinBinding(owner.pinCode) : null;
      const inputFingerprint = fingerprint({
        enabled: input.enabled,
        includeProtected: input.includeProtected,
        configFingerprint,
        privacyFingerprint,
        binding,
      });
      const {
        rows: [grant],
      } = await sql<Grant>`SELECT * FROM immich_fork.icloud_weekly_grant
        WHERE "connectionId"=${connectionId}::uuid AND "ownerId"=${auth.user.id}::uuid FOR UPDATE`.execute(db);
      const { rows: live } = await sql`SELECT id FROM public.session WHERE id=${auth.session!.id}::uuid
        AND "userId"=${auth.user.id}::uuid AND ("expiresAt" IS NULL OR "expiresAt">clock_timestamp())
        AND (${!input.includeProtected} OR (${owner.pinCode !== null} AND "pinExpiresAt">clock_timestamp()))`.execute(
        db,
      );
      if (live.length !== 1) {
        throw new ForbiddenException('Current session and PIN authority are required');
      }
      if (grant?.requestHistory[requestKey]) {
        const status = await this.status(connectionId, auth.user.id, db);
        if (
          grant.requestKey !== requestKey ||
          grant.inputFingerprint !== inputFingerprint ||
          grant.enabled !== input.enabled ||
          (input.enabled && !status.available)
        ) {
          throw new ConflictException('Consent changed; submit a new explicit choice');
        }
        // Replay does not mint authority, but still requires a live session at its final admission.
        const replay = await sql`SELECT id FROM public.session WHERE id=${auth.session!.id}::uuid
          AND "userId"=${auth.user.id}::uuid AND ("expiresAt" IS NULL OR "expiresAt">clock_timestamp())
          AND (${!input.includeProtected} OR (${owner.pinCode !== null} AND "pinExpiresAt">clock_timestamp()))`.execute(
          db,
        );
        if (replay.rows.length !== 1) {
          throw new ForbiddenException('Current session and PIN authority are required');
        }
        return status;
      }
      const history = { ...grant?.requestHistory, [requestKey]: inputFingerprint };
      const result = await sql`INSERT INTO immich_fork.icloud_weekly_grant
        ("ownerId","connectionId",generation,enabled,"includeProtected","configFingerprint","privacyFingerprint",
          "pinBinding","requestKey","inputFingerprint","requestHistory","revokedAt")
        SELECT ${auth.user.id}::uuid,${connectionId}::uuid,1,${input.enabled},${input.includeProtected},${configFingerprint},
          ${privacyFingerprint},${binding},${requestKey}::uuid,${inputFingerprint},${history}::jsonb,
          CASE WHEN ${input.enabled} THEN NULL ELSE clock_timestamp() END
        FROM public.session s JOIN public.user u ON u.id=s."userId"
        WHERE s.id=${auth.session!.id}::uuid AND u.id=${auth.user.id}::uuid AND u."deletedAt" IS NULL
          AND (s."expiresAt" IS NULL OR s."expiresAt">clock_timestamp())
          AND (${!input.includeProtected} OR (u."pinCode" IS NOT NULL AND s."pinExpiresAt">clock_timestamp()))
        ON CONFLICT("connectionId","ownerId") DO UPDATE SET generation=immich_fork.icloud_weekly_grant.generation+1,
          enabled=excluded.enabled,"includeProtected"=excluded."includeProtected","configFingerprint"=excluded."configFingerprint",
          "privacyFingerprint"=excluded."privacyFingerprint","pinBinding"=excluded."pinBinding","requestKey"=excluded."requestKey",
          "inputFingerprint"=excluded."inputFingerprint","requestHistory"=excluded."requestHistory","revokedAt"=excluded."revokedAt"
        RETURNING id`.execute(db);
      if (result.rows.length !== 1) {
        throw new ForbiddenException('Consent authority expired');
      }
      return this.status(connectionId, auth.user.id, db);
    });
  }
}
