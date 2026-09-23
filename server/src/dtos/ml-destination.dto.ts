import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import {
  MlAdmissionRefusalSchema,
  MlDestinationHealthSchema,
  MlDestinationKindSchema,
  MlWorkerRoleSchema,
  MlWorkloadSchema,
} from 'src/enum.js';

/**
 * Machine-learning destinations and workload capabilities (FL-110).
 *
 * The API never returns a LAN bearer token; `authTokenConfigured` says one is stored. A
 * RunPod destination's `url` is whatever the RunPod state machine currently publishes and
 * is null while no pod or serverless worker is ready.
 */

const MlDestinationConsentSchema = z
  .object({
    required: z.boolean().describe('Whether this destination sends media off the network and needs consent'),
    acknowledgedAt: z.string().nullable().describe('When an administrator recorded consent, or null'),
    acknowledgedBy: z.string().nullable().describe('Administrator who recorded consent, or null'),
  })
  .meta({ id: 'MlDestinationConsentDto' });

const MlDestinationCostControlsSchema = z
  .object({
    budgetLimitUsd: z
      .number()
      .meta({ format: 'double' })
      .nullable()
      .describe('Spend ceiling over the rolling budget window, or null for no ceiling'),
    maxRuntimeMinutes: z.int().nullable().describe('Longest single job this destination may run, or null'),
    maxUploadBytes: z
      .number()
      .meta({ format: 'double' })
      .nullable()
      .describe('Largest upload one job may send to this destination, or null'),
    spentUsd: z
      .number()
      .meta({ format: 'double' })
      .describe('Attributed spend inside the budget window; 0 when no cost has been attributed yet'),
    budgetWindowDays: z.int().describe('Length of the rolling window `spentUsd` covers'),
  })
  .meta({ id: 'MlDestinationCostControlsDto' });

const MlDestinationHealthStateSchema = z
  .object({
    status: MlDestinationHealthSchema,
    probedAt: z.string().nullable().describe('When the destination was last probed, or null'),
    summary: z.string().nullable().describe('Human-readable probe result, or null'),
    servedWorkloads: z
      .array(MlWorkloadSchema)
      .nullable()
      .describe('Workloads the worker itself reported on the last probe, or null when it never answered'),
  })
  .meta({ id: 'MlDestinationHealthStateDto' });

const MlDestinationResponseSchema = z
  .object({
    id: z.uuidv4(),
    kind: MlDestinationKindSchema,
    name: z.string(),
    url: z.string().nullable().describe('Endpoint URL; null for a RunPod destination with no ready worker'),
    authTokenConfigured: z.boolean().describe('Whether a bearer token is stored for this destination'),
    enabled: z.boolean(),
    workloads: z.array(MlWorkloadSchema).describe('Workloads the administrator allows on this destination'),
    role: MlWorkerRoleSchema,
    sharesLibraryHardware: z
      .boolean()
      .describe('A restoration worker on the GPU library analysis uses; its full restorations wait for library work'),
    consent: MlDestinationConsentSchema,
    costControls: MlDestinationCostControlsSchema,
    health: MlDestinationHealthStateSchema,
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({ id: 'MlDestinationResponseDto' });

const sharesLibraryHardwareField = z
  .boolean()
  .optional()
  .describe('Restoration workers only: full restorations wait while library analysis has work');

const costControlFields = {
  budgetLimitUsd: z.number().min(0).meta({ format: 'double' }).nullable().optional(),
  maxRuntimeMinutes: z.int().min(1).max(10_080).nullable().optional(),
  maxUploadBytes: z.number().int().min(1).meta({ format: 'double' }).nullable().optional(),
};

const MlDestinationCreateSchema = z
  .object({
    kind: MlDestinationKindSchema,
    name: z.string().trim().min(1).max(80),
    url: z
      .url()
      .optional()
      .describe('Required for a LAN or RunPod video destination, optional for a local one, forbidden for RunPod'),
    authToken: z
      .string()
      .max(4096)
      .optional()
      .describe('Bearer token for a LAN or RunPod video worker (write-only)'),
    workloads: z.array(MlWorkloadSchema).max(16).default([]),
    enabled: z.boolean().default(true),
    sharesLibraryHardware: sharesLibraryHardwareField,
    ...costControlFields,
  })
  .meta({ id: 'MlDestinationCreateDto' });

const MlDestinationUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    url: z.url().nullable().optional(),
    authToken: z
      .string()
      .max(4096)
      .nullable()
      .optional()
      .describe('New bearer token; null clears it; omitted keeps the stored token'),
    workloads: z.array(MlWorkloadSchema).max(16).optional(),
    enabled: z.boolean().optional(),
    sharesLibraryHardware: sharesLibraryHardwareField,
    ...costControlFields,
  })
  .meta({ id: 'MlDestinationUpdateDto' });

const MlDestinationConsentRequestSchema = z
  .object({
    acknowledgeMediaLeavesNetwork: z
      .literal(true)
      .describe('The administrator confirms that media sent to this destination leaves the network'),
  })
  .meta({ id: 'MlDestinationConsentRequestDto' });

const MlWorkloadRouteSchema = z
  .object({
    workload: MlWorkloadSchema,
    destinationId: z.uuidv4().nullable().describe('Destination the workload is routed to, or null when unrouted'),
  })
  .meta({ id: 'MlWorkloadRouteDto' });

const MlWorkloadRoutesResponseSchema = z
  .object({
    routes: z.array(MlWorkloadRouteSchema),
  })
  .meta({ id: 'MlWorkloadRoutesResponseDto' });

const MlWorkloadRouteUpdateSchema = z
  .object({
    destinationId: z.uuidv4().nullable().describe('Destination to route the workload to; null removes the route'),
  })
  .meta({ id: 'MlWorkloadRouteUpdateDto' });

const MlAdmissionRequestSchema = z
  .object({
    workload: MlWorkloadSchema,
    jobId: z.string().max(200).optional().describe('Job the admission is for, recorded with the accounting row'),
  })
  .meta({ id: 'MlAdmissionRequestDto' });

const MlThroughputEstimateSchema = z
  .object({
    sampleCount: z.int().describe('Successful requests the estimate is measured from'),
    bytesPerSecond: z
      .number()
      .meta({ format: 'double' })
      .nullable()
      .describe('Measured throughput for this destination and workload, or null with no samples'),
    windowDays: z.int(),
  })
  .meta({ id: 'MlThroughputEstimateDto' });

const MlAdmissionResponseSchema = z
  .object({
    destinationId: z.uuidv4(),
    kind: MlDestinationKindSchema,
    workload: MlWorkloadSchema,
    health: MlDestinationHealthStateSchema,
    estimate: MlThroughputEstimateSchema,
  })
  .meta({ id: 'MlAdmissionResponseDto' });

const MlAdmissionRefusalResponseSchema = z
  .object({
    refusal: MlAdmissionRefusalSchema,
    destinationId: z.uuidv4().nullable(),
    workload: MlWorkloadSchema,
    detail: z.string(),
  })
  .meta({ id: 'MlAdmissionRefusalResponseDto' });

const MlCapabilityDestinationSchema = z
  .object({
    id: z.uuidv4(),
    kind: MlDestinationKindSchema,
    name: z.string(),
    health: MlDestinationHealthSchema,
    consentGranted: z.boolean().describe('True when the destination needs no consent or consent is recorded'),
    available: z.boolean().describe('Enabled, healthy on the last probe, consented and reporting this workload'),
  })
  .meta({ id: 'MlCapabilityDestinationDto' });

const MlWorkloadCapabilitySchema = z
  .object({
    workload: MlWorkloadSchema,
    available: z.boolean().describe('At least one destination can serve this workload right now'),
    routedDestinationId: z.uuidv4().nullable().describe('Destination library jobs use for this workload, or null'),
    destinations: z.array(MlCapabilityDestinationSchema),
  })
  .meta({ id: 'MlWorkloadCapabilityDto' });

const StudioCapabilitiesSchema = z
  .object({
    gpuWorker: z.boolean().describe('False until the Studio render worker admission (FL-95, FL-104) reports one'),
    renderWorker: z.boolean().describe('False until the Studio render worker admission (FL-95, FL-104) reports one'),
    restorationWorker: z.boolean().describe('A destination can serve a restoration workload right now'),
    transcriptionWorker: z.boolean().describe('A destination can serve the Studio AI workload right now'),
  })
  .meta({ id: 'StudioCapabilitiesDto' });

const MlCapabilitiesResponseSchema = z
  .object({
    workloads: z.array(MlWorkloadCapabilitySchema),
    studio: StudioCapabilitiesSchema,
    probedAt: z.string().describe('When this snapshot was assembled'),
  })
  .meta({ id: 'MlCapabilitiesResponseDto' });

export class MlDestinationResponseDto extends createZodDto(MlDestinationResponseSchema) {}
export class MlDestinationCreateDto extends createZodDto(MlDestinationCreateSchema) {}
export class MlDestinationUpdateDto extends createZodDto(MlDestinationUpdateSchema) {}
export class MlDestinationConsentRequestDto extends createZodDto(MlDestinationConsentRequestSchema) {}
export class MlDestinationHealthStateDto extends createZodDto(MlDestinationHealthStateSchema) {}
export class MlWorkloadRouteDto extends createZodDto(MlWorkloadRouteSchema) {}
export class MlWorkloadRoutesResponseDto extends createZodDto(MlWorkloadRoutesResponseSchema) {}
export class MlWorkloadRouteUpdateDto extends createZodDto(MlWorkloadRouteUpdateSchema) {}
export class MlAdmissionRequestDto extends createZodDto(MlAdmissionRequestSchema) {}
export class MlAdmissionResponseDto extends createZodDto(MlAdmissionResponseSchema) {}
export class MlAdmissionRefusalResponseDto extends createZodDto(MlAdmissionRefusalResponseSchema) {}
export class MlCapabilitiesResponseDto extends createZodDto(MlCapabilitiesResponseSchema) {}
export class MlWorkloadCapabilityDto extends createZodDto(MlWorkloadCapabilitySchema) {}
export class StudioCapabilitiesDto extends createZodDto(StudioCapabilitiesSchema) {}
