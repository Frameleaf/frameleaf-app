import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import type { MaybeDehydrated, UserMetadataItem } from 'src/types.js';
import { User, UserAdmin } from 'src/database.js';
import { HistoryBuilder } from 'src/decorators.js';
import { pinCodeRegex } from 'src/dtos/auth.dto.js';
import {
  AdminAuditActionSchema,
  UserAvatarColor,
  UserAvatarColorSchema,
  UserMetadataKey,
  UserStatusSchema,
} from 'src/enum.js';
import { asDateTimeString } from 'src/utils/date.js';
import { isoDatetimeToDate, sanitizeFilename, stringToBool, toEmail } from 'src/validation.js';

export const UserUpdateMeSchema = z
  .object({
    email: toEmail.optional().describe('User email'),
    password: z
      .string()
      .optional()
      .describe('User password (deprecated, use change password endpoint)')
      .meta({ deprecated: true }),
    name: z.string().optional().describe('User name'),
    avatarColor: UserAvatarColorSchema.nullish(),
  })
  .meta({ id: 'UserUpdateMeDto' });

export class UserUpdateMeDto extends createZodDto(UserUpdateMeSchema) {}

export const UserResponseSchema = z
  .object({
    id: z.uuidv4().describe('User ID'),
    name: z.string().describe('User name'),
    email: toEmail.describe('User email'),
    profileImagePath: z.string().describe('Profile image path'),
    avatarColor: UserAvatarColorSchema,
    // TODO: use `isoDatetimeToDate` when using `ZodSerializerDto` on the controllers.
    profileChangedAt: z.string().meta({ format: 'date-time' }).describe('Profile change date'),
  })
  .meta({ id: 'UserResponseDto' });

export class UserResponseDto extends createZodDto(UserResponseSchema) {}

/**
 * FL-156: a person's own Frameleaf supporter key (`FL-I…`), as it is shown again: its kind, the last
 * four symbols and when it was activated. The key itself is never returned. The schema keeps the
 * `UserLicense` id; the shape replaced the previous product key's (a protocol change for the apps).
 */
export const UserSupporterSchema = z
  .object({
    kind: z.literal('individual').describe('Supporter key kind; personal keys are always individual'),
    keyHint: z.string().describe('Last four symbols of the key'),
    activatedAt: isoDatetimeToDate.describe('Activation date'),
  })
  .meta({ id: 'UserLicense' });
export const UserLicenseSchema = UserSupporterSchema;

const emailToAvatarColor = (email: string): UserAvatarColor => {
  const values = Object.values(UserAvatarColor);
  const randomIndex = Math.floor(
    [...email].map((letter) => letter.codePointAt(0) ?? 0).reduce((a, b) => a + b, 0) % values.length,
  );
  return values[randomIndex];
};

export const mapUser = (entity: MaybeDehydrated<User | UserAdmin>): UserResponseDto => {
  return {
    id: entity.id,
    email: entity.email,
    name: entity.name,
    profileImagePath: entity.profileImagePath,
    avatarColor: entity.avatarColor ?? emailToAvatarColor(entity.email),
    profileChangedAt: asDateTimeString(entity.profileChangedAt),
  };
};

const UserAdminSearchSchema = z
  .object({
    withDeleted: stringToBool.optional().describe('Include deleted users'),
    id: z.uuidv4().optional().describe('User ID filter'),
  })
  .meta({ id: 'UserAdminSearchDto' });

export class UserAdminSearchDto extends createZodDto(UserAdminSearchSchema) {}

export const UserAdminCreateSchema = z
  .object({
    email: toEmail.describe('User email'),
    password: z.string().describe('User password'),
    name: z.string().describe('User name'),
    avatarColor: UserAvatarColorSchema.nullish(),
    pinCode: z.string().regex(pinCodeRegex).nullable().optional().describe('PIN code').meta({ example: '123456' }),
    storageLabel: z.string().pipe(sanitizeFilename).nullish().describe('Storage label'),
    quotaSizeInBytes: z.int().min(0).nullish().describe('Storage quota in bytes'),
    shouldChangePassword: z.boolean().optional().describe('Require password change on next login'),
    notify: z.boolean().optional().describe('Send notification email'),
    isAdmin: z.boolean().optional().describe('Grant admin privileges'),
  })
  .meta({ id: 'UserAdminCreateDto' });

export class UserAdminCreateDto extends createZodDto(UserAdminCreateSchema) {}

const UserAdminUpdateSchema = z
  .object({
    email: toEmail.optional().describe('User email'),
    password: z.string().optional().describe('User password'),
    pinCode: z.string().regex(pinCodeRegex).nullable().optional().describe('PIN code').meta({ example: '123456' }),
    name: z.string().optional().describe('User name'),
    avatarColor: UserAvatarColorSchema.nullish(),
    storageLabel: z.string().pipe(sanitizeFilename).nullish().describe('Storage label'),
    shouldChangePassword: z.boolean().optional().describe('Require password change on next login'),
    quotaSizeInBytes: z.int().min(0).nullish().describe('Storage quota in bytes'),
    isAdmin: z.boolean().optional().describe('Grant admin privileges'),
  })
  .meta({ id: 'UserAdminUpdateDto' });

export class UserAdminUpdateDto extends createZodDto(UserAdminUpdateSchema) {}

const UserAdminDeleteSchema = z
  .object({
    force: z.boolean().optional().describe('Force delete even if user has assets'),
  })
  .meta({ id: 'UserAdminDeleteDto' });

export class UserAdminDeleteDto extends createZodDto(UserAdminDeleteSchema) {}

/**
 * FL-76: an administrator revoking one of an account's signed-in devices. `sessionId` alone is
 * not enough to scope the request to the account named in the URL, so the service checks the
 * session actually belongs to `id` before deleting it.
 */
const UserAdminSessionParamSchema = z.object({
  id: z.uuidv4(),
  sessionId: z.uuidv4(),
});

export class UserAdminSessionParamDto extends createZodDto(UserAdminSessionParamSchema) {}

/**
 * FL-76: one page of an account's administrator history, the account detail's Activity tab. Paged
 * newest first: `before` is the id of the last event already shown.
 */
const UserAdminHistorySearchSchema = z.object({
  before: z.uuidv7().optional().describe('Only events older than this event, for paging'),
  take: z.coerce.number().int().min(1).max(200).optional().describe('Page size, 50 by default'),
});

export class UserAdminHistorySearchDto extends createZodDto(UserAdminHistorySearchSchema) {}

/**
 * What an administrator did to an account or one of its libraries. Names and settings only: a
 * password or PIN change is recorded as having happened, never with its value.
 */
const UserAdminHistoryEventResponseSchema = z
  .object({
    id: z.uuidv7().describe('Event ID'),
    action: AdminAuditActionSchema,
    subject: z.string().describe("The account's or library's name at the time"),
    detail: z
      .string()
      .nullable()
      .describe(
        'What the action carries: a quota in bytes, a storage label, a recovery period in days, a device name or the changed preference sections; null otherwise',
      ),
    libraryId: z
      .uuidv4()
      .nullable()
      .describe('The library a library event is about; null for account events and once the library is gone'),
    actorId: z.uuidv4().nullable().describe('The administrator who did it; null once that account is gone'),
    actorName: z.string().nullable().describe("That administrator's name; null once that account is gone"),
    createdAt: z.string().meta({ format: 'date-time' }).describe('When it happened'),
  })
  .meta({ id: 'UserAdminHistoryEventResponseDto' });

const UserAdminHistoryResponseSchema = z
  .object({
    events: z.array(UserAdminHistoryEventResponseSchema).describe('Newest first'),
    hasMore: z.boolean().describe('True when older events exist beyond this page'),
  })
  .meta({ id: 'UserAdminHistoryResponseDto' });

/**
 * FL-76 (CC-30): whether an account has a Locked PIN, for the administrator's Security tab
 * (`AccountsLibraries.jsx` 1403-1435). Its own admin-only endpoint, never part of a user DTO, and
 * never the PIN or its hash.
 */
const UserAdminPinCodeStateResponseSchema = z
  .object({
    pinCode: z.boolean().describe('Whether the account has a PIN set'),
  })
  .meta({ id: 'UserAdminPinCodeStateResponseDto' });

export class UserAdminPinCodeStateResponseDto extends createZodDto(UserAdminPinCodeStateResponseSchema) {}
export class UserAdminHistoryEventResponseDto extends createZodDto(UserAdminHistoryEventResponseSchema) {}
export class UserAdminHistoryResponseDto extends createZodDto(UserAdminHistoryResponseSchema) {}

const UserAdminResponseSchema = UserResponseSchema.extend({
  clusterGroupId: z
    .uuidv4()
    .describe('Cluster group the user is a member of')
    .meta(new HistoryBuilder().added('v3.2.0').getExtensions()),
  storageLabel: z.string().nullable().describe('Storage label'),
  shouldChangePassword: z.boolean().describe('Require password change on next login'),
  isAdmin: z.boolean().describe('Is admin user'),
  createdAt: isoDatetimeToDate.describe('Creation date'),
  deletedAt: isoDatetimeToDate.nullable().describe('Deletion date'),
  updatedAt: isoDatetimeToDate.describe('Last update date'),
  oauthId: z.string().describe('OAuth ID'),
  quotaSizeInBytes: z.int().min(0).nullable().describe('Storage quota in bytes'),
  quotaUsageInBytes: z.int().min(0).nullable().describe('Storage usage in bytes'),
  status: UserStatusSchema,
  license: UserLicenseSchema.nullable(),
}).meta({ id: 'UserAdminResponseDto' });

export class UserAdminResponseDto extends createZodDto(UserAdminResponseSchema) {}

export function mapUserAdmin(entity: UserAdmin): UserAdminResponseDto {
  const metadata = entity.metadata || [];
  const stored = metadata.find(
    (item): item is UserMetadataItem<UserMetadataKey.License> => item.key === UserMetadataKey.License,
  )?.value;
  // Only a Frameleaf supporter key counts; a stored value of the previous product key is ignored.
  const license = stored && stored.kind === 'individual' && typeof stored.keyHint === 'string' ? stored : undefined;

  return {
    ...mapUser(entity),
    clusterGroupId: entity.clusterGroupId,
    storageLabel: entity.storageLabel,
    shouldChangePassword: entity.shouldChangePassword,
    isAdmin: entity.isAdmin,
    createdAt: entity.createdAt,
    deletedAt: entity.deletedAt,
    updatedAt: entity.updatedAt,
    // TODO(v4): remove the mapping and make `oauthId` nullable
    oauthId: entity.oauthId ?? '',
    quotaSizeInBytes: entity.quotaSizeInBytes,
    quotaUsageInBytes: entity.quotaUsageInBytes,
    status: entity.status,
    license: license
      ? { kind: 'individual', keyHint: license.keyHint, activatedAt: new Date(license.activatedAt) }
      : null,
  };
}
