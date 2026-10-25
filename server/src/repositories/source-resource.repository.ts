import { ConflictException, Injectable } from '@nestjs/common';
import { Kysely, Transaction, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { SourceGrantRequestDto, SourceResourceBinding } from 'src/dtos/source-resource.dto.js';
import type { DB } from 'src/schema/index.js';
import { lockSourceAuthorities } from 'src/utils/source-authority-lock.js';

export type SourceResourceGrant = Omit<SourceResourceBinding, 'serverId'> & {
  grantId: string;
  deviceId: string;
  credentialHash: Buffer;
};
export type SourceResourceCredential = SourceResourceGrant & {
  publicKey: string;
  photoSessionId: string;
  expiresAt: Date;
};
type Authority = {
  ownerId: string;
  photoSessionId: string;
  request: Pick<SourceGrantRequestDto, 'sourceId' | 'deviceId' | 'scopeFingerprint'>;
};

@Injectable()
export class SourceResourceRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  private authority(db: Kysely<DB>, input: Authority) {
    return db
      .selectFrom('photo_source as source')
      .innerJoin('desktop_device as device', 'device.id', 'source.deviceId')
      .innerJoin('session as photo', 'photo.id', 'source.photoSessionId')
      .innerJoin('user as owner', 'owner.id', 'source.ownerId')
      .select([
        'source.id as sourceId',
        'source.ownerId',
        'source.deviceId',
        'source.photoSessionId',
        'source.scopeFingerprint',
        'device.publicKey',
        'device.authorizationEpoch',
      ])
      .where('source.id', '=', input.request.sourceId)
      .where('source.deviceId', '=', input.request.deviceId)
      .where('source.scopeFingerprint', '=', input.request.scopeFingerprint)
      .where('source.ownerId', '=', input.ownerId)
      .where('source.photoSessionId', '=', input.photoSessionId)
      .where(sql<boolean>`source.mode = 'reference'`)
      .where('source.revokedAt', 'is', null)
      .whereRef('device.userId', '=', 'source.ownerId')
      .where('device.revokedAt', 'is', null)
      .where('device.state', 'not in', ['paused', 'revoked'])
      .whereRef('photo.userId', '=', 'source.ownerId')
      .where((eb) =>
        eb.or([eb('photo.expiresAt', 'is', null), eb('photo.expiresAt', '>', sql<Date>`clock_timestamp()`)]),
      )
      .where('owner.deletedAt', 'is', null);
  }

  device(ownerId: string, photoSessionId: string, request: SourceGrantRequestDto) {
    return this.authority(this.db, { ownerId, photoSessionId, request }).executeTakeFirst();
  }

  private async lockedAuthority(tx: Transaction<DB>, input: Authority) {
    if (!(await lockSourceAuthorities(tx, [{ sourceId: input.request.sourceId, ownerId: input.ownerId }]))) return;
    // Lock source before grant in both issuance and consumption, so rotation cannot deadlock a request.
    return this.authority(tx, input)
      .forShare('owner')
      .forShare('photo')
      .forShare('device')
      .forUpdate('source')
      .executeTakeFirst();
  }

  issue(
    input: Authority & {
      request: SourceGrantRequestDto;
      authorizationEpoch: number;
      publicKey: string;
      tokenHash: Buffer;
    },
  ) {
    return this.db.transaction().execute(async (tx) => {
      if (input.tokenHash.length !== 32) return;
      const source = await this.lockedAuthority(tx, input);
      if (
        !source ||
        source.authorizationEpoch !== input.authorizationEpoch ||
        source.publicKey !== input.publicKey ||
        Math.abs(Date.now() - input.request.timestamp) > 120_000
      )
        return;
      await tx
        .deleteFrom('source_resource_grant_nonce')
        .where('sourceId', '=', source.sourceId)
        .where('expiresAt', '<=', sql<Date>`clock_timestamp()`)
        .execute();
      const nonces = await tx
        .selectFrom('source_resource_grant_nonce')
        .select('requestId')
        .where('sourceId', '=', source.sourceId)
        .execute();
      if (nonces.some((nonce) => nonce.requestId === input.request.requestId)) return;
      if (nonces.length >= 8) throw new ConflictException('source_grant_issue_busy');
      // Keep nonces beyond the full acceptance window, including future-dated signed requests.
      await tx
        .insertInto('source_resource_grant_nonce')
        .values({
          sourceId: source.sourceId,
          requestId: input.request.requestId,
          expiresAt: sql`clock_timestamp() + interval '10 minutes'`,
        })
        .execute();
      const values = {
        sourceId: source.sourceId,
        photoSessionId: input.photoSessionId,
        tokenHash: input.tokenHash,
        scopeFingerprint: source.scopeFingerprint,
        authorizationEpoch: source.authorizationEpoch,
        lastSequence: 0,
        revokedAt: null,
        expiresAt: sql<Date>`clock_timestamp() + interval '1 hour'`,
      };
      const grant = await tx
        .insertInto('source_resource_grant')
        .values(values)
        .onConflict((oc) => oc.column('sourceId').doUpdateSet(values))
        .returning(['id', 'expiresAt'])
        .executeTakeFirstOrThrow();
      return { ...source, grantId: grant.id, credentialHash: input.tokenHash, expiresAt: new Date(grant.expiresAt) };
    });
  }

  async session(grantId: string, tokenHash: Buffer): Promise<SourceResourceCredential | undefined> {
    const grant = await this.db
      .selectFrom('source_resource_grant')
      .selectAll()
      .where('id', '=', grantId)
      .where('tokenHash', '=', tokenHash)
      .where('revokedAt', 'is', null)
      .where('expiresAt', '>', sql<Date>`clock_timestamp()`)
      .executeTakeFirst();
    if (!grant) return;
    const source = await this.db
      .selectFrom('photo_source')
      .select(['ownerId', 'deviceId'])
      .where('id', '=', grant.sourceId)
      .executeTakeFirst();
    if (!source) return;
    const live = await this.authority(this.db, {
      ownerId: source.ownerId,
      photoSessionId: grant.photoSessionId,
      request: { sourceId: grant.sourceId, deviceId: source.deviceId, scopeFingerprint: grant.scopeFingerprint },
    }).executeTakeFirst();
    if (!live || live.authorizationEpoch !== grant.authorizationEpoch) return;
    return { ...live, grantId, credentialHash: tokenHash, expiresAt: new Date(grant.expiresAt) };
  }

  async withGrant<T>(grant: SourceResourceGrant, action: (tx: Transaction<DB>) => Promise<T>): Promise<T | undefined> {
    const credential = await this.session(grant.grantId, grant.credentialHash);
    if (
      !credential ||
      credential.sourceId !== grant.sourceId ||
      credential.ownerId !== grant.ownerId ||
      credential.deviceId !== grant.deviceId ||
      credential.scopeFingerprint !== grant.scopeFingerprint ||
      credential.authorizationEpoch !== grant.authorizationEpoch
    )
      return;
    const expired = new Error('source_grant_expired');
    return this.db
      .transaction()
      .execute(async (tx) => {
        const source = await this.lockedAuthority(tx, { ...credential, request: credential });
        if (
          !source ||
          source.authorizationEpoch !== credential.authorizationEpoch ||
          source.publicKey !== credential.publicKey
        )
          return;
        const liveGrant = tx
          .selectFrom('source_resource_grant')
          .select('id')
          .where('id', '=', grant.grantId)
          .where('sourceId', '=', grant.sourceId)
          .where('photoSessionId', '=', credential.photoSessionId)
          .where('tokenHash', '=', grant.credentialHash)
          .where('scopeFingerprint', '=', grant.scopeFingerprint)
          .where('authorizationEpoch', '=', grant.authorizationEpoch)
          .where('revokedAt', 'is', null)
          .where('expiresAt', '>', sql<Date>`clock_timestamp()`)
          .forShare();
        if (!(await liveGrant.executeTakeFirst())) return;
        // Keep scoped database work atomic with revocation; never perform network or file IO in this callback.
        const result = await action(tx);
        const authority = await this.authority(tx, { ...credential, request: credential })
          .where('device.authorizationEpoch', '=', credential.authorizationEpoch)
          .where('device.publicKey', '=', credential.publicKey)
          .executeTakeFirst();
        // Row locks do not stop time; expiry must roll back writes made after a lock wait.
        if (!authority || !(await liveGrant.executeTakeFirst())) throw expired;
        return result;
      })
      .catch((error): undefined => {
        if (error !== expired) throw error;
      });
  }

  consume(credential: SourceResourceCredential, sequence: number): Promise<SourceResourceGrant | undefined> {
    return this.db.transaction().execute(async (tx) => {
      if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > 2_147_483_647) return;
      const source = await this.lockedAuthority(tx, { ...credential, request: credential });
      if (
        !source ||
        source.authorizationEpoch !== credential.authorizationEpoch ||
        source.publicKey !== credential.publicKey
      )
        return;
      const grant = await tx
        .updateTable('source_resource_grant')
        .set({ lastSequence: sequence })
        .where('id', '=', credential.grantId)
        .where('sourceId', '=', credential.sourceId)
        .where('photoSessionId', '=', credential.photoSessionId)
        .where('tokenHash', '=', credential.credentialHash)
        .where('authorizationEpoch', '=', credential.authorizationEpoch)
        .where('scopeFingerprint', '=', credential.scopeFingerprint)
        .where('revokedAt', 'is', null)
        .where('expiresAt', '>', sql<Date>`clock_timestamp()`)
        .where('lastSequence', '<', sequence)
        .returning('id')
        .executeTakeFirst();
      if (grant) {
        const { grantId, sourceId, deviceId, ownerId, scopeFingerprint, authorizationEpoch, credentialHash } =
          credential;
        return { grantId, sourceId, deviceId, ownerId, scopeFingerprint, authorizationEpoch, credentialHash };
      }
    });
  }
}
