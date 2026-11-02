import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { HistoryBuilder } from 'src/decorators.js';
import { Permission } from 'src/enum.js';
import { isoDatetimeToDate } from 'src/validation.js';

const PermissionSchema = z.enum(Permission).describe('List of permissions').meta({ id: 'Permission' });

// Shipped native apps decode response enums strictly, so newer permissions are reported in their own field.
export const DESIGN_PERMISSIONS = [
  Permission.AssetSourceRead,
  Permission.BookmarkCreate,
  Permission.BookmarkRead,
  Permission.BookmarkUpdate,
  Permission.BookmarkDelete,
  Permission.CaptureCreate,
  Permission.CaptureCatalogRead,
] as const;
const designPermissions = new Set<Permission>(DESIGN_PERMISSIONS);
const ResponsePermissionSchema = z
  .enum(Object.values(Permission).filter((permission) => !designPermissions.has(permission)))
  .describe('List of permissions')
  .meta({ id: 'ApiKeyResponsePermission' });
const DesignPermissionSchema = z.enum(DESIGN_PERMISSIONS).describe('Design workspace permission').meta({
  id: 'DesignPermission',
});

const ApiKeyCreateSchema = z
  .object({
    name: z.string().optional().describe('API key name'),
    permissions: z.array(PermissionSchema).min(1).describe('List of permissions'),
  })
  .meta({ id: 'ApiKeyCreateDto' });

const ApiKeyUpdateSchema = z
  .object({
    name: z.string().optional().describe('API key name'),
    permissions: z.array(PermissionSchema).min(1).optional().describe('List of permissions'),
  })
  .meta({ id: 'ApiKeyUpdateDto' });

const ApiKeyResponseSchema = z
  .object({
    id: z.uuidv4().describe('API key ID'),
    name: z.string().describe('API key name'),
    createdAt: isoDatetimeToDate.describe('Creation date'),
    updatedAt: isoDatetimeToDate.describe('Last update date'),
    permissions: z.array(ResponsePermissionSchema).describe('List of permissions'),
    designPermissions: z
      .array(DesignPermissionSchema)
      .describe('Design workspace permissions, listed apart from permissions so older clients can still read keys'),
    // FL-367: recorded at most every few minutes, so it is a moment to the nearest few minutes
    lastUsedAt: z
      .string()
      .meta({ format: 'date-time' })
      .nullable()
      .describe('When the key was last used to reach the server; null when it never has been'),
    // FL-655: a plain string (chrome or edge), so a later browser never breaks a strict decoder
    signedInFrom: z
      .string()
      .nullable()
      .describe(
        'The browser (chrome or edge) when Save to Frameleaf added this key by signing in; null for a key made by hand. It has no value to copy or replace.',
      ),
  })
  .meta({ id: 'ApiKeyResponseDto' });

const ApiKeyCreateResponseSchema = z
  .object({
    ...ApiKeyResponseSchema.shape,
    secret: z.string().describe('API key secret (only shown once)'),
    apiKey: ApiKeyResponseSchema.meta({ ...new HistoryBuilder().added('v1').deprecated('v3.2.0').getExtensions() }),
  })
  .meta({ id: 'ApiKeyCreateResponseDto' });

export class ApiKeyCreateDto extends createZodDto(ApiKeyCreateSchema) {}
export class ApiKeyUpdateDto extends createZodDto(ApiKeyUpdateSchema) {}
export class ApiKeyResponseDto extends createZodDto(ApiKeyResponseSchema) {}
export class ApiKeyCreateResponseDto extends createZodDto(ApiKeyCreateResponseSchema) {}

export const splitApiKeyPermissions = (permissions: Permission[]) => ({
  permissions: permissions.filter(
    (permission) => !designPermissions.has(permission),
  ) as ApiKeyResponseDto['permissions'],
  designPermissions: permissions.filter((permission) =>
    designPermissions.has(permission),
  ) as ApiKeyResponseDto['designPermissions'],
});
