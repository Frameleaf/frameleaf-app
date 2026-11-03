import { sql } from 'kysely';
import type { Expression, SqlBool } from 'kysely';
import { AlbumUserRole, LibraryScope, LibraryViewScope } from 'src/enum.js';

export const scopeMatches = (record: LibraryScope, view: LibraryViewScope): boolean =>
  record === view || record === LibraryScope.Both;

export const libraryScopePredicate = (view: LibraryViewScope, alias = 'asset') =>
  sql<SqlBool>`${sql.ref(`${alias}.libraryScope`)} in (${view}, ${LibraryScope.Both})`;

// Explicit incoming shares remain available to personal clients; the owner's design directory does not.
export const personalAlbumScopePredicate = (userId: string, albumId: Expression<string>) => sql<SqlBool>`exists (
  select 1 from album scope_album join album_user scope_member on scope_member."albumId" = scope_album.id
  where scope_album.id = ${albumId} and scope_member."userId" = ${userId}::uuid
    and (${libraryScopePredicate(LibraryScope.Personal, 'scope_album')} or scope_member.role != ${AlbumUserRole.Owner})
)`;
