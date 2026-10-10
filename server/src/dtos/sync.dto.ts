import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { ExtraModel } from 'src/decorators.js';
import { AlbumSourceLinkResponseSchema } from 'src/dtos/album-source.dto.js';
import { ImageEncodingSchema } from 'src/dtos/image-encoding.dto.js';
import { PetObservationResponseSchema, PetResponseSchema } from 'src/dtos/pet.dto.js';
import { PIN_LIMIT, PinnedCollectionSchema, PinnedCollectionsResponseSchema } from 'src/dtos/pinned-collection.dto.js';
import {
  AlbumKindSchema,
  AlbumUserRole,
  AlbumUserRoleSchema,
  AssetOrderSchema,
  AssetStatus,
  AssetTypeSchema,
  AssetVisibilitySchema,
  MemoryTypeSchema,
  SyncEntityType,
  SyncEntityTypeSchema,
  SyncRequestTypeSchema,
  UserAvatarColorSchema,
  UserMetadataKeySchema,
} from 'src/enum.js';
import { isoDatetimeToDate } from 'src/validation.js';

const SyncUserV1Schema = z
  .object({
    id: z.uuidv4().describe('User ID'),
    name: z.string().describe('User name'),
    email: z.string().describe('User email'),
    avatarColor: UserAvatarColorSchema.nullish(),
    deletedAt: isoDatetimeToDate.nullable().describe('User deleted at'),
    hasProfileImage: z.boolean().describe('User has profile image'),
    profileChangedAt: isoDatetimeToDate.describe('User profile changed at'),
  })
  .meta({ id: 'SyncUserV1' });

const SyncAuthUserV1Schema = SyncUserV1Schema.merge(
  z.object({
    isAdmin: z.boolean().describe('User is admin'),
    pinCode: z.string().nullable().describe('User pin code'),
    oauthId: z.string().describe('User OAuth ID'),
    storageLabel: z.string().nullable().describe('User storage label'),
    quotaSizeInBytes: z.int().nullable().describe('Quota size in bytes'),
    quotaUsageInBytes: z.int().describe('Quota usage in bytes'),
  }),
).meta({ id: 'SyncAuthUserV1' });

const SyncAuthUserV2Schema = SyncAuthUserV1Schema.extend({
  oauthId: z.string().nullable().describe('User OAuth ID'),
}).meta({ id: 'SyncAuthUserV2' });

const SyncUserDeleteV1Schema = z.object({ userId: z.uuidv4().describe('User ID') }).meta({ id: 'SyncUserDeleteV1' });

const SyncPartnerV1Schema = z
  .object({
    sharedById: z.uuidv4().describe('Shared by ID'),
    sharedWithId: z.uuidv4().describe('Shared with ID'),
    inTimeline: z.boolean().describe('In timeline'),
  })
  .meta({ id: 'SyncPartnerV1' });

const SyncPartnerDeleteV1Schema = z
  .object({
    sharedById: z.uuidv4().describe('Shared by ID'),
    sharedWithId: z.uuidv4().describe('Shared with ID'),
  })
  .meta({ id: 'SyncPartnerDeleteV1' });

const SyncAssetV1Schema = z
  .object({
    id: z.uuidv4().describe('Asset ID'),
    ownerId: z.uuidv4().describe('Owner ID'),
    originalFileName: z.string().describe('Original file name'),
    thumbhash: z.string().nullable().describe('Thumbhash'),
    checksum: z.string().describe('Checksum'),
    fileCreatedAt: isoDatetimeToDate.nullable().describe('File created at'),
    fileModifiedAt: isoDatetimeToDate.nullable().describe('File modified at'),
    createdAt: isoDatetimeToDate.nullable().describe('Uploaded to Frameleaf at'),
    localDateTime: isoDatetimeToDate.nullable().describe('Local date time'),
    duration: z.string().nullable().describe('Duration'),
    type: AssetTypeSchema,
    deletedAt: isoDatetimeToDate.nullable().describe('Deleted at'),
    isFavorite: z.boolean().describe('Is favorite'),
    visibility: AssetVisibilitySchema,
    livePhotoVideoId: z.string().nullable().describe('Live photo video ID'),
    stackId: z.string().nullable().describe('Stack ID'),
    libraryId: z.string().nullable().describe('Library ID'),
    width: z.int().nullable().describe('Asset width'),
    height: z.int().nullable().describe('Asset height'),
    isEdited: z.boolean().describe('Is edited'),
  })
  .meta({ id: 'SyncAssetV1' });

const SyncAssetV2Schema = z
  .object({
    id: z.uuidv4().describe('Asset ID'),
    ownerId: z.uuidv4().describe('Owner ID'),
    originalFileName: z.string().describe('Original file name'),
    thumbhash: z.string().nullable().describe('Thumbhash'),
    checksum: z.string().describe('Checksum'),
    fileCreatedAt: isoDatetimeToDate.nullable().describe('File created at'),
    fileModifiedAt: isoDatetimeToDate.nullable().describe('File modified at'),
    createdAt: isoDatetimeToDate.nullable().describe('Uploaded to Frameleaf at'),
    localDateTime: isoDatetimeToDate.nullable().describe('Local date time'),
    duration: z.int32().min(0).nullable().describe('Duration'),
    type: AssetTypeSchema,
    deletedAt: isoDatetimeToDate.nullable().describe('Deleted at'),
    isFavorite: z.boolean().describe('Is favorite'),
    visibility: AssetVisibilitySchema,
    livePhotoVideoId: z.string().nullable().describe('Live photo video ID'),
    stackId: z.string().nullable().describe('Stack ID'),
    libraryId: z.string().nullable().describe('Library ID'),
    width: z.int().nullable().describe('Asset width'),
    height: z.int().nullable().describe('Asset height'),
    isEdited: z.boolean().describe('Is edited'),
  })
  .meta({ id: 'SyncAssetV2' });

@ExtraModel()
class SyncUserV1 extends createZodDto(SyncUserV1Schema) {}
@ExtraModel()
class SyncAuthUserV1 extends createZodDto(SyncAuthUserV1Schema) {}
@ExtraModel()
class SyncAuthUserV2 extends createZodDto(SyncAuthUserV2Schema) {}
@ExtraModel()
class SyncUserDeleteV1 extends createZodDto(SyncUserDeleteV1Schema) {}
@ExtraModel()
class SyncPartnerV1 extends createZodDto(SyncPartnerV1Schema) {}
@ExtraModel()
class SyncPartnerDeleteV1 extends createZodDto(SyncPartnerDeleteV1Schema) {}
@ExtraModel()
export class SyncAssetV1 extends createZodDto(SyncAssetV1Schema) {}
@ExtraModel()
export class SyncAssetV2 extends createZodDto(SyncAssetV2Schema) {}

const SyncAssetDeleteV1Schema = z
  .object({ assetId: z.uuidv4().describe('Asset ID') })
  .meta({ id: 'SyncAssetDeleteV1' });

const SyncAssetExifV1Schema = z
  .object({
    assetId: z.uuidv4().describe('Asset ID'),
    description: z.string().nullable().describe('Description'),
    exifImageWidth: z.int().nullable().describe('Exif image width'),
    exifImageHeight: z.int().nullable().describe('Exif image height'),
    fileSizeInByte: z.int().nullable().describe('File size in byte'),
    orientation: z.string().nullable().describe('Orientation'),
    dateTimeOriginal: isoDatetimeToDate.nullable().describe('Date time original'),
    modifyDate: isoDatetimeToDate.nullable().describe('Modify date'),
    timeZone: z.string().nullable().describe('Time zone'),
    latitude: z.number().meta({ format: 'double' }).nullable().describe('Latitude'),
    longitude: z.number().meta({ format: 'double' }).nullable().describe('Longitude'),
    projectionType: z.string().nullable().describe('Projection type'),
    city: z.string().nullable().describe('City'),
    state: z.string().nullable().describe('State'),
    country: z.string().nullable().describe('Country'),
    make: z.string().nullable().describe('Make'),
    model: z.string().nullable().describe('Model'),
    lensModel: z.string().nullable().describe('Lens model'),
    fNumber: z.number().meta({ format: 'double' }).nullable().describe('F number'),
    focalLength: z.number().meta({ format: 'double' }).nullable().describe('Focal length'),
    iso: z.int().nullable().describe('ISO'),
    exposureTime: z.string().nullable().describe('Exposure time'),
    profileDescription: z.string().nullable().describe('Profile description'),
    rating: z.int().nullable().describe('Rating'),
    fps: z.number().meta({ format: 'double' }).nullable().describe('FPS'),
    imageEncoding: ImageEncodingSchema.nullish(),
  })
  .meta({ id: 'SyncAssetExifV1' });

const SyncAssetMetadataV1Schema = z
  .object({
    assetId: z.uuidv4().describe('Asset ID'),
    key: z.string().describe('Key'),
    value: z.record(z.string(), z.unknown()).describe('Value'),
  })
  .meta({ id: 'SyncAssetMetadataV1' });

const SyncAssetMetadataDeleteV1Schema = z
  .object({
    assetId: z.uuidv4().describe('Asset ID'),
    key: z.string().describe('Key'),
  })
  .meta({ id: 'SyncAssetMetadataDeleteV1' });

const SyncAssetEditV1Schema = z
  .object({
    id: z.uuidv4().describe('Edit ID'),
    assetId: z.uuidv4().describe('Asset ID'),
    action: z.string().describe('Edit action; future values pass through unchanged'),
    parameters: z.record(z.string(), z.unknown()).describe('Edit parameters'),
    sequence: z.int().describe('Edit sequence'),
  })
  .meta({ id: 'SyncAssetEditV1' });

const SyncAssetEditDeleteV1Schema = z
  .object({ editId: z.uuidv4().describe('Edit ID') })
  .meta({ id: 'SyncAssetEditDeleteV1' });

@ExtraModel()
class SyncAssetDeleteV1 extends createZodDto(SyncAssetDeleteV1Schema) {}
@ExtraModel()
export class SyncAssetExifV1 extends createZodDto(SyncAssetExifV1Schema) {}
@ExtraModel()
class SyncAssetMetadataV1 extends createZodDto(SyncAssetMetadataV1Schema) {}
@ExtraModel()
class SyncAssetMetadataDeleteV1 extends createZodDto(SyncAssetMetadataDeleteV1Schema) {}
@ExtraModel()
export class SyncAssetEditV1 extends createZodDto(SyncAssetEditV1Schema) {}
@ExtraModel()
class SyncAssetEditDeleteV1 extends createZodDto(SyncAssetEditDeleteV1Schema) {}

const SyncAlbumDeleteV1Schema = z
  .object({ albumId: z.uuidv4().describe('Album ID') })
  .meta({ id: 'SyncAlbumDeleteV1' });

const SyncAlbumUserDeleteV1Schema = z
  .object({
    albumId: z.uuidv4().describe('Album ID'),
    userId: z.uuidv4().describe('User ID'),
  })
  .meta({ id: 'SyncAlbumUserDeleteV1' });

const SyncAlbumUserV1Schema = z
  .object({
    albumId: z.uuidv4().describe('Album ID'),
    userId: z.uuidv4().describe('User ID'),
    role: AlbumUserRoleSchema,
  })
  .meta({ id: 'SyncAlbumUserV1' });

const SyncAlbumV1Schema = z
  .object({
    id: z.uuidv4().describe('Album ID'),
    ownerId: z.uuidv4().describe('Owner ID'),
    name: z.string().describe('Album name'),
    description: z.string().describe('Album description'),
    createdAt: isoDatetimeToDate.describe('Created at'),
    updatedAt: isoDatetimeToDate.describe('Updated at'),
    thumbnailAssetId: z.string().nullable().describe('Thumbnail asset ID'),
    isActivityEnabled: z.boolean().describe('Is activity enabled'),
    order: AssetOrderSchema,
  })
  .meta({ id: 'SyncAlbumV1' });

const SyncAlbumV2Schema = z
  .object({
    id: z.uuidv4().describe('Album ID'),
    name: z.string().describe('Album name'),
    description: z.string().describe('Album description'),
    createdAt: isoDatetimeToDate.describe('Created at'),
    updatedAt: isoDatetimeToDate.describe('Updated at'),
    thumbnailAssetId: z.string().nullable().describe('Thumbnail asset ID'),
    isActivityEnabled: z.boolean().describe('Is activity enabled'),
    order: AssetOrderSchema,
  })
  .meta({ id: 'SyncAlbumV2' });

const SyncAlbumV3Schema = SyncAlbumV2Schema.extend({
  parentId: z.uuid().nullable(),
  kind: AlbumKindSchema,
  icon: z.string().nullable(),
  sortOrder: z.number().meta({ format: 'double' }).nullable(),
  deletedAt: isoDatetimeToDate.nullable(),
}).meta({ id: 'SyncAlbumV3' });

const SyncAlbumToAssetV1Schema = z
  .object({
    albumId: z.uuidv4().describe('Album ID'),
    assetId: z.uuidv4().describe('Asset ID'),
  })
  .meta({ id: 'SyncAlbumToAssetV1' });

const SyncAlbumToAssetDeleteV1Schema = z
  .object({
    albumId: z.uuidv4().describe('Album ID'),
    assetId: z.uuidv4().describe('Asset ID'),
  })
  .meta({ id: 'SyncAlbumToAssetDeleteV1' });

@ExtraModel()
class SyncAlbumDeleteV1 extends createZodDto(SyncAlbumDeleteV1Schema) {}
@ExtraModel()
class SyncAlbumUserDeleteV1 extends createZodDto(SyncAlbumUserDeleteV1Schema) {}
@ExtraModel()
class SyncAlbumUserV1 extends createZodDto(SyncAlbumUserV1Schema) {}
@ExtraModel()
class SyncAlbumV1 extends createZodDto(SyncAlbumV1Schema) {}
@ExtraModel()
class SyncAlbumV2 extends createZodDto(SyncAlbumV2Schema) {}
@ExtraModel()
class SyncAlbumV3 extends createZodDto(SyncAlbumV3Schema) {}
@ExtraModel()
class SyncAlbumToAssetV1 extends createZodDto(SyncAlbumToAssetV1Schema) {}
@ExtraModel()
class SyncAlbumToAssetDeleteV1 extends createZodDto(SyncAlbumToAssetDeleteV1Schema) {}

export function syncAlbumV2ToV1(
  albumV2: SyncAlbumV2,
  albumUsers: { userId: string; role: AlbumUserRole }[],
): SyncAlbumV1 {
  const owner = albumUsers.find(({ role }) => role === AlbumUserRole.Owner)!;

  return { ...albumV2, ownerId: owner.userId };
}

const SyncMemoryV1Schema = z
  .object({
    id: z.uuidv4().describe('Memory ID'),
    createdAt: isoDatetimeToDate.describe('Created at'),
    updatedAt: isoDatetimeToDate.describe('Updated at'),
    deletedAt: isoDatetimeToDate.nullable().describe('Deleted at'),
    ownerId: z.uuidv4().describe('Owner ID'),
    type: MemoryTypeSchema,
    data: z.record(z.string(), z.unknown()).describe('Data'),
    isSaved: z.boolean().describe('Is saved'),
    memoryAt: isoDatetimeToDate.describe('Memory at'),
    seenAt: isoDatetimeToDate.nullable().describe('Seen at'),
    showAt: isoDatetimeToDate.nullable().describe('Show at'),
    hideAt: isoDatetimeToDate.nullable().describe('Hide at'),
  })
  .meta({ id: 'SyncMemoryV1' });

const SyncMemoryDeleteV1Schema = z
  .object({ memoryId: z.uuidv4().describe('Memory ID') })
  .meta({ id: 'SyncMemoryDeleteV1' });

const SyncMemoryAssetV1Schema = z
  .object({
    memoryId: z.uuidv4().describe('Memory ID'),
    assetId: z.uuidv4().describe('Asset ID'),
  })
  .meta({ id: 'SyncMemoryAssetV1' });

const SyncMemoryAssetDeleteV1Schema = z
  .object({
    memoryId: z.uuidv4().describe('Memory ID'),
    assetId: z.uuidv4().describe('Asset ID'),
  })
  .meta({ id: 'SyncMemoryAssetDeleteV1' });

const SyncStackV1Schema = z
  .object({
    id: z.uuidv4().describe('Stack ID'),
    createdAt: isoDatetimeToDate.describe('Created at'),
    updatedAt: isoDatetimeToDate.describe('Updated at'),
    primaryAssetId: z.uuidv4().describe('Primary asset ID'),
    ownerId: z.uuidv4().describe('Owner ID'),
  })
  .meta({ id: 'SyncStackV1' });

const SyncStackDeleteV1Schema = z
  .object({ stackId: z.uuidv4().describe('Stack ID') })
  .meta({ id: 'SyncStackDeleteV1' });

const SyncPersonV1Schema = z
  .object({
    id: z.uuidv4().describe('Person ID'),
    createdAt: isoDatetimeToDate.describe('Created at'),
    updatedAt: isoDatetimeToDate.describe('Updated at'),
    ownerId: z.uuidv4().describe('Owner ID'),
    name: z.string().describe('Person name'),
    birthDate: isoDatetimeToDate.nullable().describe('Birth date'),
    isHidden: z.boolean().describe('Is hidden'),
    isFavorite: z.boolean().describe('Is favorite'),
    color: z.string().nullable().describe('Color'),
    faceAssetId: z.string().nullable().describe('Face asset ID'),
  })
  .meta({ id: 'SyncPersonV1' });

const SyncPersonDeleteV1Schema = z
  .object({ personId: z.uuidv4().describe('Person ID') })
  .meta({ id: 'SyncPersonDeleteV1' });

const SyncAssetFaceV1Schema = z
  .object({
    id: z.uuidv4().describe('Asset face ID'),
    assetId: z.uuidv4().describe('Asset ID'),
    personId: z.string().nullable().describe('Person ID'),
    imageWidth: z.int().describe('Image width'),
    imageHeight: z.int().describe('Image height'),
    boundingBoxX1: z.int().describe('Bounding box X1'),
    boundingBoxY1: z.int().describe('Bounding box Y1'),
    boundingBoxX2: z.int().describe('Bounding box X2'),
    boundingBoxY2: z.int().describe('Bounding box Y2'),
    sourceType: z.string().describe('Source type'),
  })
  .meta({ id: 'SyncAssetFaceV1' });

// same shape as V2, but scoped to the whole cluster group instead of the user's own assets
const SyncAssetFaceV3Schema = SyncAssetFaceV1Schema.extend({
  deletedAt: isoDatetimeToDate.nullable().describe('Face deleted at'),
  isVisible: z.boolean().describe('Is the face visible in the asset'),
}).meta({ id: 'SyncAssetFaceV3' });

// Keep the published V2 SDK model available for existing fork clients.
const SyncAssetFaceV2Schema = SyncAssetFaceV3Schema.meta({ id: 'SyncAssetFaceV2' });

const SyncAssetFaceDeleteV1Schema = z
  .object({ assetFaceId: z.uuidv4().describe('Asset face ID') })
  .meta({ id: 'SyncAssetFaceDeleteV1' });

const SyncUserMetadataV1Schema = z
  .object({
    userId: z.uuidv4().describe('User ID'),
    key: UserMetadataKeySchema,
    value: z.record(z.string(), z.unknown()).describe('User metadata value'),
  })
  .meta({ id: 'SyncUserMetadataV1' });

const SyncUserMetadataDeleteV1Schema = z
  .object({
    userId: z.uuidv4().describe('User ID'),
    key: UserMetadataKeySchema,
  })
  .meta({ id: 'SyncUserMetadataDeleteV1' });

const SyncPinnedCollectionsV1Schema = PinnedCollectionsResponseSchema.extend({ userId: z.uuidv4() }).meta({
  id: 'SyncPinnedCollectionsV1',
});

@ExtraModel()
class SyncPinnedCollectionsV1 extends createZodDto(SyncPinnedCollectionsV1Schema) {}

const SyncAckV1Schema = z.object({}).meta({ id: 'SyncAckV1' });
const SyncResetV1Schema = z.object({}).meta({ id: 'SyncResetV1' });
const SyncCompleteV1Schema = z.object({}).meta({ id: 'SyncCompleteV1' });

@ExtraModel()
class SyncMemoryV1 extends createZodDto(SyncMemoryV1Schema) {}
@ExtraModel()
class SyncMemoryDeleteV1 extends createZodDto(SyncMemoryDeleteV1Schema) {}
@ExtraModel()
class SyncMemoryAssetV1 extends createZodDto(SyncMemoryAssetV1Schema) {}
@ExtraModel()
class SyncMemoryAssetDeleteV1 extends createZodDto(SyncMemoryAssetDeleteV1Schema) {}

const SyncAssetOcrV1Schema = z
  .object({
    id: z.uuidv4().describe('OCR entry ID'),
    assetId: z.uuidv4().describe('Asset ID'),

    x1: z.number().meta({ format: 'double' }).describe('Top-left X coordinate (normalized 0–1)'),
    y1: z.number().meta({ format: 'double' }).describe('Top-left Y coordinate (normalized 0–1)'),
    x2: z.number().meta({ format: 'double' }).describe('Top-right X coordinate (normalized 0–1)'),
    y2: z.number().meta({ format: 'double' }).describe('Top-right Y coordinate (normalized 0–1)'),
    x3: z.number().meta({ format: 'double' }).describe('Bottom-right X coordinate (normalized 0–1)'),
    y3: z.number().meta({ format: 'double' }).describe('Bottom-right Y coordinate (normalized 0–1)'),
    x4: z.number().meta({ format: 'double' }).describe('Bottom-left X coordinate (normalized 0–1)'),
    y4: z.number().meta({ format: 'double' }).describe('Bottom-left Y coordinate (normalized 0–1)'),

    boxScore: z.number().meta({ format: 'double' }).describe('Confidence score of the bounding box'),
    textScore: z.number().meta({ format: 'double' }).describe('Confidence score of the recognized text'),
    text: z.string().describe('Recognized text content'),
    isVisible: z.boolean().describe('Whether the OCR entry is visible'),
  })
  .meta({ id: 'SyncAssetOcrV1' });

const SyncAssetOcrDeleteV1Schema = z
  .object({
    id: z.string().describe('Audit row ID of the deleted OCR entry'),
    assetId: z.string().describe('Original asset ID of the deleted OCR entry'),
    deletedAt: isoDatetimeToDate.describe('Timestamp when the OCR entry was deleted'),
  })
  .meta({ id: 'SyncAssetOcrDeleteV1' });

@ExtraModel()
class SyncAssetOcrV1 extends createZodDto(SyncAssetOcrV1Schema) {}

@ExtraModel()
class SyncAssetOcrDeleteV1 extends createZodDto(SyncAssetOcrDeleteV1Schema) {}
@ExtraModel()
class SyncStackV1 extends createZodDto(SyncStackV1Schema) {}
@ExtraModel()
class SyncStackDeleteV1 extends createZodDto(SyncStackDeleteV1Schema) {}
@ExtraModel()
class SyncPersonV1 extends createZodDto(SyncPersonV1Schema) {}
@ExtraModel()
class SyncPersonDeleteV1 extends createZodDto(SyncPersonDeleteV1Schema) {}
@ExtraModel()
class SyncAssetFaceV1 extends createZodDto(SyncAssetFaceV1Schema) {}
@ExtraModel()
class SyncAssetFaceV2 extends createZodDto(SyncAssetFaceV2Schema) {}
@ExtraModel()
class SyncAssetFaceV3 extends createZodDto(SyncAssetFaceV3Schema) {}
@ExtraModel()
class SyncAssetFaceDeleteV1 extends createZodDto(SyncAssetFaceDeleteV1Schema) {}
@ExtraModel()
class SyncUserMetadataV1 extends createZodDto(SyncUserMetadataV1Schema) {}
@ExtraModel()
class SyncUserMetadataDeleteV1 extends createZodDto(SyncUserMetadataDeleteV1Schema) {}
@ExtraModel()
class SyncAckV1 extends createZodDto(SyncAckV1Schema) {}
@ExtraModel()
class SyncResetV1 extends createZodDto(SyncResetV1Schema) {}
@ExtraModel()
class SyncCompleteV1 extends createZodDto(SyncCompleteV1Schema) {}

@ExtraModel()
class SyncPetV1 extends createZodDto(PetResponseSchema.meta({ id: 'SyncPetV1' })) {}
@ExtraModel()
class SyncSharedSpaceV1 extends createZodDto(
  z
    .object({
      id: z.uuid(),
      name: z.string(),
      description: z.string().nullable(),
      icon: z.string().nullable(),
      kind: z.literal('space'),
      createdAt: isoDatetimeToDate,
      updatedAt: isoDatetimeToDate,
    })
    .meta({ id: 'SyncSharedSpaceV1' }),
) {}
@ExtraModel()
class SyncSharedSpaceDeleteV1 extends createZodDto(
  z.object({ spaceId: z.uuid() }).meta({ id: 'SyncSharedSpaceDeleteV1' }),
) {}
@ExtraModel()
class SyncSharedSpaceMemberV1 extends createZodDto(
  z
    .object({
      spaceId: z.uuid(),
      userId: z.uuid(),
      role: AlbumUserRoleSchema,
      createdAt: isoDatetimeToDate,
      updatedAt: isoDatetimeToDate,
    })
    .describe('Accepted membership only; pending invitations confer no sync access')
    .meta({ id: 'SyncSharedSpaceMemberV1' }),
) {}
@ExtraModel()
class SyncSharedSpaceMemberDeleteV1 extends createZodDto(
  z.object({ spaceId: z.uuid(), userId: z.uuid() }).meta({ id: 'SyncSharedSpaceMemberDeleteV1' }),
) {}
@ExtraModel()
class SyncSharedSpaceAlbumV1 extends createZodDto(
  z
    .object({
      spaceId: z.uuid(),
      albumId: z.uuid(),
      name: z.string(),
      icon: z.string().nullable(),
      assetCount: z.number().int().nonnegative(),
      thumbnailAssetId: z.uuid().nullable(),
      linkedAt: isoDatetimeToDate,
    })
    .describe('Published album reference only; does not grant target AlbumRead access')
    .meta({ id: 'SyncSharedSpaceAlbumV1' }),
) {}
@ExtraModel()
class SyncSharedSpaceAlbumDeleteV1 extends createZodDto(
  z.object({ spaceId: z.uuid(), albumId: z.uuid() }).meta({ id: 'SyncSharedSpaceAlbumDeleteV1' }),
) {}
@ExtraModel()
class SyncSharedSpacePersonV1 extends createZodDto(
  z
    .object({
      id: z.uuid(),
      spaceId: z.uuid(),
      name: z.string(),
      coverAssetId: z.uuid().nullable(),
      assetCount: z.number().int().nonnegative(),
      linkedAt: isoDatetimeToDate,
    })
    .describe('Published link identity only; excludes the underlying private person')
    .meta({ id: 'SyncSharedSpacePersonV1' }),
) {}
@ExtraModel()
class SyncSharedSpacePersonDeleteV1 extends createZodDto(
  z.object({ spaceId: z.uuid(), id: z.uuid() }).meta({ id: 'SyncSharedSpacePersonDeleteV1' }),
) {}
@ExtraModel()
class SyncAlbumSourceLinkV1 extends createZodDto(
  AlbumSourceLinkResponseSchema.omit({ albumName: true }).meta({ id: 'SyncAlbumSourceLinkV1' }),
) {}
@ExtraModel()
class SyncAlbumSourceLinkDeleteV1 extends createZodDto(
  z.object({ linkId: z.uuid() }).meta({ id: 'SyncAlbumSourceLinkDeleteV1' }),
) {}
@ExtraModel()
class SyncPetDeleteV1 extends createZodDto(z.object({ petId: z.uuid() }).meta({ id: 'SyncPetDeleteV1' })) {}
@ExtraModel()
class SyncPetObservationV1 extends createZodDto(PetObservationResponseSchema.meta({ id: 'SyncPetObservationV1' })) {}
@ExtraModel()
class SyncPetObservationDeleteV1 extends createZodDto(
  z.object({ observationId: z.uuid(), petId: z.uuid(), assetId: z.uuid() }).meta({ id: 'SyncPetObservationDeleteV1' }),
) {}

const SyncTagV1Schema = z
  .object({
    id: z.uuid(),
    userId: z.uuid(),
    value: z.string(),
    parentId: z.uuid().nullable(),
    color: z.string().nullable(),
    createdAt: isoDatetimeToDate,
    updatedAt: isoDatetimeToDate,
  })
  .meta({ id: 'SyncTagV1' });
const SyncTagDeleteV1Schema = z.object({ tagId: z.uuid() }).meta({ id: 'SyncTagDeleteV1' });
const SyncAssetTagV1Schema = z.object({ tagId: z.uuid(), assetId: z.uuid() }).meta({ id: 'SyncAssetTagV1' });
@ExtraModel()
class SyncTagV1 extends createZodDto(SyncTagV1Schema) {}
@ExtraModel()
class SyncTagDeleteV1 extends createZodDto(SyncTagDeleteV1Schema) {}
@ExtraModel()
class SyncAssetTagV1 extends createZodDto(SyncAssetTagV1Schema) {}
@ExtraModel()
class SyncAssetTagDeleteV1 extends createZodDto(SyncAssetTagV1Schema.meta({ id: 'SyncAssetTagDeleteV1' })) {}

@ExtraModel()
class SyncDuplicateGroupV1 extends createZodDto(
  z.object({ groupId: z.uuid(), assetIds: z.array(z.uuid()).min(2) }).meta({ id: 'SyncDuplicateGroupV1' }),
) {}
@ExtraModel()
class SyncDuplicateGroupDeleteV1 extends createZodDto(
  z.object({ groupId: z.uuid() }).meta({ id: 'SyncDuplicateGroupDeleteV1' }),
) {}

@ExtraModel()
class SyncPinnedCollectionV1 extends createZodDto(
  PinnedCollectionSchema.extend({
    targetId: z.string(),
    unavailable: z.literal(false),
    position: z
      .int()
      .min(0)
      .max(PIN_LIMIT - 1),
  }).meta({
    id: 'SyncPinnedCollectionV1',
    description:
      'Current authorized pin hydration at its complete-list position. Unavailable pins retain their V1 snapshot placeholder but have no event hydration.',
  }),
) {}
@ExtraModel()
class SyncPinnedCollectionDeleteV1 extends createZodDto(
  z.object({ pinId: z.uuid() }).meta({
    id: 'SyncPinnedCollectionDeleteV1',
    description:
      'Remove available mirror hydration only. The opaque stored pin may remain as an unavailable V1 snapshot placeholder.',
  }),
) {}

@ExtraModel()
class SyncAssetTrashStateV1 extends createZodDto(
  z
    .object({ assetId: z.uuid(), deletedAt: isoDatetimeToDate, status: z.enum(AssetStatus), isOffline: z.boolean() })
    .meta({ id: 'SyncAssetTrashStateV1' }),
) {}
@ExtraModel()
class SyncAssetTrashStateDeleteV1 extends createZodDto(
  z.object({ assetId: z.uuid() }).meta({ id: 'SyncAssetTrashStateDeleteV1' }),
) {}

/** Each grant replaces the source-scoped asset; unrelated grants are retained. */
@ExtraModel()
class SyncAlbumAssetAccessV1 extends createZodDto(
  z.object({ albumId: z.uuid(), asset: SyncAssetV2Schema }).meta({ id: 'SyncAlbumAssetAccessV1' }),
) {}
@ExtraModel()
class SyncPartnerAssetAccessV1 extends createZodDto(
  z.object({ sharedById: z.uuid(), asset: SyncAssetV2Schema }).meta({ id: 'SyncPartnerAssetAccessV1' }),
) {}
@ExtraModel()
class SyncAlbumAssetAccessDeleteV1 extends createZodDto(
  z.object({ albumId: z.uuid(), assetId: z.uuid() }).meta({
    id: 'SyncAlbumAssetAccessDeleteV1',
    description:
      'Drop this album-source asset and its descriptive mirror data, preserving independently authorized sources.',
  }),
) {}
@ExtraModel()
class SyncPartnerAssetAccessDeleteV1 extends createZodDto(
  z.object({ sharedById: z.uuid(), assetId: z.uuid() }).meta({
    id: 'SyncPartnerAssetAccessDeleteV1',
    description:
      'Drop this partner-source asset and its descriptive mirror data, preserving independently authorized sources.',
  }),
) {}

export type SyncItem = {
  [SyncEntityType.AlbumAssetAccessV1]: SyncAlbumAssetAccessV1;
  [SyncEntityType.AlbumAssetAccessDeleteV1]: SyncAlbumAssetAccessDeleteV1;
  [SyncEntityType.PartnerAssetAccessV1]: SyncPartnerAssetAccessV1;
  [SyncEntityType.PartnerAssetAccessDeleteV1]: SyncPartnerAssetAccessDeleteV1;
  [SyncEntityType.PinnedCollectionV1]: SyncPinnedCollectionV1;
  [SyncEntityType.PinnedCollectionDeleteV1]: SyncPinnedCollectionDeleteV1;
  [SyncEntityType.AssetTrashStateV1]: SyncAssetTrashStateV1;
  [SyncEntityType.AssetTrashStateDeleteV1]: SyncAssetTrashStateDeleteV1;
  [SyncEntityType.DuplicateGroupV1]: SyncDuplicateGroupV1;
  [SyncEntityType.DuplicateGroupDeleteV1]: SyncDuplicateGroupDeleteV1;
  [SyncEntityType.SharedSpaceAlbumV1]: SyncSharedSpaceAlbumV1;
  [SyncEntityType.SharedSpaceAlbumDeleteV1]: SyncSharedSpaceAlbumDeleteV1;
  [SyncEntityType.SharedSpacePersonV1]: SyncSharedSpacePersonV1;
  [SyncEntityType.SharedSpacePersonDeleteV1]: SyncSharedSpacePersonDeleteV1;
  [SyncEntityType.SharedSpaceV1]: SyncSharedSpaceV1;
  [SyncEntityType.SharedSpaceDeleteV1]: SyncSharedSpaceDeleteV1;
  [SyncEntityType.SharedSpaceMemberV1]: SyncSharedSpaceMemberV1;
  [SyncEntityType.SharedSpaceMemberDeleteV1]: SyncSharedSpaceMemberDeleteV1;
  [SyncEntityType.PetV1]: SyncPetV1;
  [SyncEntityType.PetDeleteV1]: SyncPetDeleteV1;
  [SyncEntityType.AlbumSourceLinkV1]: SyncAlbumSourceLinkV1;
  [SyncEntityType.AlbumSourceLinkDeleteV1]: SyncAlbumSourceLinkDeleteV1;
  [SyncEntityType.PetObservationV1]: SyncPetObservationV1;
  [SyncEntityType.PetObservationDeleteV1]: SyncPetObservationDeleteV1;
  [SyncEntityType.TagV1]: SyncTagV1;
  [SyncEntityType.TagDeleteV1]: SyncTagDeleteV1;
  [SyncEntityType.AssetTagV1]: SyncAssetTagV1;
  [SyncEntityType.AssetTagDeleteV1]: SyncAssetTagDeleteV1;
  [SyncEntityType.AuthUserV1]: SyncAuthUserV1;
  [SyncEntityType.AuthUserV2]: SyncAuthUserV2;
  [SyncEntityType.UserV1]: SyncUserV1;
  [SyncEntityType.UserDeleteV1]: SyncUserDeleteV1;
  [SyncEntityType.PartnerV1]: SyncPartnerV1;
  [SyncEntityType.PartnerDeleteV1]: SyncPartnerDeleteV1;
  [SyncEntityType.AssetV2]: SyncAssetV2;
  [SyncEntityType.AssetV3]: SyncAssetV2;
  [SyncEntityType.AssetBootstrapV1]: SyncAssetV2;
  [SyncEntityType.AssetDeleteV2]: SyncAssetDeleteV1;
  [SyncEntityType.AssetDeleteV1]: SyncAssetDeleteV1;
  [SyncEntityType.AssetMetadataV1]: SyncAssetMetadataV1;
  [SyncEntityType.AssetMetadataDeleteV1]: SyncAssetMetadataDeleteV1;
  [SyncEntityType.AssetExifV1]: SyncAssetExifV1;
  [SyncEntityType.AssetOcrV1]: SyncAssetOcrV1;
  [SyncEntityType.AssetOcrDeleteV1]: SyncAssetOcrDeleteV1;
  [SyncEntityType.AssetEditV1]: SyncAssetEditV1;
  [SyncEntityType.AssetEditDeleteV1]: SyncAssetEditDeleteV1;
  [SyncEntityType.PartnerAssetV2]: SyncAssetV2;
  [SyncEntityType.PartnerAssetBackfillV2]: SyncAssetV2;
  [SyncEntityType.PartnerAssetDeleteV1]: SyncAssetDeleteV1;
  [SyncEntityType.PartnerAssetExifV1]: SyncAssetExifV1;
  [SyncEntityType.PartnerAssetExifBackfillV1]: SyncAssetExifV1;
  [SyncEntityType.AlbumV1]: SyncAlbumV1;
  [SyncEntityType.AlbumV2]: SyncAlbumV2;
  [SyncEntityType.AlbumV3]: SyncAlbumV3;
  [SyncEntityType.AlbumBootstrapV1]: SyncAlbumV3;
  [SyncEntityType.AlbumDeleteV2]: SyncAlbumDeleteV1;
  [SyncEntityType.AlbumDeleteV1]: SyncAlbumDeleteV1;
  [SyncEntityType.AlbumUserV1]: SyncAlbumUserV1;
  [SyncEntityType.AlbumUserBackfillV1]: SyncAlbumUserV1;
  [SyncEntityType.AlbumUserDeleteV1]: SyncAlbumUserDeleteV1;
  [SyncEntityType.AlbumAssetCreateV2]: SyncAssetV2;
  [SyncEntityType.AlbumAssetUpdateV2]: SyncAssetV2;
  [SyncEntityType.AlbumAssetBackfillV2]: SyncAssetV2;
  [SyncEntityType.AlbumAssetExifCreateV1]: SyncAssetExifV1;
  [SyncEntityType.AlbumAssetExifUpdateV1]: SyncAssetExifV1;
  [SyncEntityType.AlbumAssetExifBackfillV1]: SyncAssetExifV1;
  [SyncEntityType.AlbumToAssetV1]: SyncAlbumToAssetV1;
  [SyncEntityType.AlbumToAssetBackfillV1]: SyncAlbumToAssetV1;
  [SyncEntityType.AlbumToAssetDeleteV1]: SyncAlbumToAssetDeleteV1;
  [SyncEntityType.MemoryV1]: SyncMemoryV1;
  [SyncEntityType.MemoryDeleteV1]: SyncMemoryDeleteV1;
  [SyncEntityType.MemoryToAssetV1]: SyncMemoryAssetV1;
  [SyncEntityType.MemoryToAssetDeleteV1]: SyncMemoryAssetDeleteV1;
  [SyncEntityType.StackV1]: SyncStackV1;
  [SyncEntityType.StackDeleteV1]: SyncStackDeleteV1;
  [SyncEntityType.PartnerStackBackfillV1]: SyncStackV1;
  [SyncEntityType.PartnerStackDeleteV1]: SyncStackDeleteV1;
  [SyncEntityType.PartnerStackV1]: SyncStackV1;
  [SyncEntityType.PersonV1]: SyncPersonV1;
  [SyncEntityType.PersonDeleteV1]: SyncPersonDeleteV1;
  [SyncEntityType.AssetFaceV1]: SyncAssetFaceV1;
  [SyncEntityType.AssetFaceV2]: SyncAssetFaceV2;
  [SyncEntityType.AssetFaceV3]: SyncAssetFaceV3;
  [SyncEntityType.AssetFaceDeleteV1]: SyncAssetFaceDeleteV1;
  [SyncEntityType.UserMetadataV1]: SyncUserMetadataV1;
  [SyncEntityType.PinnedCollectionsV1]: SyncPinnedCollectionsV1;
  [SyncEntityType.UserMetadataDeleteV1]: SyncUserMetadataDeleteV1;
  [SyncEntityType.SyncAckV1]: SyncAckV1;
  [SyncEntityType.SyncCompleteV1]: SyncCompleteV1;
  [SyncEntityType.SyncResetV1]: SyncResetV1;
};

const SyncStreamSchema = z
  .object({
    types: z.array(SyncRequestTypeSchema).describe('Sync request types'),
    reset: z.boolean().optional().describe('Reset sync state'),
  })
  .meta({ id: 'SyncStreamDto' });

// Freeze the existing GET response contract. New sync families belong to the V2 ACK view.
const LegacySyncAckEntityTypeSchema = z.enum([
  SyncEntityType.AlbumAssetAccessV1,
  SyncEntityType.AlbumAssetAccessDeleteV1,
  SyncEntityType.PartnerAssetAccessV1,
  SyncEntityType.PartnerAssetAccessDeleteV1,
  SyncEntityType.PinnedCollectionV1,
  SyncEntityType.PinnedCollectionDeleteV1,
  SyncEntityType.AssetTrashStateV1,
  SyncEntityType.AssetTrashStateDeleteV1,
  SyncEntityType.DuplicateGroupV1,
  SyncEntityType.DuplicateGroupDeleteV1,
  SyncEntityType.SharedSpaceV1,
  SyncEntityType.SharedSpaceDeleteV1,
  SyncEntityType.SharedSpaceMemberV1,
  SyncEntityType.SharedSpaceMemberDeleteV1,
  SyncEntityType.SharedSpaceAlbumV1,
  SyncEntityType.SharedSpaceAlbumDeleteV1,
  SyncEntityType.SharedSpacePersonV1,
  SyncEntityType.SharedSpacePersonDeleteV1,
  SyncEntityType.PetV1,
  SyncEntityType.PetDeleteV1,
  SyncEntityType.PetObservationV1,
  SyncEntityType.PetObservationDeleteV1,
  SyncEntityType.TagV1,
  SyncEntityType.TagDeleteV1,
  SyncEntityType.AssetTagV1,
  SyncEntityType.AssetTagDeleteV1,
  SyncEntityType.AuthUserV1,
  SyncEntityType.AuthUserV2,
  SyncEntityType.UserV1,
  SyncEntityType.UserDeleteV1,
  SyncEntityType.AssetV1,
  SyncEntityType.AssetV2,
  SyncEntityType.AssetV3,
  SyncEntityType.AssetBootstrapV1,
  SyncEntityType.AssetDeleteV2,
  SyncEntityType.AssetDeleteV1,
  SyncEntityType.AssetExifV1,
  SyncEntityType.AssetEditV1,
  SyncEntityType.AssetEditDeleteV1,
  SyncEntityType.AssetMetadataV1,
  SyncEntityType.AssetMetadataDeleteV1,
  SyncEntityType.AssetOcrV1,
  SyncEntityType.AssetOcrDeleteV1,
  SyncEntityType.PartnerV1,
  SyncEntityType.PartnerDeleteV1,
  SyncEntityType.PartnerAssetV1,
  SyncEntityType.PartnerAssetV2,
  SyncEntityType.PartnerAssetBackfillV1,
  SyncEntityType.PartnerAssetBackfillV2,
  SyncEntityType.PartnerAssetDeleteV1,
  SyncEntityType.PartnerAssetExifV1,
  SyncEntityType.PartnerAssetExifBackfillV1,
  SyncEntityType.PartnerStackBackfillV1,
  SyncEntityType.PartnerStackDeleteV1,
  SyncEntityType.PartnerStackV1,
  SyncEntityType.AlbumV1,
  SyncEntityType.AlbumV2,
  SyncEntityType.AlbumV3,
  SyncEntityType.AlbumBootstrapV1,
  SyncEntityType.AlbumDeleteV2,
  SyncEntityType.AlbumDeleteV1,
  SyncEntityType.AlbumUserV1,
  SyncEntityType.AlbumUserBackfillV1,
  SyncEntityType.AlbumUserDeleteV1,
  SyncEntityType.AlbumAssetCreateV1,
  SyncEntityType.AlbumAssetCreateV2,
  SyncEntityType.AlbumAssetUpdateV1,
  SyncEntityType.AlbumAssetUpdateV2,
  SyncEntityType.AlbumAssetBackfillV1,
  SyncEntityType.AlbumAssetBackfillV2,
  SyncEntityType.AlbumAssetExifCreateV1,
  SyncEntityType.AlbumAssetExifUpdateV1,
  SyncEntityType.AlbumAssetExifBackfillV1,
  SyncEntityType.AlbumToAssetV1,
  SyncEntityType.AlbumToAssetDeleteV1,
  SyncEntityType.AlbumToAssetBackfillV1,
  SyncEntityType.MemoryV1,
  SyncEntityType.MemoryDeleteV1,
  SyncEntityType.MemoryToAssetV1,
  SyncEntityType.MemoryToAssetDeleteV1,
  SyncEntityType.StackV1,
  SyncEntityType.StackDeleteV1,
  SyncEntityType.PersonV1,
  SyncEntityType.PersonDeleteV1,
  SyncEntityType.AssetFaceV1,
  SyncEntityType.AssetFaceV2,
  SyncEntityType.AssetFaceV3,
  SyncEntityType.AssetFaceDeleteV1,
  SyncEntityType.UserMetadataV1,
  SyncEntityType.PinnedCollectionsV1,
  SyncEntityType.UserMetadataDeleteV1,
  SyncEntityType.SyncAckV1,
  SyncEntityType.SyncResetV1,
  SyncEntityType.SyncCompleteV1,
]);

const SyncAckSchema = z
  .object({
    type: LegacySyncAckEntityTypeSchema,
    ack: z.string().describe('Acknowledgment ID'),
  })
  .meta({ id: 'SyncAckDto' });

const SyncAckV2Schema = z
  .object({
    type: SyncEntityTypeSchema,
    ack: z.string().describe('Acknowledgment ID'),
  })
  .meta({ id: 'SyncAckV2Dto' });

const SyncAckSetSchema = z
  .object({
    acks: z.array(z.string()).max(1000).describe('Acknowledgment IDs (max 1000)'),
  })
  .meta({ id: 'SyncAckSetDto' });

const SyncAckDeleteSchema = z
  .object({
    types: z.array(SyncEntityTypeSchema).optional().describe('Sync entity types to delete acks for'),
  })
  .meta({ id: 'SyncAckDeleteDto' });

export class SyncStreamDto extends createZodDto(SyncStreamSchema) {}
export class SyncAckDto extends createZodDto(SyncAckSchema) {}
export class SyncAckV2Dto extends createZodDto(SyncAckV2Schema) {}
export class SyncAckSetDto extends createZodDto(SyncAckSetSchema) {}
export class SyncAckDeleteDto extends createZodDto(SyncAckDeleteSchema) {}
