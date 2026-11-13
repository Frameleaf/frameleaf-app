import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import z from 'zod';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { DB } from 'src/schema/index.js';
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
    version: z.literal(1),
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
