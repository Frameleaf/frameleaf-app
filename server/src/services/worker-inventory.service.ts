import { Injectable } from '@nestjs/common';
import type { RenderWorkerDto } from 'src/dtos/render-worker.dto.js';
import type {
  WorkerInventoryEntryDto,
  WorkerInventoryResponseDto,
  WorkerRunnerDto,
} from 'src/dtos/worker-inventory.dto.js';
import {
  LIBRARY_ML_WORKLOADS,
  MediaOperationDestination,
  MediaOperationKind,
  MlAdmissionRefusal,
  MlDestinationKind,
  MlWorkerAcceleration,
  MlWorkerReadiness,
  MlWorkload,
  RenderWorkerStatus,
  WorkerCredentialState,
  WorkerInventorySource,
} from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MachineLearningRepository } from 'src/repositories/machine-learning.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { MlDestinationRepository, MlDestinationRow } from 'src/repositories/ml-destination.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { RenderWorkerService } from 'src/services/render-worker.service.js';
import { getConfig } from 'src/utils/config.js';
import {
  ML_BUDGET_WINDOW_DAYS,
  accelerationOf,
  evaluateAdmission,
  hasRequiredConsent,
  isCloudDestination,
  mlWorkerRoleOf,
  readinessOf,
  resolveEndpoint,
  restorationRoleConflict,
  sameEndpointUrl,
  storedProbe,
} from 'src/utils/ml-destination.js';
import { RESTORATION_OPERATION_KINDS } from 'src/utils/restoration.js';
import {
  ALL_LIBRARY_ANALYSIS_QUEUES,
  LIBRARY_ANALYSIS_QUEUES,
  libraryAnalysisBacklog,
  readQueueBacklogs,
} from 'src/utils/worker-inventory.js';

/** A render worker that has not checked in for this long is shown as unreachable. */
export const RENDER_WORKER_STALE_MS = 10 * 60 * 1000;

const budgetWindowStart = () => new Date(Date.now() - ML_BUDGET_WINDOW_DAYS * 24 * 60 * 60 * 1000);
/** Active and waiting jobs summed over `queues`; a queue without counts adds nothing. */
const sumQueueLoad = <Q>(queues: readonly Q[], counts: ReadonlyMap<Q, { active: number; waiting: number }>) => {
  const total = { active: 0, waiting: 0 };
  for (const queue of queues) {
    const entry = counts.get(queue);
    if (entry) {
      total.active += entry.active;
      total.waiting += entry.waiting;
    }
  }
  return total;
};

const iso = (value: unknown): string | null => (value ? new Date(value as string | Date).toISOString() : null);

/**
 * The worker inventory (FL-72): one read-only view over every place work can run.
 *
 * - **Machine-learning destinations** (local, LAN and Frameleaf Cloud) with the state
 *   of their last check, what they may run, what they said they serve, where library work is
 *   routed, what admission would answer per workload and how busy they are.
 * - **Render workers** (FL-95) with their check-in state, qualified GPU memory and claims.
 * - **Restoration runners**: the server processes holding restoration claims right now.
 *
 * Nothing here contacts a worker or changes a route. A check is the explicit probe on the ML
 * destination API; routes and consent stay on their own endpoints. Loads are counts and runner
 * identities are process names, so an administrator never learns whose media a worker holds.
 */
@Injectable()
export class WorkerInventoryService {
  constructor(
    private logger: LoggingRepository,
    private configRepository: ConfigRepository,
    private systemMetadataRepository: SystemMetadataRepository,
    private mlDestinationRepository: MlDestinationRepository,
    private machineLearningRepository: MachineLearningRepository,
    private mediaOperationRepository: MediaOperationRepository,
    private jobRepository: JobRepository,
    private renderWorkerService: RenderWorkerService,
  ) {
    this.logger.setContext(WorkerInventoryService.name);
  }

  async getInventory(): Promise<WorkerInventoryResponseDto> {
    const config = await getConfig(
      { configRepo: this.configRepository, metadataRepo: this.systemMetadataRepository, logger: this.logger },
      { withCache: true },
    );
    const [rows, routes, renderWorkers, restorationLoad, claimants, queues] = await Promise.all([
      this.mlDestinationRepository.getAll(),
      this.mlDestinationRepository.getRoutes(),
      this.renderWorkerService.list(),
      this.mediaOperationRepository.getDestinationLoad(RESTORATION_OPERATION_KINDS),
      this.mediaOperationRepository.getClaimants(RESTORATION_OPERATION_KINDS),
      readQueueBacklogs(this.jobRepository, ALL_LIBRARY_ANALYSIS_QUEUES),
    ]);

    const backlog = libraryAnalysisBacklog(queues);
    const routedTo = new Map(routes.map((route) => [route.workload, route.destinationId]));
    const loadByDestination = new Map(restorationLoad.map((row) => [row.destinationId, row]));
    const queueByName = new Map(queues.map((entry) => [entry.queue, entry]));
    const configuredUrls = [...config.machineLearning.urls];

    const entries: WorkerInventoryEntryDto[] = [];
    for (const row of rows) {
      entries.push(
        await this.mlEntry(row, {
          routedWorkloads: Object.values(MlWorkload).filter((workload) => routedTo.get(workload) === row.id),
          configuredUrls,
          backlog,
          restorationLoad: loadByDestination.get(row.id),
          libraryLoad: sumQueueLoad(
            LIBRARY_ML_WORKLOADS.filter((workload) => routedTo.get(workload) === row.id).flatMap(
              (workload) => LIBRARY_ANALYSIS_QUEUES[workload],
            ),
            queueByName,
          ),
        }),
      );
    }
    for (const worker of renderWorkers) {
      entries.push(this.renderEntry(worker));
    }

    return {
      entries,
      runners: this.runners(claimants),
      libraryRoutes: Object.values(MlWorkload)
        .filter((workload) => LIBRARY_ML_WORKLOADS.includes(workload))
        .map((workload) => ({
          workload,
          destinationId: routedTo.get(workload) ?? null,
          queues: [...LIBRARY_ANALYSIS_QUEUES[workload]],
        })),
      libraryQueues: queues,
      libraryBacklog: backlog,
      machineLearningEnabled: config.machineLearning.enabled,
      configuredUrls,
      checkedAt: new Date().toISOString(),
    };
  }

  private async mlEntry(
    row: MlDestinationRow,
    context: {
      routedWorkloads: MlWorkload[];
      configuredUrls: string[];
      backlog: number;
      restorationLoad?: { queued: number; active: number };
      libraryLoad: { active: number; waiting: number };
    },
  ): Promise<WorkerInventoryEntryDto> {
    const endpoint = resolveEndpoint(row);
    const probe = storedProbe(row);
    const spentUsd =
      row.budgetLimitUsd === null ? 0 : await this.mlDestinationRepository.getSpend(row.id, budgetWindowStart());

    const admission: WorkerInventoryEntryDto['admission'] = [];
    for (const workload of row.workloads) {
      let verdict = evaluateAdmission({ destination: row, workload, endpoint, probe, spentUsd });
      if (verdict.admitted) {
        const conflict = await restorationRoleConflict(
          {
            mlDestinationRepository: this.mlDestinationRepository,
            machineLearningRepository: this.machineLearningRepository,
          },
          row,
          workload,
        );
        if (conflict) {
          verdict = { admitted: false, refusal: MlAdmissionRefusal.RoleConflict, detail: conflict };
        }
      }
      admission.push({
        workload,
        admitted: verdict.admitted,
        refusal: verdict.admitted ? null : verdict.refusal,
        detail: verdict.admitted ? null : verdict.detail,
      });
    }

    const hardware = row.lastProbeHardware;
    const gpus = hardware?.gpus ?? [];
    const gpuMemoryBytes = gpus.length > 0 ? Math.max(...gpus.map((gpu) => gpu.memoryTotalBytes)) : null;
    const isRestoration = row.workloads.some(
      (workload) => workload === MlWorkload.RestorationFaithful || workload === MlWorkload.RestorationCreative,
    );
    const restoration = context.restorationLoad ?? { queued: 0, active: 0 };

    return {
      id: row.id,
      source: WorkerInventorySource.MlDestination,
      name: row.name,
      kind: row.kind,
      role: mlWorkerRoleOf(row.workloads),
      url: endpoint && !endpoint.cloud ? endpoint.url : null,
      configured:
        row.kind !== MlDestinationKind.Local ||
        (row.url !== null && context.configuredUrls.some((url) => sameEndpointUrl(url, row.url as string))),
      enabled: row.enabled,
      readiness: readinessOf(row),
      acceleration: accelerationOf(hardware),
      gpus,
      gpuMemoryBytes,
      credential:
        row.kind === MlDestinationKind.FrameleafCloud
          ? WorkerCredentialState.Managed
          : row.authToken
            ? WorkerCredentialState.Stored
            : WorkerCredentialState.None,
      leavesNetwork: isCloudDestination(row.kind),
      consentGranted: hasRequiredConsent(row),
      allowedWorkloads: row.workloads,
      servedWorkloads: row.lastProbeWorkloads,
      routedWorkloads: context.routedWorkloads,
      admission,
      renderKinds: [],
      sharesLibraryHardware: row.sharesLibraryHardware,
      waitingForLibraryAnalysis: row.sharesLibraryHardware && context.backlog > 0 && restoration.queued > 0,
      activeOperations: isRestoration ? restoration.active : context.libraryLoad.active,
      queuedOperations: isRestoration ? restoration.queued : context.libraryLoad.waiting,
      maxConcurrentOperations: null,
      checkedAt: iso(row.lastProbeAt),
      latencyMs: row.lastProbeLatencyMs,
      summary: row.lastProbeSummary,
    };
  }

  private renderEntry(worker: RenderWorkerDto): WorkerInventoryEntryDto {
    const seenAt = worker.lastSeenAt ? new Date(worker.lastSeenAt).getTime() : null;
    let readiness: MlWorkerReadiness;
    if (worker.status === RenderWorkerStatus.Revoked) {
      readiness = MlWorkerReadiness.Disabled;
    } else if (seenAt === null) {
      readiness = MlWorkerReadiness.Unknown;
    } else if (Date.now() - seenAt > RENDER_WORKER_STALE_MS) {
      readiness = MlWorkerReadiness.Unreachable;
    } else {
      readiness = MlWorkerReadiness.ModelReady;
    }
    const gpuMemoryBytes = worker.gpuMemoryBytes === null ? null : Number(worker.gpuMemoryBytes);

    return {
      id: worker.id,
      source: WorkerInventorySource.RenderWorker,
      name: worker.name,
      kind: worker.destination,
      role: null,
      // Render workers call in; the server holds no address for them.
      url: null,
      configured: true,
      enabled: worker.status !== RenderWorkerStatus.Revoked,
      readiness,
      acceleration: gpuMemoryBytes === null ? MlWorkerAcceleration.Unknown : MlWorkerAcceleration.Gpu,
      gpus: [],
      gpuMemoryBytes,
      credential: WorkerCredentialState.Enrolled,
      leavesNetwork: worker.destination === MediaOperationDestination.FrameleafCloud,
      consentGranted: true,
      allowedWorkloads: [],
      servedWorkloads: null,
      routedWorkloads: [],
      admission: [],
      renderKinds: worker.kinds,
      sharesLibraryHardware: false,
      waitingForLibraryAnalysis: false,
      activeOperations: worker.activeOperations,
      queuedOperations: 0,
      maxConcurrentOperations: worker.maxConcurrentOperations,
      checkedAt: worker.lastSeenAt,
      latencyMs: null,
      summary: null,
    };
  }

  private runners(
    claimants: Array<{ workerId: string; kind: MediaOperationKind; count: number; lastHeartbeatAt: Date | null }>,
  ): WorkerRunnerDto[] {
    const byWorker = new Map<string, WorkerRunnerDto>();
    for (const claimant of claimants) {
      const current = byWorker.get(claimant.workerId) ?? {
        workerId: claimant.workerId,
        kinds: [],
        activeOperations: 0,
        lastHeartbeatAt: null,
      };
      if (!current.kinds.includes(claimant.kind)) {
        current.kinds.push(claimant.kind);
      }
      current.activeOperations += claimant.count;
      const heartbeat = iso(claimant.lastHeartbeatAt);
      if (heartbeat && (!current.lastHeartbeatAt || heartbeat > current.lastHeartbeatAt)) {
        current.lastHeartbeatAt = heartbeat;
      }
      byWorker.set(claimant.workerId, current);
    }
    return byWorker
      .values()
      .toArray()
      .sort((a, b) => a.workerId.localeCompare(b.workerId));
  }
}
