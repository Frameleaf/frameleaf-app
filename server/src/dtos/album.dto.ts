import { ShallowDehydrateObject } from 'kysely';
import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { isValidAlbumIcon } from 'src/constants/album-icons.js';
import { AlbumUser, AuthSharedLink } from 'src/database.js';
import { HistoryBuilder } from 'src/decorators.js';
import { BulkIdErrorReasonSchema } from 'src/dtos/asset-ids.response.dto.js';
import { MapAsset } from 'src/dtos/asset-response.dto.js';
import { UserResponseSchema, mapUser } from 'src/dtos/user.dto.js';
import {
  AlbumKind,
  AlbumKindSchema,
  AlbumUserRole,
  AlbumUserRoleSchema,
  AssetOrder,
  AssetOrderSchema,
} from 'src/enum.js';
import { MaybeDehydrated } from 'src/types.js';
import { asDateTimeString } from 'src/utils/date.js';
import { stringToBool } from 'src/validation.js';

// Icons are validated against the Material Design Icons catalogue the server
// owns as data (src/constants/album-icons.ts); the 31 legacy kebab-case keys stay
// valid so older rows are never rejected. Enforced via refine (not z.enum) so the
// wire type stays `string` and no client needs a codegen bump when the
// catalogue version moves.
export const AlbumIconSchema = z
  .string()
  .max(80)
  .refine((value) => isValidAlbumIcon(value), { message: 'Invalid album icon: expected a Material Design Icons name' });

const AlbumUserAddSchema = z
  .object({
    userId: z.uuidv4().describe('User ID'),
    role: AlbumUserRoleSchema.default(AlbumUserRole.Editor).optional().describe('Album user role'),
  })
  .meta({ id: 'AlbumUserAddDto' });

const AddUsersSchema = z
  .object({
    albumUsers: z.array(AlbumUserAddSchema).min(1).describe('Album users to add'),
  })
  .meta({ id: 'AddUsersDto' });

const AlbumUserCreateSchema = z
  .object({
    userId: z.uuidv4().describe('User ID'),
    role: AlbumUserRoleSchema,
  })
  .meta({ id: 'AlbumUserCreateDto' });

const CreateAlbumSchema = z
  .object({
    albumName: z.string().describe('Album name'),
    // TODO: drop the empty-string-to-null transform in v4 (clients should send null)
    description: z
      .string()
      .nullable()
      .transform((value) => (value === '' ? null : value))
      .optional()
      .describe('Album description')
      .meta({
        ...new HistoryBuilder()
          .added('v1')
          .updated(
            'v3',
            'Sending an empty string is deprecated; send null instead. Empty strings will no longer be coerced to null in v4.',
          )
          .getExtensions(),
      }),
    albumUsers: z.array(AlbumUserCreateSchema).optional().describe('Album users'),
    assetIds: z.array(z.uuidv4()).optional().describe('Initial asset IDs'),
    parentId: z
      .uuidv4()
      .optional()
      .describe(
        'Collection to create the album inside (omit for top-level). Only albums nest, and only inside a collection.',
      ),
    icon: AlbumIconSchema.optional().describe('Optional icon: any Material Design Icons name (see GET /albums/icons)'),
    kind: AlbumKindSchema.default(AlbumKind.Album)
      .optional()
      .describe('What to create: an album (default), a collection of albums or a shared space'),
  })
  .meta({ id: 'CreateAlbumDto' });

const AlbumsAddAssetsSchema = z
  .object({
    albumIds: z.array(z.uuidv4()).describe('Album IDs'),
    assetIds: z.array(z.uuidv4()).describe('Asset IDs'),
  })
  .meta({ id: 'AlbumsAddAssetsDto' });

const AlbumsAddAssetsResponseSchema = z
  .object({
    success: z.boolean().describe('Operation success'),
    error: BulkIdErrorReasonSchema.optional(),
  })
  .meta({ id: 'AlbumsAddAssetsResponseDto' });

const UpdateAlbumSchema = z
  .object({
    albumName: z.string().optional().describe('Album name'),
    // TODO: drop the empty-string-to-null transform in v4 (clients should send null)
    description: z
      .string()
      .nullable()
      .transform((value) => (value === '' ? null : value))
      .optional()
      .describe('Album description')
      .meta({
        ...new HistoryBuilder()
          .added('v1')
          .updated(
            'v3',
            'Sending an empty string is deprecated; send null instead. Empty strings will no longer be coerced to null in v4.',
          )
          .getExtensions(),
      }),
    albumThumbnailAssetId: z.uuidv4().optional().describe('Album thumbnail asset ID'),
    isActivityEnabled: z.boolean().optional().describe('Enable activity feed'),
    order: AssetOrderSchema.optional(),
    parentId: z
      .uuidv4()
      .nullable()
      .optional()
      .describe('Collection to move the album into (null = move to top-level, omit = no change)'),
    icon: AlbumIconSchema.nullable()
      .optional()
      .describe('Icon: any Material Design Icons name (null = clear / use default icon)'),
    sortOrder: z
      .number()
      .meta({ format: 'double' })
      .optional()
      .describe('Sibling display position. Lower values appear first. Computed by the client as a midpoint.'),
  })
  .meta({ id: 'UpdateAlbumDto' });

const GetAlbumsSchema = z
  .object({
    id: z.uuidv4().optional().describe('Album ID'),
    name: z.string().optional().describe('Album name (exact match)'),
    isOwned: stringToBool
      .optional()
      .describe('Filter by ownership: true = only owned, false = only shared-with-me, undefined = no filter'),
    isShared: stringToBool
      .optional()
      .describe('Filter by shared status: true = only shared, false = not shared, undefined = no filter'),
    assetId: z.uuidv4().optional().describe('Filter albums containing this asset ID (ignores other parameters)'),
    suppressedOnly: stringToBool.optional().describe('Return album metadata for suppressed content only'),
  })
  .meta({ id: 'GetAlbumsDto' });

const GetAlbumInfoSchema = z
  .object({
    suppressedOnly: stringToBool.optional().describe('Return album metadata for suppressed content only'),
  })
  .meta({ id: 'GetAlbumInfoDto' });

const AlbumStatisticsResponseSchema = z
  .object({
    owned: z.int().min(0).describe('Number of owned albums'),
    shared: z.int().min(0).describe('Number of shared albums'),
    notShared: z.int().min(0).describe('Number of non-shared albums'),
  })
  .meta({ id: 'AlbumStatisticsResponseDto' });

const UpdateAlbumUserSchema = z
  .object({
    role: AlbumUserRoleSchema,
  })
  .meta({ id: 'UpdateAlbumUserDto' });

const AlbumUserResponseSchema = z
  .object({
    user: UserResponseSchema,
    role: AlbumUserRoleSchema,
  })
  .meta({ id: 'AlbumUserResponseDto' });

const ContributorCountResponseSchema = z
  .object({
    userId: z.uuidv4().describe('User ID'),
    assetCount: z.int().min(0).describe('Number of assets contributed'),
  })
  .meta({ id: 'ContributorCountResponseDto' });

export const AlbumResponseSchema = z
  .object({
    id: z.uuidv4().describe('Album ID'),
    albumName: z.string().describe('Album name'),
    description: z
      .string()
      .describe('Album description')
      .meta({
        ...new HistoryBuilder()
          .added('v1')
          .updated(
            'v3',
            'An empty string is returned instead of null for backwards compatibility; null will be returned in v4.',
          )
          .getExtensions(),
      }),
    // TODO: use `isoDatetimeToDate` when using `ZodSerializerDto` on the controllers.
    createdAt: z.string().meta({ format: 'date-time' }).describe('Creation date'),
    // TODO: use `isoDatetimeToDate` when using `ZodSerializerDto` on the controllers.
    updatedAt: z.string().meta({ format: 'date-time' }).describe('Last update date'),
    albumThumbnailAssetId: z.uuidv4().nullable().describe('Thumbnail asset ID'),
    shared: z.boolean().describe('Is shared album'),
    albumUsers: z
      .array(AlbumUserResponseSchema)
      .min(1)
      .describe(
        'First entry is always the album owner. Second entry is the auth user, if it differs from the owner. The rest are ordered alphabetically.',
      ),
    hasSharedLink: z.boolean().describe('Has shared link'),
    assetCount: z.int().min(0).describe('Number of assets'),
    // TODO: use `isoDatetimeToDate` when using `ZodSerializerDto` on the controllers.
    lastModifiedAssetTimestamp: z
      .string()
      .meta({ format: 'date-time' })
      .optional()
      .describe('Last modified asset timestamp'),
    // TODO: use `isoDatetimeToDate` when using `ZodSerializerDto` on the controllers.
    startDate: z.string().meta({ format: 'date-time' }).optional().describe('Start date (earliest asset)'),
    // TODO: use `isoDatetimeToDate` when using `ZodSerializerDto` on the controllers.
    endDate: z.string().meta({ format: 'date-time' }).optional().describe('End date (latest asset)'),
    isActivityEnabled: z.boolean().describe('Activity feed enabled'),
    order: AssetOrderSchema.optional(),
    contributorCounts: z.array(ContributorCountResponseSchema).optional(),
    parentId: z.string().nullable().describe('Collection this album belongs to (null = top-level)'),
    // Deliberately tolerant on read: a value stored before validation existed
    // (or written directly to the DB) must not break album reads. Writes are
    // constrained via AlbumIconSchema on create/update.
    icon: z.string().nullable().describe('Icon: a Material Design Icons name or legacy key (null = default icon)'),
    kind: AlbumKindSchema,
    isSmart: z
      .boolean()
      .optional()
      .describe(
        'True when the album is filled by smart album rules. Populated by GET /albums/tree and GET /albums/{id}.',
      ),
    smartRuleId: z
      .string()
      .nullable()
      .optional()
      .describe('Your classification rule behind this smart album, when it is one of yours'),
    sortOrder: z
      .number()
      .meta({ format: 'double' })
      .nullable()
      .describe('Sibling display position. Lower values appear first.'),
  })
  .meta({ id: 'AlbumResponseDto' });

const MoveAlbumSchema = z
  .object({
    collectionId: z
      .uuidv4()
      .nullable()
      .describe('Collection to move the album into, or null to take it out so it stands on its own'),
    expectedParentId: z
      .uuidv4()
      .nullable()
      .optional()
      .describe(
        'Where the client last saw the album (its collection, or null for on its own). When given and the album has been moved since, the move is refused with 409 instead of undoing the other change.',
      ),
  })
  .meta({ id: 'MoveAlbumDto' });

const AlbumOrderSchema = z
  .object({
    parentId: z
      .uuidv4()
      .nullable()
      .describe(
        'Collection whose albums are ordered, or null for a top-level group (collections, albums on their own, or shared spaces)',
      ),
    albumIds: z
      .array(z.uuidv4())
      .min(1)
      .max(5000)
      .describe(
        'Every item of the group, in the order to show them. Must be exactly the group as it is now; a group that changed since the client loaded it is refused with 409.',
      ),
  })
  .meta({ id: 'AlbumOrderDto' });

const AlbumCollectionResponseSchema = z
  .object({
    collection: AlbumResponseSchema,
    albums: z.array(AlbumResponseSchema).describe('Albums inside the collection, in display order'),
    albumCount: z.int().min(0).describe('Number of albums inside the collection'),
    assetCount: z.int().min(0).describe('Items in the collection and its albums (sum, not deduplicated)'),
  })
  .meta({ id: 'AlbumCollectionResponseDto' });

const AlbumTreeResponseSchema = z
  .object({
    collections: z.array(AlbumCollectionResponseSchema).describe('Collections visible to the user with their albums'),
    albums: z.array(AlbumResponseSchema).describe('Albums that stand on their own (not inside a visible collection)'),
    spaces: z.array(AlbumResponseSchema).describe('Shared spaces, always top level'),
  })
  .meta({ id: 'AlbumTreeResponseDto' });

const AlbumIconSuggestionResponseSchema = z
  .object({
    name: z.string().describe('Material Design Icons name, e.g. mdiCameraOutline'),
    label: z.string().describe('Human label for search and accessibility'),
  })
  .meta({ id: 'AlbumIconSuggestionResponseDto' });

const AlbumIconGroupResponseSchema = z
  .object({
    label: z.string().describe('Category label'),
    icons: z.array(AlbumIconSuggestionResponseSchema).describe('Suggested icons in this category'),
  })
  .meta({ id: 'AlbumIconGroupResponseDto' });

const AlbumIconCatalogueResponseSchema = z
  .object({
    version: z.string().describe('Material Design Icons catalogue version the names come from'),
    names: z.array(z.string()).describe('Every valid icon name, sorted'),
    suggested: z.array(AlbumIconGroupResponseSchema).describe('Categorised suggested set offered first'),
  })
  .meta({ id: 'AlbumIconCatalogueResponseDto' });

const AlbumDescendantCountResponseSchema = z
  .object({
    count: z.int().min(0).describe('Number of descendant albums (children, grandchildren, etc.)'),
  })
  .meta({ id: 'AlbumDescendantCountResponseDto' });

const AlbumUserParamSchema = z.object({
  id: z.uuidv4().describe('Album ID'),
  // TODO: disallow 'me' as a shortcut in v4 and type userId as uuidv4
  userId: z
    .string()
    .refine((value) => value === 'me' || z.uuidv4().safeParse(value).success, {
      error: 'Must be a UUID v4 or "me"',
    })
    .describe('Album user ID, or "me" to reference the current user.')
    .meta(new HistoryBuilder().updated('v3', '"me" as a value is deprecated').getExtensions()),
});

export class AlbumUserParamDto extends createZodDto(AlbumUserParamSchema) {}
export class AddUsersDto extends createZodDto(AddUsersSchema) {}
export class AlbumUserCreateDto extends createZodDto(AlbumUserCreateSchema) {}
export class CreateAlbumDto extends createZodDto(CreateAlbumSchema) {}
export class AlbumsAddAssetsDto extends createZodDto(AlbumsAddAssetsSchema) {}
export class AlbumsAddAssetsResponseDto extends createZodDto(AlbumsAddAssetsResponseSchema) {}
export class UpdateAlbumDto extends createZodDto(UpdateAlbumSchema) {}
export class GetAlbumsDto extends createZodDto(GetAlbumsSchema) {}
export class GetAlbumInfoDto extends createZodDto(GetAlbumInfoSchema) {}
export class AlbumStatisticsResponseDto extends createZodDto(AlbumStatisticsResponseSchema) {}
export class UpdateAlbumUserDto extends createZodDto(UpdateAlbumUserSchema) {}
export class AlbumResponseDto extends createZodDto(AlbumResponseSchema) {}
export class AlbumDescendantCountResponseDto extends createZodDto(AlbumDescendantCountResponseSchema) {}
export class MoveAlbumDto extends createZodDto(MoveAlbumSchema) {}
export class AlbumOrderDto extends createZodDto(AlbumOrderSchema) {}
export class AlbumCollectionResponseDto extends createZodDto(AlbumCollectionResponseSchema) {}
export class AlbumTreeResponseDto extends createZodDto(AlbumTreeResponseSchema) {}
export class AlbumIconCatalogueResponseDto extends createZodDto(AlbumIconCatalogueResponseSchema) {}
class AlbumUserResponseDto extends createZodDto(AlbumUserResponseSchema) {}

export type MapAlbumDto = {
  albumUsers?: AlbumUser[];
  assets?: ShallowDehydrateObject<MapAsset>[];
  sharedLinks?: ShallowDehydrateObject<AuthSharedLink>[];
  albumName: string;
  description: string | null;
  albumThumbnailAssetId: string | null;
  createdAt: Date;
  updatedAt: Date;
  id: string;
  isActivityEnabled: boolean;
  order: AssetOrder;
  parentId: string | null;
  icon: string | null;
  sortOrder: number | null;
  kind: AlbumKind | string;
};

const ALBUM_KINDS: ReadonlySet<string> = new Set(Object.values(AlbumKind));
/** Rows written before the kind column existed read as plain albums. */
export const asAlbumKind = (value: string | null | undefined): AlbumKind =>
  value && ALBUM_KINDS.has(value) ? (value as AlbumKind) : AlbumKind.Album;

export const mapAlbum = (entity: MaybeDehydrated<MapAlbumDto>): AlbumResponseDto => {
  const albumUsers: AlbumUserResponseDto[] = [];

  if (entity.albumUsers) {
    for (const albumUser of entity.albumUsers) {
      const user = mapUser(albumUser.user);
      albumUsers.push({
        user,
        role: albumUser.role,
      });
    }
  }

  const assets = entity.assets || [];

  const hasSharedLink = !!entity.sharedLinks && entity.sharedLinks.length > 0;
  const hasSharedUser = albumUsers.length > 1;

  let startDate = assets.at(0)?.localDateTime;
  let endDate = assets.at(-1)?.localDateTime;
  // Swap dates if start date is greater than end date.
  if (startDate && endDate && startDate > endDate) {
    [startDate, endDate] = [endDate, startDate];
  }

  return {
    albumName: entity.albumName,
    // TODO: return null instead of '' in v4
    description: entity.description ?? '',
    albumThumbnailAssetId: entity.albumThumbnailAssetId,
    createdAt: asDateTimeString(entity.createdAt),
    updatedAt: asDateTimeString(entity.updatedAt),
    id: entity.id,
    albumUsers,
    shared: hasSharedUser || hasSharedLink,
    hasSharedLink,
    startDate: asDateTimeString(startDate),
    endDate: asDateTimeString(endDate),
    assetCount: entity.assets?.length || 0,
    isActivityEnabled: entity.isActivityEnabled,
    order: entity.order,
    parentId: entity.parentId,
    icon: entity.icon,
    sortOrder: entity.sortOrder,
    kind: asAlbumKind(entity.kind),
  };
};
