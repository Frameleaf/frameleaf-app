import { ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import z from 'zod';
import type { SystemConfig } from 'src/dtos/config.dto.js';
import type { MlDestinationRow } from 'src/repositories/ml-destination.repository.js';
import { canonicalJson } from 'src/utils/object.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const recoveryAuthorityDigest = (value: unknown) =>
  createHash('sha256')
    .update(canonicalJson(JSON.parse(JSON.stringify(value))))
    .digest('hex');

/** Only dependency authority is overlaid; historical preferences and files remain recoverable. */
export type RecoveryMlConfig = {
  enabled: boolean;
  urls: string[];
  cloudMl: SystemConfig['frameleafCloud']['cloudMl'];
};

export const recoveryMlConfigOf = (config: SystemConfig): RecoveryMlConfig => ({
  enabled: config.machineLearning.enabled,
  urls: [...config.machineLearning.urls],
  cloudMl: structuredClone(config.frameleafCloud.cloudMl),
});

const authorityConfigSchema = z.strictObject({
  enabled: z.boolean(),
  urls: z.array(z.url()),
  cloudMl: z.strictObject({
    enabled: z.boolean(),
    routing: z.strictObject({
      descriptions: z.enum(['local', 'both', 'cloud']),
      upscale: z.enum(['local', 'both', 'cloud']),
      restoration: z.enum(['local', 'both', 'cloud']),
      studio: z.enum(['local', 'both', 'cloud']),
      interpolation: z.enum(['local', 'both', 'cloud']),
    }),
    startWith: z.enum(['local', 'cloud']),
    autoDescribe: z.strictObject({ enabled: z.boolean(), dailyBudgetUsd: z.number().finite().nonnegative() }),
    faces: z.strictObject({ enabled: z.literal(false) }),
    spenders: z.array(
      z.strictObject({ userId: z.uuid(), monthlyCapUsd: z.number().finite().nonnegative().nullable() }),
    ),
  }),
});

export const recoveryMlBindingSchema = z.strictObject({
  format: z.literal(1),
  recoveryId: z.uuid(),
  preparedPlanDigest: digest,
  replacementIdentity: digest,
});
export type RecoveryMlBinding = z.infer<typeof recoveryMlBindingSchema>;

export const recoveryMlOverlaySchema = recoveryMlBindingSchema.extend({
  rawDigest: digest,
  rawAuthorityDigest: digest,
  authority: authorityConfigSchema,
});
export type RecoveryMlOverlay = z.infer<typeof recoveryMlOverlaySchema>;

/** Separate from epochs and health/URL-removal diagnostics; normal writers cannot drop quarantine. */
export const recoveryMlRegistrySchema = recoveryMlBindingSchema.extend({
  quarantine: z.record(z.uuid(), digest),
});
export type RecoveryMlRegistry = z.infer<typeof recoveryMlRegistrySchema>;

export const recoveryMlRefusal = () => new ConflictException('replacement_ml_authority_unavailable');

export function applyRecoveryMlOverlay(raw: SystemConfig, input: RecoveryMlOverlay): SystemConfig {
  const parsed = recoveryMlOverlaySchema.safeParse(input);
  if (!parsed.success || recoveryAuthorityDigest(raw) !== parsed.data.rawDigest) throw recoveryMlRefusal();
  const { enabled, urls, cloudMl } = parsed.data.authority;
  const result = structuredClone(raw);
  result.machineLearning.enabled = enabled;
  result.machineLearning.urls = [...urls];
  result.frameleafCloud.cloudMl = structuredClone(cloudMl);
  return result;
}

/** No token/URL is exposed in a registry or refusal; full rows stay in the private preimage. */
export const recoveryMlEndpointIdentity = (
  row: Pick<MlDestinationRow, 'id' | 'kind' | 'url' | 'authToken' | 'region'>,
) =>
  recoveryAuthorityDigest({ id: row.id, kind: row.kind, url: row.url, authToken: row.authToken, region: row.region });

export const recoveryMlAdmissionIdentity = (row: MlDestinationRow) =>
  recoveryAuthorityDigest({
    endpoint: recoveryMlEndpointIdentity(row),
    enabled: row.enabled,
    workloads: row.workloads,
    consentAcknowledgedAt: row.consentAcknowledgedAt,
    consentAcknowledgedBy: row.consentAcknowledgedBy,
    consentVersion: row.consentVersion,
    budgetLimitUsd: row.budgetLimitUsd,
    maxRuntimeMinutes: row.maxRuntimeMinutes,
    maxUploadBytes: row.maxUploadBytes,
    sharesLibraryHardware: row.sharesLibraryHardware,
    updatedAt: row.updatedAt,
  });
