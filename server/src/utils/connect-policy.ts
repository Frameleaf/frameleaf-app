import { ConflictException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import z from 'zod';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { DB } from 'src/schema/index.js';
import { lockAlbumHierarchy } from 'src/repositories/album.repository.js';
import { hiddenContentOrOthersRules } from 'src/utils/database.js';
import { isDefaultVisible } from 'src/utils/locked.js';

export const CONNECT_PATH = '/api/connect';
export const CONNECT_SCOPES = [
  'library:read',
  'library:download',
  'albums:write',
  'tags:write',
  'photos:upload',
  'boards:upload',
  'events:read',
] as const;
const albumIds = z
  .array(z.uuid())
  .max(100)
  .refine((ids) => new Set(ids).size === ids.length);
export const ConnectAccessPolicySchema = z
  .object({
    version: z.literal(1).meta({ type: 'integer', format: 'int32' }),
    readAlbumIds: albumIds,
    allLibraryRead: z.boolean(),
    writableAlbumIds: albumIds,
    writeWorkspaces: z
      .array(z.enum(['photo', 'design']))
      .max(2)
      .refine((items) => new Set(items).size === items.length),
  })
  .strict()
  .meta({ id: 'ConnectAccessPolicy' });
export type ConnectAccessPolicy = z.infer<typeof ConnectAccessPolicySchema>;
export type ConnectWorkspace = ConnectAccessPolicy['writeWorkspaces'][number];

export const isConnectResource = (resource: string | null | undefined) => {
  try {
    return !!resource && new URL(resource).pathname === CONNECT_PATH;
  } catch {
    return false;
  }
};

export const requireConnectPolicy = (auth: AuthDto): ConnectAccessPolicy => {
  const parsed = ConnectAccessPolicySchema.safeParse(auth.oauthApp?.accessPolicy);
  if (
    !auth.oauthApp ||
    !isConnectResource(auth.oauthApp.resource) ||
    !parsed.success ||
    auth.session ||
    auth.sharedLink
  ) {
    throw new UnauthorizedException('A restricted Connect grant is required');
  }
  return parsed.data;
};

export const requireConnectScope = (auth: AuthDto, scope: (typeof CONNECT_SCOPES)[number]) => {
  requireConnectPolicy(auth);
  if (!auth.oauthApp!.scopes.includes(scope)) throw new ForbiddenException('Missing required Connect scope');
};

export const isPolicyNarrowing = (previous: ConnectAccessPolicy, next: ConnectAccessPolicy) =>
  (!next.allLibraryRead || previous.allLibraryRead) &&
  next.readAlbumIds.every((id) => previous.allLibraryRead || previous.readAlbumIds.includes(id)) &&
  next.writableAlbumIds.every((id) => previous.writableAlbumIds.includes(id)) &&
  next.writeWorkspaces.every((workspace) => previous.writeWorkspaces.includes(workspace));

/** Reload inside the caller's transaction; lock the grant before publishing a write. */
export const refreshConnectAuth = async (db: Kysely<DB>, auth: AuthDto, forUpdate = false): Promise<AuthDto> => {
  requireConnectPolicy(auth);
  const grant = await db
    .selectFrom('oauth_grant')
    .selectAll()
    .where('id', '=', auth.oauthApp!.grantId)
    .where('userId', '=', auth.user.id)
    .$if(forUpdate, (qb) => qb.forUpdate())
    .executeTakeFirst();
  if (
    !grant ||
    grant.revokedAt ||
    new Date(grant.accessExpiresAt).getTime() <= Date.now() ||
    grant.resource !== auth.oauthApp!.resource
  ) {
    throw new UnauthorizedException('This Connect grant has ended');
  }
  const current = {
    ...auth,
    oauthApp: {
      ...auth.oauthApp!,
      scopes: grant.scopes,
      accessPolicy: grant.accessPolicy,
      policyRevision: grant.policyRevision,
    },
  };
  requireConnectPolicy(current);
  return current;
};

/** Exact live owned album, never a shared space or an inherited child selection. */
export const connectOwnedAlbumPredicate = (userId: string, alias = 'album') => sql<boolean>`
  ${sql.ref(`${alias}.deletedAt`)} is null and not ${sql.ref(`${alias}.isLocked`)}
  and ${sql.ref(`${alias}.kind`)} = 'album'
  and exists (select 1 from album_user connect_owner where connect_owner."albumId" = ${sql.ref(`${alias}.id`)}
    and connect_owner."userId" = ${userId}::uuid and connect_owner.role = 'owner')
  and not exists (select 1 from album_closure connect_ancestor join album connect_parent on connect_parent.id = connect_ancestor.id_ancestor
    where connect_ancestor.id_descendant = ${sql.ref(`${alias}.id`)}
      and (connect_parent."isLocked" or connect_parent."deletedAt" is not null or connect_parent.kind = 'space'))`;

/** Live policy is evaluated in the same SQL statement as counts, paging, events and media reads. */
export const connectAssetPredicate = (auth: AuthDto, assetAlias = 'asset', writable = false) => {
  requireConnectPolicy(auth);
  const asset = (column: string) => sql.ref(`${assetAlias}.${column}`);
  const hidden = hiddenContentOrOthersRules(
    { hiddenContent: auth.hiddenContent, excludeNsfw: auth.hideNsfwAssets, othersRulesViewerId: auth.user.id },
    assetAlias,
  );
  return sql<boolean>`${asset('ownerId')} = ${auth.user.id}::uuid and ${asset('deletedAt')} is null
    and ${isDefaultVisible(assetAlias)} ${hidden ? sql`and not ${hidden}` : sql``}
    and exists (select 1 from oauth_grant connect_grant
      where connect_grant.id = ${auth.oauthApp!.grantId}::uuid and connect_grant."userId" = ${auth.user.id}::uuid
      and connect_grant."revokedAt" is null and connect_grant."accessExpiresAt" > now()
      and connect_grant.resource = ${auth.oauthApp!.resource} and connect_grant."accessPolicy"->>'version' = '1'
      and (${writable ? sql`false` : sql`connect_grant."accessPolicy"->>'allLibraryRead' = 'true'`} or exists (
        select 1 from album_asset connect_membership join album connect_album on connect_album.id = connect_membership."albumId"
        where connect_membership."assetId" = ${asset('id')}
        and connect_grant."accessPolicy"->${writable ? 'writableAlbumIds' : 'readAlbumIds'} ? connect_album.id::text
        and ${connectOwnedAlbumPredicate(auth.user.id, 'connect_album')}
      )))`;
};

/** Existing writers can acquire rows before hierarchy; publication must not wait behind them. */
const connectAccessLocks = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === '55P03') {
      throw new ConflictException('Connect access is changing; retry the operation');
    }
    throw error;
  }
};

/** Lock every selected album and ancestor before any asset locks, retaining the writer's album order.
 * The hierarchy fence stabilizes closure discovery. Row locks then protect privacy and ownership;
 * authorization must be evaluated again after these locks, never from the discovery read.
 */
export const lockConnectPolicyAlbums = async (db: Kysely<DB>, auth: AuthDto, creatingAlbum = false) => {
  await lockAlbumHierarchy(db, { shared: !creatingAlbum, failIfBusy: true });
  const policy = requireConnectPolicy(auth);
  const ids = [...new Set([...policy.readAlbumIds, ...policy.writableAlbumIds])].sort();
  if (ids.length === 0) return;
  const ancestors = await db
    .selectFrom('album_closure')
    .select('id_ancestor')
    .where('id_descendant', 'in', ids)
    .execute();
  const allIds = [...new Set([...ids, ...ancestors.map(({ id_ancestor }) => id_ancestor)])].sort();
  await connectAccessLocks(async () => {
    await db
      .selectFrom('album')
      .select('id')
      .where('id', 'in', allIds)
      .orderBy('id')
      .forNoKeyUpdate()
      .noWait()
      .execute();
    await db
      .selectFrom('album_user')
      .select('albumId')
      .where('albumId', 'in', ids)
      .where('userId', '=', auth.user.id)
      .orderBy('albumId')
      .forShare()
      .noWait()
      .execute();
  });
};

/** Retain source privacy and exact selected memberships, including writable tag sources. */
export const lockConnectAssets = async (db: Kysely<DB>, auth: AuthDto, assetIds: string[]) => {
  if (assetIds.length === 0) return;
  const policy = requireConnectPolicy(auth);
  const ids = [...new Set([...policy.readAlbumIds, ...policy.writableAlbumIds])];
  await connectAccessLocks(async () => {
    await db
      .selectFrom('asset')
      .select('id')
      .where('id', 'in', assetIds)
      .where('ownerId', '=', auth.user.id)
      .orderBy('id')
      .forUpdate()
      .noWait()
      .execute();
    if (ids.length === 0) return;
    await db
      .selectFrom('album_asset')
      .select('assetId')
      .where('albumId', 'in', ids)
      .where('assetId', 'in', assetIds)
      .orderBy('albumId')
      .orderBy('assetId')
      .forShare()
      .noWait()
      .execute();
  });
};
