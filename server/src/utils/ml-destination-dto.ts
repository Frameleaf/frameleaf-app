import type { MlDestinationHealthStateDto, MlDestinationResponseDto } from 'src/dtos/ml-destination.dto.js';
import type { MlDestinationRow } from 'src/repositories/ml-destination.repository.js';
import { MlDestinationKind } from 'src/enum.js';
import {
  ML_BUDGET_WINDOW_DAYS,
  isCloudDestination,
  mlWorkerRoleOf,
  resolveEndpoint,
} from 'src/utils/ml-destination.js';

/** The stored health check of a destination, as the API reports it. */
export const mlDestinationHealthOf = (row: MlDestinationRow): MlDestinationHealthStateDto => ({
  status: row.lastProbeHealth,
  probedAt: row.lastProbeAt ? new Date(row.lastProbeAt).toISOString() : null,
  summary: row.lastProbeSummary,
  servedWorkloads: row.lastProbeWorkloads,
});

/**
 * One destination as the API reports it (FL-110, FL-159). Never carries a bearer token; the
 * Frameleaf Cloud destination never carries a URL, and its gateway facts come from the last check.
 */
export const mapMlDestination = (row: MlDestinationRow, spentUsd: number): MlDestinationResponseDto => {
  const endpoint = resolveEndpoint(row);
  const cloud = row.lastProbeCloud;
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    url: endpoint && !endpoint.cloud ? endpoint.url : null,
    authTokenConfigured: row.authToken !== null,
    enabled: row.enabled,
    workloads: row.workloads,
    role: mlWorkerRoleOf(row.workloads),
    sharesLibraryHardware: row.sharesLibraryHardware,
    consent: {
      required: isCloudDestination(row.kind),
      acknowledgedAt: row.consentAcknowledgedAt ? new Date(row.consentAcknowledgedAt).toISOString() : null,
      acknowledgedBy: row.consentAcknowledgedBy,
      version: row.consentVersion,
      requiredVersion: cloud?.consentRequiredVersion ?? null,
    },
    costControls: {
      budgetLimitUsd: row.budgetLimitUsd,
      maxRuntimeMinutes: row.maxRuntimeMinutes,
      maxUploadBytes: row.maxUploadBytes === null ? null : Number(row.maxUploadBytes),
      spentUsd,
      budgetWindowDays: ML_BUDGET_WINDOW_DAYS,
    },
    health: mlDestinationHealthOf(row),
    cloud:
      row.kind === MlDestinationKind.FrameleafCloud
        ? {
            region: row.region,
            entitled: cloud?.entitled ?? false,
            balanceUsd: cloud?.balanceUsd ?? 0,
            heldUsd: cloud?.heldUsd ?? 0,
            dailyCapUsd: cloud?.dailyCapUsd ?? null,
            spentTodayUsd: cloud?.spentTodayUsd ?? 0,
            refusal: cloud?.refusal?.refusal ?? null,
            refusalDetail: cloud?.refusal?.detail ?? null,
          }
        : null,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
};
