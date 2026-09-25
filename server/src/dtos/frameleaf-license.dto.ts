import { createZodDto } from 'nestjs-zod';
import z from 'zod';

/**
 * Frameleaf licence certificates on this server (FL-156) and the bundled Support Frameleaf prices
 * (FL-157). A key is never returned: only its last four symbols. Every amount is US dollars.
 */

export const LicenseStateSchema = z
  .enum(['none', 'active', 'grace', 'expired', 'invalid'])
  .describe(
    'none: no licence; active; grace: renewal failed and cloud features keep working until graceUntil; expired: cloud features are paused, local features are unaffected; invalid: the stored certificate no longer verifies',
  )
  .meta({ id: 'LicenseState' });

const LicenseKindSchema = z
  .enum(['server', 'individual', 'plan'])
  .describe('server or individual supporter key, or a Frameleaf Cloud plan')
  .meta({ id: 'LicenseKind' });

const LicenseEntitlementsSchema = z
  .object({
    frameleafCloud: z.boolean(),
    remoteAccess: z.boolean(),
    cloudMl: z.boolean(),
    cloudBackup: z.boolean(),
    supporter: z.boolean(),
  })
  .meta({ id: 'LicenseEntitlementsDto' });

const LicenseSlotSchema = z
  .object({
    state: LicenseStateSchema,
    kind: LicenseKindSchema,
    source: z.enum(['key', 'file', 'account']).describe('Activated by key, installed from a file, or from the account'),
    keyHint: z.string().nullable().describe('Last four symbols of the key, for a key activation'),
    activatedAt: z.string().describe('When this server received the certificate'),
    expiresAt: z.string().nullable().describe('When the certificate or its period ends; null for a lifetime key'),
    graceUntil: z.string().nullable(),
    refreshedAt: z.string().nullable(),
  })
  .meta({ id: 'LicenseSlotDto' });

const LicenseStatusResponseSchema = z
  .object({
    state: LicenseStateSchema.describe('The overall state: the plan’s when there is one, else the key’s'),
    kind: LicenseKindSchema.nullable(),
    keyHint: z.string().nullable(),
    expiresAt: z.string().nullable(),
    graceUntil: z.string().nullable(),
    fingerprint: z
      .object({ instanceId: z.string().nullable(), jkt: z.string().nullable() })
      .describe('What a licence is bound to: this server’s instance ID and key thumbprint'),
    entitlements: LicenseEntitlementsSchema,
    licensed: z.boolean().describe('A supporter key or plan is active or in grace; plans then cost 20% less'),
    refresh: z
      .object({
        refreshedAt: z.string().nullable(),
        nextRefreshAt: z.string().nullable(),
        lastError: z.string().nullable(),
      })
      .describe('The daily certificate refresh'),
    offline: z.boolean().describe('The licence came from a file and is not refreshed online'),
    linked: z.boolean().describe('This server is linked to a Frameleaf account'),
    configured: z.boolean().describe('Frameleaf Cloud is set up on this server (FRAMELEAF_CLOUD_URL)'),
    key: LicenseSlotSchema.nullable().describe('The supporter key held by this server'),
    plan: LicenseSlotSchema.nullable().describe('The Frameleaf Cloud plan held by this server'),
  })
  .meta({ id: 'LicenseStatusResponseDto' });

const LicenseActivateSchema = z
  .object({
    key: z.string().trim().min(1).max(64).describe('A licence key, FL-KXXX-XXXX-XXXX'),
  })
  .meta({ id: 'LicenseActivateDto' });

const LicenseCertificateSchema = z
  .object({
    certificate: z
      .string()
      .min(1)
      .max(64 * 1024)
      .describe('The contents of a licence file: the signed certificate, or a JSON file holding it'),
  })
  .meta({ id: 'LicenseCertificateDto' });

const LicenseProductSchema = z
  .object({
    id: z.string(),
    kind: z.enum(['plan', 'supporter', 'credit']),
    period: z.enum(['month', 'year', 'one-time']),
    priceUsd: z.number().meta({ format: 'double' }),
    storeUrl: z.string().nullable().describe('Where to buy it; null when no store is configured'),
  })
  .meta({ id: 'LicenseProductDto' });

const LicenseProductsResponseSchema = z
  .object({
    currency: z.literal('USD'),
    licensedDiscount: z.number().meta({ format: 'double' }).describe('Share taken off plans on a licensed server'),
    storeUrl: z.string().nullable().describe('The store this server was deployed with; null when there is none'),
    products: z.array(LicenseProductSchema),
    credit: z
      .object({
        minimumUsd: z.number().meta({ format: 'double' }),
        maximumUsd: z.number().meta({ format: 'double' }),
      })
      .describe('AI credit top-ups the store accepts; credit is never discounted'),
    backup: z
      .object({
        usdPerTbMonth: z.number().meta({ format: 'double' }),
        minimumTb: z.number().meta({ format: 'double' }),
      })
      .describe('Cloud backup is usage based, not part of a plan'),
  })
  .meta({ id: 'LicenseProductsResponseDto' });

export class LicenseStatusResponseDto extends createZodDto(LicenseStatusResponseSchema) {}
export class LicenseActivateDto extends createZodDto(LicenseActivateSchema) {}
export class LicenseCertificateDto extends createZodDto(LicenseCertificateSchema) {}
export class LicenseProductsResponseDto extends createZodDto(LicenseProductsResponseSchema) {}
