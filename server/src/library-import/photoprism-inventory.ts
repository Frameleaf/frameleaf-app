import { z } from 'zod';
import { classifyPhotoprismFile } from 'src/library-import/photoprism-files.js';
import { normalizePhotoprismAlbum, normalizePhotoprismPhoto } from 'src/library-import/photoprism-metadata.js';
import {
  PhotoprismRow,
  PhotoprismTable,
  openPhotoprismSnapshot,
  photoprismTables,
} from 'src/library-import/photoprism.js';

const id = z.string().min(1);
const flag = z.union([z.literal(0n), z.literal(1n)]).transform((value) => value === 1n);
const principalSchema = z.object({
  user_uid: id,
  user_name: z.string(),
  display_name: z.string().nullable(),
  user_role: z.string(),
  auth_provider: z.string(),
  can_login: flag,
});
const membershipSchema = z.object({
  photo_uid: id,
  album_uid: id,
  order: z.bigint(),
  hidden: flag,
  missing: flag,
});
const systemPrincipals: Record<string, { role: string; provider: string }> = {
  u000000000000001: { role: '', provider: 'none' },
  u000000000000002: { role: 'visitor', provider: 'link' },
};
const normalizePrincipal = (row: PhotoprismRow) => {
  const result = principalSchema.safeParse(row);
  if (!result.success) throw new Error('PhotoPrism source refused: PHOTOPRISM_PRINCIPAL_INVALID');
  const principal = result.data;
  const system = Object.hasOwn(systemPrincipals, principal.user_uid) ? systemPrincipals[principal.user_uid] : undefined;
  if (
    system &&
    (principal.user_name !== '' ||
      principal.user_role !== system.role ||
      principal.auth_provider !== system.provider ||
      principal.can_login)
  ) {
    throw new Error('PhotoPrism source refused: PHOTOPRISM_SYSTEM_PRINCIPAL_CHANGED');
  }
  return {
    id: principal.user_uid,
    name: principal.display_name || principal.user_name || principal.user_uid,
    userName: principal.user_name,
    role: principal.user_role,
    canLogin: principal.can_login,
    system: system !== undefined,
  };
};

export type PhotoprismInventoryRecord =
  | { type: 'photo'; value: Omit<ReturnType<typeof normalizePhotoprismPhoto>, 'archive'> }
  | { type: 'file'; value: Omit<ReturnType<typeof classifyPhotoprismFile>, 'archive'> }
  | { type: 'album'; value: Omit<ReturnType<typeof normalizePhotoprismAlbum>, 'archive' | 'assetIds' | 'memberships'> }
  | { type: 'principal'; value: ReturnType<typeof normalizePrincipal> }
  | {
      type: 'membership';
      value: { photoId: string; albumId: string; order: string; hidden: boolean; missing: boolean };
    }
  | { type: 'archive'; table: PhotoprismTable; value: PhotoprismRow };

/** Streams separate logical records and credential-free archive records; it does not establish ownership, byte integrity or permission equivalence. */
export function* readPhotoprismInventory(path: string, version: string): Generator<PhotoprismInventoryRecord, void> {
  const source = openPhotoprismSnapshot(path, version);
  try {
    source.validateRelationships();
    for (const table of photoprismTables) {
      for (const batch of source.rows(table)) {
        for (const row of batch) {
          switch (table) {
            case 'photos': {
              if (typeof row.id !== 'bigint') throw new Error('PhotoPrism source refused: PHOTOPRISM_METADATA_INVALID');
              const { archive: _archive, ...value } = normalizePhotoprismPhoto(row, source.photoDetails(row.id));
              yield { type: 'photo', value };
              break;
            }
            case 'files': {
              const { archive: _archive, ...value } = classifyPhotoprismFile(row);
              yield { type: 'file', value };
              break;
            }
            case 'albums': {
              const {
                archive: _archive,
                assetIds: _ids,
                memberships: _memberships,
                ...value
              } = normalizePhotoprismAlbum(row, []);
              yield { type: 'album', value };
              break;
            }
            case 'users': {
              yield { type: 'principal', value: normalizePrincipal(row) };
              break;
            }
            case 'photos_albums': {
              const result = membershipSchema.safeParse(row);
              if (!result.success) throw new Error('PhotoPrism source refused: PHOTOPRISM_ALBUM_MEMBERSHIP_INVALID');
              const membership = result.data;
              yield {
                type: 'membership',
                value: {
                  photoId: membership.photo_uid,
                  albumId: membership.album_uid,
                  order: membership.order.toString(),
                  hidden: membership.hidden,
                  missing: membership.missing,
                },
              };
              break;
            }
            default: {
              break;
            }
          }
          yield { type: 'archive', table, value: row };
        }
      }
    }
  } finally {
    source.close();
  }
}
