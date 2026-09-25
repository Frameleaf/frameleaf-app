import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { MlDestinationResponseSchema } from 'src/dtos/ml-destination.dto.js';
import { MlWorkloadSchema } from 'src/enum.js';

/**
 * Frameleaf Cloud processing administration (FL-159, CLD-201). Customer copy says "Frameleaf Cloud";
 * nothing here names a GPU provider. Money is USD for display; the cloud keeps the ledger.
 */

const CloudMlConnectionSchema = z
  .enum(['not-configured', 'not-linked', 'ready', 'unavailable'])
  .describe(
    'not-configured: FRAMELEAF_CLOUD_URL is unset; not-linked: the server is not linked to a Frameleaf account; ready: the regional gateway answered; unavailable: linked but the cloud did not answer',
  )
  .meta({ id: 'CloudMlConnection' });

const CloudMlConsentFeaturesSchema = z
  .object({
    identityNames: z.boolean(),
    medicalSignals: z.boolean(),
    ocrAddon: z.boolean(),
  })
  .meta({ id: 'CloudMlConsentFeaturesDto' });

const CloudMlConsentStateSchema = z
  .object({
    requiredVersion: z.string().describe('The consent version Frameleaf Cloud requires now'),
    recordedVersion: z.string().nullable().describe('The version Frameleaf Cloud has on record for this server'),
    acceptedVersion: z.string().nullable().describe('The version an administrator accepted on this server'),
    features: CloudMlConsentFeaturesSchema.describe('The feature choices on record'),
    summary: z.string().describe('What the consent covers, as Frameleaf Cloud words it'),
    documentUrl: z.string().nullable().describe('The full consent text, when Frameleaf Cloud links one'),
    outdated: z.boolean().describe('Consent was given, but for an older version; processing is refused until renewed'),
  })
  .meta({ id: 'CloudMlConsentStateDto' });

const CloudMlWalletSchema = z
  .object({
    balanceUsd: z.number().meta({ format: 'double' }).describe('AI Wallet balance, USD'),
    heldUsd: z.number().meta({ format: 'double' }).describe('Held by running jobs, USD'),
    availableUsd: z.number().meta({ format: 'double' }).describe('Balance minus holds, USD'),
    dailyCapUsd: z.number().meta({ format: 'double' }).nullable().describe('Daily limit, USD, or null'),
    spentTodayUsd: z.number().meta({ format: 'double' }).describe('Spent today, USD'),
    topUpUrl: z.string().nullable().describe('Where to add credit; only when Frameleaf Cloud returned one'),
    autoTopUp: z.boolean().describe('Automatic top-up with the payment method saved on the account'),
    updatedAt: z.string().describe('When this balance was read'),
  })
  .meta({ id: 'CloudMlWalletDto' });

const CloudMlStatusResponseSchema = z
  .object({
    connection: CloudMlConnectionSchema,
    detail: z.string().nullable().describe('Why the connection is not ready, in plain words'),
    enabled: z.boolean().describe('Frameleaf Cloud processing is turned on in settings'),
    region: z.string().nullable().describe("The Frameleaf account's data region"),
    entitled: z.boolean().nullable().describe('Cloud processing entitlement, when the cloud answered'),
    destination: MlDestinationResponseSchema.nullable().describe('The Frameleaf Cloud destination, once added'),
    consent: CloudMlConsentStateSchema.nullable(),
    wallet: CloudMlWalletSchema.nullable().describe('The last AI Wallet read, or null'),
    checkedAt: z.string(),
  })
  .meta({ id: 'CloudMlStatusResponseDto' });

const CloudMlModelSchema = z
  .object({
    id: z.string(),
    workload: MlWorkloadSchema.nullable().describe(
      'The workload this model serves, or null for one this server does not know',
    ),
    name: z.string(),
    description: z.string(),
    fingerprint: z.string(),
    pricingUnit: z.string().nullable().describe('What one price unit is (for example an image or a video minute)'),
    priceUsd: z.number().meta({ format: 'double' }).nullable().describe('Price per unit, USD'),
  })
  .meta({ id: 'CloudMlModelDto' });

const CloudMlCatalogResponseSchema = z
  .object({
    models: z.array(CloudMlModelSchema).describe('Models Frameleaf Cloud offers now; retired models are left out'),
  })
  .meta({ id: 'CloudMlCatalogResponseDto' });

const CloudMlDestinationCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(80).default('Frameleaf Cloud'),
    workloads: z
      .array(MlWorkloadSchema)
      .min(1)
      .max(16)
      .describe('The workloads Frameleaf Cloud may run; faces, search and text recognition are refused'),
    budgetLimitUsd: z.number().min(0).meta({ format: 'double' }).nullable().optional(),
  })
  .meta({ id: 'CloudMlDestinationCreateDto' });

const CloudMlConsentRecordSchema = z
  .object({
    version: z.string(),
    features: CloudMlConsentFeaturesSchema,
    acceptedBy: z.string(),
    acceptedAt: z.string(),
    revokedAt: z.string().nullable(),
  })
  .meta({ id: 'CloudMlConsentRecordDto' });

const CloudMlConsentHistoryResponseSchema = z
  .object({ records: z.array(CloudMlConsentRecordSchema) })
  .meta({ id: 'CloudMlConsentHistoryResponseDto' });

const CloudMlSettlementSchema = z
  .object({
    cloudJobId: z.string().describe('The job id Frameleaf Cloud settled'),
    workload: MlWorkloadSchema,
    jobName: z.string().nullable().describe('The server job that sent the work, when recorded'),
    succeeded: z.boolean().describe('The request finished successfully'),
    costUsd: z.number().meta({ format: 'double' }).describe('The settled charge, USD'),
    credits: z.number().meta({ format: 'double' }).nullable().describe('Credits the charge used, when reported'),
    finishedAt: z.string(),
    modelId: z.string().nullable().describe('The catalogue model the job used, when reported'),
    gpuSeconds: z.number().nullable().describe('Metered GPU time, seconds, when reported'),
    workers: z.number().int().nullable().describe('Workers the job ran on (each paid a start fee), when reported'),
    estimateUsd: z.number().meta({ format: 'double' }).nullable().describe('The estimate shown before the job, USD'),
  })
  .meta({ id: 'CloudMlSettlementDto' });

const CloudMlWalletUpdateSchema = z
  .object({
    dailyCapUsd: z.number().min(1).max(1000).meta({ format: 'double' }).optional().describe('Daily spending cap, USD'),
    autoTopUp: z.boolean().optional().describe('Top up automatically when available credit runs low'),
  })
  .meta({ id: 'CloudMlWalletUpdateDto' });

const CloudMlSettlementsResponseSchema = z
  .object({ items: z.array(CloudMlSettlementSchema).describe('Settled charges, newest first (at most 50)') })
  .meta({ id: 'CloudMlSettlementsResponseDto' });

export class CloudMlStatusResponseDto extends createZodDto(CloudMlStatusResponseSchema) {}
export class CloudMlWalletDto extends createZodDto(CloudMlWalletSchema) {}
export class CloudMlCatalogResponseDto extends createZodDto(CloudMlCatalogResponseSchema) {}
export class CloudMlModelDto extends createZodDto(CloudMlModelSchema) {}
export class CloudMlDestinationCreateDto extends createZodDto(CloudMlDestinationCreateSchema) {}
export class CloudMlConsentHistoryResponseDto extends createZodDto(CloudMlConsentHistoryResponseSchema) {}
export class CloudMlWalletUpdateDto extends createZodDto(CloudMlWalletUpdateSchema) {}
export class CloudMlSettlementsResponseDto extends createZodDto(CloudMlSettlementsResponseSchema) {}
