import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { ArgOf } from 'src/repositories/event.repository.js';
import type { MlDestinationRow } from 'src/repositories/ml-destination.repository.js';
import { OnEvent } from 'src/decorators.js';
import {
  MlAdmissionRequestDto,
  MlAdmissionResponseDto,
  MlCapabilitiesResponseDto,
  MlDestinationConsentRequestDto,
  MlDestinationCreateDto,
  MlDestinationHealthStateDto,
  MlDestinationResponseDto,
  MlDestinationUpdateDto,
  MlWorkloadCapabilityDto,
  MlWorkloadRouteUpdateDto,
  MlWorkloadRoutesResponseDto,
} from 'src/dtos/ml-destination.dto.js';
import { MlRestorationModelsResponseDto } from 'src/dtos/restoration-inference.dto.js';
import {
  BootstrapEventPriority,
  DatabaseLock,
  ImmichWorker,
  LIBRARY_ML_WORKLOADS,
  MlDestinationHealth,
  MlDestinationKind,
  MlWorkerRole,
  MlWorkload,
  RESTORATION_ML_WORKLOADS,
  RenderWorkerStatus,
} from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import {
  ML_BUDGET_WINDOW_DAYS,
  hardwareFromProbe,
  hasRequiredConsent,
  healthFromProbe,
  insufficientMemoryDetail,
  isCloudDestination,
  mlWorkerRoleOf,
  resolveEndpoint,
  restorationRoleConflict,
  sameEndpointUrl,
  summarizeProbe,
  workloadPolicyProblem,
} from 'src/utils/ml-destination.js';
import { isQualifiedRenderSession } from 'src/utils/render-admission.js';

/**
 * The check summary a local destination carries while it is off because its URL left the
 * machine-learning URL list (FL-72). Only a destination carrying it is turned back on when the
 * URL returns.
 */
export const ML_URL_REMOVED_SUMMARY = 'Removed from the machine-learning URL list';

/** Window over which measured throughput is averaged for estimates. */
export const ML_ESTIMATE_WINDOW_DAYS = 30;

const windowStart = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

/**
 * Administration of machine-learning destinations, workload routes, consent, cost controls
 * and health probes, plus the capability snapshot the Studio host reads (FL-110).
 *
 * Bootstrap creates a local destination for each configured ML URL and routes the library
 * workloads to the first one when they have no route; that is the only implicit creation,
 * and it is local. RunPod destinations are created by an administrator, need a separate
 * recorded consent, and are never routed automatically.
 */
@Injectable()
export class MlDestinationService extends BaseService {
  private probeHandle?: ReturnType<typeof setInterval>;

  @OnEvent({ name: 'ConfigInit', priority: BootstrapEventPriority.SystemConfig + 2 })
  async onConfigInit({ newConfig }: ArgOf<'ConfigInit'>) {
    await this.reconcile(newConfig.machineLearning);
  }

  @OnEvent({ name: 'ConfigUpdate', server: true })
  async onConfigUpdate({ newConfig }: ArgOf<'ConfigUpdate'>) {
    await this.reconcile(newConfig.machineLearning);
  }

  @OnEvent({ name: 'AppShutdown' })
  onShutdown() {
    this.stopProbing();
  }

  private async reconcile(machineLearning: {
    urls: string[];
    availabilityChecks: { enabled: boolean; interval: number };
  }) {
    try {
      await this.databaseRepository.withLock(DatabaseLock.MlDestinationBootstrap, () =>
        this.ensureLocalDestinations(machineLearning.urls),
      );
    } catch (error) {
      this.logger.warn(`Could not reconcile local machine-learning destinations: ${error}`);
    }

    this.stopProbing();
    if (machineLearning.availabilityChecks.enabled && this.configRepository.getWorker() === ImmichWorker.Api) {
      this.probeHandle = setInterval(() => {
        void this.probeAll().catch((error) => this.logger.warn(`Destination probe sweep failed: ${error}`));
      }, machineLearning.availabilityChecks.interval);
    }
  }

  private stopProbing() {
    if (!this.probeHandle) {
      return;
    }

    clearInterval(this.probeHandle);
    this.probeHandle = undefined;
  }

  /**
   * Make sure every configured ML URL has a local destination and every library workload
   * has a route. Nothing here touches LAN or RunPod rows.
   *
   * FL-72: a local destination whose URL has left the list is turned off, so work routed to it
   * is refused (its routes stay; nothing moves to another endpoint) until an administrator
   * routes that work elsewhere. If the URL is added back, the destination this rule turned off
   * is turned on again; one an administrator turned off stays off.
   */
  private async ensureLocalDestinations(urls: string[]) {
    let first: MlDestinationRow | undefined;
    for (const url of urls) {
      let row = await this.mlDestinationRepository.getByUrl(MlDestinationKind.Local, url);
      if (row && !row.enabled && row.lastProbeSummary === ML_URL_REMOVED_SUMMARY) {
        row = await this.mlDestinationRepository.update(row.id, { enabled: true });
        await this.mlDestinationRepository.recordProbe(row.id, {
          health: MlDestinationHealth.Unknown,
          summary: null,
          workloads: null,
          probedAt: new Date(),
          hardware: null,
          latencyMs: null,
        });
        this.logger.log(`Turned local machine-learning destination ${row.name} back on: ${url} is listed again`);
      }
      if (!row) {
        row = await this.mlDestinationRepository.create({
          kind: MlDestinationKind.Local,
          name: urls.length === 1 ? 'This server' : `This server (${new URL(url).host})`,
          url,
          authToken: null,
          enabled: true,
          workloads: [...LIBRARY_ML_WORKLOADS],
          budgetLimitUsd: null,
          maxRuntimeMinutes: null,
          maxUploadBytes: null,
        });
        this.logger.log(`Created local machine-learning destination for ${url}`);
      }
      first ??= row;
    }

    if (urls.length > 0) {
      for (const row of await this.mlDestinationRepository.getAll()) {
        const listed = row.url !== null && urls.some((url) => sameEndpointUrl(url, row.url as string));
        if (row.kind !== MlDestinationKind.Local || !row.enabled || listed) {
          continue;
        }
        await this.mlDestinationRepository.update(row.id, { enabled: false });
        await this.mlDestinationRepository.recordProbe(row.id, {
          health: MlDestinationHealth.Unhealthy,
          summary: ML_URL_REMOVED_SUMMARY,
          workloads: null,
          probedAt: new Date(),
          hardware: null,
          latencyMs: null,
        });
        this.logger.log(`Turned off local machine-learning destination ${row.name}: ${row.url} left the URL list`);
      }
    }

    if (!first) {
      return;
    }

    for (const workload of LIBRARY_ML_WORKLOADS) {
      const route = await this.mlDestinationRepository.getRoute(workload);
      if (route) {
        continue;
      }
      // FL-58: a library workload added after this destination was created (pet recognition) is
      // allowed on it as it is routed there, so the route is usable. Only this server's own local
      // container is ever changed, and never into a worker that would also run restoration.
      if (!first.workloads.includes(workload)) {
        const workloads = [...first.workloads, workload];
        if (workloadPolicyProblem(first.kind, workloads)) {
          this.logger.log(`Left ${workload} unrouted: ${first.name} is not a library-analysis worker`);
          continue;
        }
        first = await this.mlDestinationRepository.update(first.id, { workloads });
      }
      await this.mlDestinationRepository.setRoute(workload, first.id);
      this.logger.log(`Routed ${workload} to local destination ${first.name}`);
    }
  }

  async list(): Promise<MlDestinationResponseDto[]> {
    const rows = await this.mlDestinationRepository.getAll();
    return Promise.all(rows.map((row) => this.toDto(row)));
  }

  async get(id: string): Promise<MlDestinationResponseDto> {
    return this.toDto(await this.require(id));
  }

  async create(dto: MlDestinationCreateDto): Promise<MlDestinationResponseDto> {
    if (dto.kind === MlDestinationKind.RunPod) {
      if (dto.url || dto.authToken) {
        throw new BadRequestException('A RunPod destination takes its URL and credentials from the RunPod service');
      }
      const existing = (await this.mlDestinationRepository.getAll()).some(
        (row) => row.kind === MlDestinationKind.RunPod,
      );
      if (existing) {
        throw new BadRequestException('There is already a RunPod destination; edit it instead');
      }
    } else if (dto.kind === MlDestinationKind.Lan && !dto.url) {
      throw new BadRequestException('A LAN destination needs a URL');
    } else if (dto.kind === MlDestinationKind.RunPodVideo && !dto.url) {
      throw new BadRequestException('A RunPod video worker needs the URL of the persistent worker');
    }
    const workloads = this.uniqueWorkloads(dto.workloads);
    this.assertWorkloadPolicy(dto.kind, workloads, dto.sharesLibraryHardware ?? false);

    const row = await this.mlDestinationRepository.create({
      kind: dto.kind,
      name: dto.name,
      url: dto.url ?? null,
      authToken: dto.authToken ?? null,
      enabled: dto.enabled,
      workloads,
      budgetLimitUsd: dto.budgetLimitUsd ?? null,
      maxRuntimeMinutes: dto.maxRuntimeMinutes ?? null,
      maxUploadBytes: dto.maxUploadBytes ?? null,
      sharesLibraryHardware: dto.sharesLibraryHardware ?? false,
    });
    return this.toDto(row);
  }

  async update(id: string, dto: MlDestinationUpdateDto): Promise<MlDestinationResponseDto> {
    const current = await this.require(id);
    if (current.kind === MlDestinationKind.RunPod && (dto.url || dto.authToken)) {
      throw new BadRequestException('A RunPod destination takes its URL and credentials from the RunPod service');
    }
    if (current.kind === MlDestinationKind.Lan && dto.url === null) {
      throw new BadRequestException('A LAN destination needs a URL');
    }
    if (current.kind === MlDestinationKind.RunPodVideo && dto.url === null) {
      throw new BadRequestException('A RunPod video worker needs the URL of the persistent worker');
    }
    const nextWorkloads = dto.workloads === undefined ? current.workloads : this.uniqueWorkloads(dto.workloads);
    // Checked only when the allowed work changes, so a row saved before FL-72 that mixes roles
    // can still be renamed or disabled; its restoration work is refused at admission meanwhile.
    if (dto.workloads !== undefined || dto.sharesLibraryHardware !== undefined) {
      this.assertWorkloadPolicy(
        current.kind,
        nextWorkloads,
        dto.sharesLibraryHardware ?? current.sharesLibraryHardware,
      );
    }

    const row = await this.mlDestinationRepository.update(id, {
      name: dto.name,
      url: dto.url === undefined ? undefined : dto.url,
      authToken: dto.authToken === undefined ? undefined : dto.authToken,
      enabled: dto.enabled,
      workloads: dto.workloads === undefined ? undefined : nextWorkloads,
      budgetLimitUsd: dto.budgetLimitUsd,
      maxRuntimeMinutes: dto.maxRuntimeMinutes,
      maxUploadBytes: dto.maxUploadBytes,
      sharesLibraryHardware: dto.sharesLibraryHardware,
    });
    return this.toDto(row);
  }

  async delete(id: string): Promise<void> {
    await this.require(id);
    // Routes cascade with the row, so the workloads that pointed here become unrouted and
    // their jobs are refused until an administrator routes them again. That is the point:
    // a removed destination never redirects work elsewhere.
    await this.mlDestinationRepository.delete(id);
  }

  async grantConsent(
    auth: AuthDto,
    id: string,
    dto: MlDestinationConsentRequestDto,
  ): Promise<MlDestinationResponseDto> {
    if (!dto.acknowledgeMediaLeavesNetwork) {
      throw new BadRequestException('Consent must be acknowledged explicitly');
    }
    const current = await this.require(id);
    if (!isCloudDestination(current.kind)) {
      throw new BadRequestException(`${current.name} keeps media on this network and needs no consent`);
    }
    const row = await this.mlDestinationRepository.update(id, {
      consentAcknowledgedAt: new Date(),
      consentAcknowledgedBy: auth.user.id,
    });
    return this.toDto(row);
  }

  async revokeConsent(id: string): Promise<MlDestinationResponseDto> {
    await this.require(id);
    const row = await this.mlDestinationRepository.update(id, {
      consentAcknowledgedAt: null,
      consentAcknowledgedBy: null,
    });
    return this.toDto(row);
  }

  /** Probe one destination now and persist the result. */
  async probe(id: string): Promise<MlDestinationHealthStateDto> {
    const row = await this.require(id);
    return this.probeRow(row);
  }

  private async probeRow(row: MlDestinationRow): Promise<MlDestinationHealthStateDto> {
    const endpoint = resolveEndpoint(row, this.machineLearningRepository.getRunPodEndpoint());
    const probedAt = new Date();
    if (!endpoint) {
      const summary =
        row.kind === MlDestinationKind.RunPod ? 'No running pod or ready serverless worker' : 'No URL configured';
      await this.mlDestinationRepository.recordProbe(row.id, {
        health: MlDestinationHealth.Unhealthy,
        summary,
        workloads: null,
        probedAt,
        hardware: null,
        latencyMs: null,
      });
      return {
        status: MlDestinationHealth.Unhealthy,
        probedAt: probedAt.toISOString(),
        summary,
        servedWorkloads: null,
      };
    }

    const probe = await this.machineLearningRepository.probe(endpoint);
    const health = healthFromProbe(probe);
    const summary = summarizeProbe(probe);
    const servedWorkloads = probe.reachable ? probe.workloads : null;
    // A restoration worker names its GPUs and their memory; the /predict container does not.
    // Only metadata travels, so a cloud destination needs no consent for this (FL-114).
    let gpus: Array<{ name: string; memoryTotalBytes: number }> = [];
    if (probe.reachable && probe.workloads.some((workload) => RESTORATION_ML_WORKLOADS.includes(workload))) {
      try {
        const report = await this.machineLearningRepository.getRestorationModels(endpoint);
        gpus = report.gpus.map((gpu) => ({ name: gpu.name, memoryTotalBytes: gpu.memoryTotalBytes }));
      } catch (error) {
        this.logger.debug(`Could not read restoration GPUs from ${row.name}: ${error}`);
      }
    }
    await this.mlDestinationRepository.recordProbe(row.id, {
      health,
      summary,
      workloads: servedWorkloads,
      probedAt: probe.probedAt,
      hardware: hardwareFromProbe(probe, gpus),
      latencyMs: probe.reachable ? probe.latencyMs : null,
    });
    return { status: health, probedAt: probe.probedAt.toISOString(), summary, servedWorkloads };
  }

  private async probeAll() {
    const rows = await this.mlDestinationRepository.getAll();
    for (const row of rows) {
      if (row.enabled) {
        await this.probeRow(row);
      }
    }
  }

  /**
   * Ask one destination which restoration models it has and why each is or is not available
   * (FL-114). Only metadata travels; no media is sent, so a cloud destination needs no consent
   * for this. An unreachable destination, or one that does not run the restoration worker, is
   * reported as such rather than as an error.
   */
  async getRestorationModels(id: string): Promise<MlRestorationModelsResponseDto> {
    const row = await this.require(id);
    const unreachable = (error: string): MlRestorationModelsResponseDto => ({
      destinationId: row.id,
      reachable: false,
      error,
      workloads: [],
      models: [],
      gpus: [],
      configurationProblems: [],
      checkedAt: null,
    });

    const endpoint = resolveEndpoint(row, this.machineLearningRepository.getRunPodEndpoint());
    if (!endpoint) {
      return unreachable(
        row.kind === MlDestinationKind.RunPod ? 'No running pod or ready serverless worker' : 'No URL configured',
      );
    }

    try {
      const report = await this.machineLearningRepository.getRestorationModels(endpoint);
      return {
        destinationId: row.id,
        reachable: true,
        error: null,
        workloads: report.workloads,
        models: report.models,
        gpus: report.gpus,
        configurationProblems: report.configurationProblems,
        checkedAt: report.checkedAt,
      };
    } catch (error) {
      return unreachable(error instanceof Error ? error.message : String(error));
    }
  }

  async getRoutes(): Promise<MlWorkloadRoutesResponseDto> {
    const routes = await this.mlDestinationRepository.getRoutes();
    const byWorkload = new Map(routes.map((route) => [route.workload, route.destinationId]));
    return {
      routes: Object.values(MlWorkload).map((workload) => ({
        workload,
        destinationId: byWorkload.get(workload) ?? null,
      })),
    };
  }

  async setRoute(workload: MlWorkload, dto: MlWorkloadRouteUpdateDto): Promise<MlWorkloadRoutesResponseDto> {
    if (dto.destinationId === null) {
      await this.mlDestinationRepository.clearRoute(workload);
      return this.getRoutes();
    }
    const destination = await this.require(dto.destinationId);
    if (!destination.workloads.includes(workload)) {
      throw new BadRequestException(`${destination.name} is not allowed to run ${workload}`);
    }
    if (!hasRequiredConsent(destination)) {
      throw new BadRequestException(
        `${destination.name} sends media off this network; record consent before routing to it`,
      );
    }
    // FL-72: a restoration route never lands on an endpoint library analysis uses.
    const conflict = await restorationRoleConflict(
      {
        mlDestinationRepository: this.mlDestinationRepository,
        machineLearningRepository: this.machineLearningRepository,
      },
      destination,
      workload,
    );
    if (conflict) {
      throw new BadRequestException(conflict);
    }
    await this.mlDestinationRepository.setRoute(workload, destination.id);
    return this.getRoutes();
  }

  /**
   * The per-request selection API over HTTP: admit `workload` against exactly the named
   * destination. Refusals surface as 4xx errors carrying the refusal code; nothing here ever
   * answers with a different destination.
   */
  async admit(id: string, dto: MlAdmissionRequestDto): Promise<MlAdmissionResponseDto> {
    const selection = await this.selectMlDestination({
      workload: dto.workload,
      destinationId: id,
      jobId: dto.jobId ?? null,
    });
    const row = await this.require(id);
    const sample = await this.mlDestinationRepository.getThroughput(
      id,
      windowStart(ML_ESTIMATE_WINDOW_DAYS),
      dto.workload,
    );
    return {
      destinationId: selection.destinationId,
      kind: selection.kind,
      workload: selection.workload,
      health: this.healthOf(row),
      estimate: {
        sampleCount: sample.sampleCount,
        bytesPerSecond:
          sample.sampleCount > 0 && sample.durationMs > 0 ? (sample.bytesSent * 1000) / sample.durationMs : null,
        windowDays: ML_ESTIMATE_WINDOW_DAYS,
      },
    };
  }

  /**
   * What this deployment can run right now, per workload, from the persisted probe state.
   * The Studio host reads `studio`. gpuWorker and renderWorker come from render worker admission
   * (FL-95, FL-104): they are true only while an admitted session is live, unrevoked, and still
   * carries fresh conformance evidence on the engine digest its worker is pinned to (FL-42).
   */
  async getCapabilities(): Promise<MlCapabilitiesResponseDto> {
    const [rows, routes, sessions] = await Promise.all([
      this.mlDestinationRepository.getAll(),
      this.mlDestinationRepository.getRoutes(),
      this.renderWorkerRepository.listLiveSessions(),
    ]);
    const now = new Date();
    const qualifiedRenderer = sessions.some(({ worker, session }) =>
      isQualifiedRenderSession({
        worker: {
          revoked: worker.status !== RenderWorkerStatus.Active,
          engineDigest: worker.engineDigest,
          conformanceMaxAgeMs: worker.conformanceMaxAgeMs,
        },
        session: {
          revoked: session.revokedAt !== null,
          expiresAt: new Date(session.expiresAt),
          engineDigest: session.engineDigest,
          conformanceReportedAt: new Date(session.conformanceReportedAt),
          scopes: session.scopes,
        },
        now,
      }),
    );
    const routed = new Map(routes.map((route) => [route.workload, route.destinationId]));

    const workloads: MlWorkloadCapabilityDto[] = Object.values(MlWorkload).map((workload) => {
      const destinations = rows.map((row) => {
        const consentGranted = hasRequiredConsent(row);
        // FL-72: restoration is never available on the library-analysis pod or on a worker that
        // is also allowed library analysis, matching what admission would answer.
        const roleConflict =
          RESTORATION_ML_WORKLOADS.includes(workload) &&
          (row.kind === MlDestinationKind.RunPod || mlWorkerRoleOf(row.workloads) === MlWorkerRole.Mixed);
        const available =
          row.enabled &&
          consentGranted &&
          !roleConflict &&
          row.workloads.includes(workload) &&
          row.lastProbeHealth === MlDestinationHealth.Healthy &&
          (row.lastProbeWorkloads ?? []).includes(workload) &&
          // FL-58: a worker that reported too little GPU memory for the workload is not offered.
          insufficientMemoryDetail(row, workload) === null;
        return { id: row.id, kind: row.kind, name: row.name, health: row.lastProbeHealth, consentGranted, available };
      });
      return {
        workload,
        available: destinations.some((destination) => destination.available),
        routedDestinationId: routed.get(workload) ?? null,
        destinations,
      };
    });

    const available = (workload: MlWorkload) =>
      workloads.find((entry) => entry.workload === workload)?.available ?? false;

    return {
      workloads,
      studio: {
        gpuWorker: qualifiedRenderer,
        renderWorker: qualifiedRenderer,
        restorationWorker: available(MlWorkload.RestorationFaithful) || available(MlWorkload.RestorationCreative),
        transcriptionWorker: available(MlWorkload.StudioAi),
      },
      probedAt: new Date().toISOString(),
    };
  }

  private async require(id: string): Promise<MlDestinationRow> {
    const row = await this.mlDestinationRepository.getById(id);
    if (!row) {
      throw new NotFoundException(`Machine learning destination ${id} does not exist`);
    }
    return row;
  }

  private uniqueWorkloads(workloads: MlWorkload[]): MlWorkload[] {
    return [...new Set(workloads)];
  }

  /**
   * FL-72: library analysis and restoration never share a worker, the managed RunPod pod is a
   * library-analysis worker and a RunPod video worker runs restoration only. The shared-hardware
   * flag only means something on a restoration worker.
   */
  private assertWorkloadPolicy(kind: MlDestinationKind, workloads: MlWorkload[], sharesLibraryHardware: boolean) {
    const problem = workloadPolicyProblem(kind, workloads);
    if (problem) {
      throw new BadRequestException(problem);
    }
    if (sharesLibraryHardware && workloads.every((workload) => !RESTORATION_ML_WORKLOADS.includes(workload))) {
      throw new BadRequestException(
        'Only a restoration worker can be marked as sharing hardware with library analysis',
      );
    }
    if (sharesLibraryHardware && isCloudDestination(kind)) {
      throw new BadRequestException('A cloud worker cannot share a GPU with library analysis on this network');
    }
  }

  private healthOf(row: MlDestinationRow): MlDestinationHealthStateDto {
    return {
      status: row.lastProbeHealth,
      probedAt: row.lastProbeAt ? new Date(row.lastProbeAt).toISOString() : null,
      summary: row.lastProbeSummary,
      servedWorkloads: row.lastProbeWorkloads,
    };
  }

  private async toDto(row: MlDestinationRow): Promise<MlDestinationResponseDto> {
    const spentUsd =
      row.budgetLimitUsd === null
        ? 0
        : await this.mlDestinationRepository.getSpend(row.id, windowStart(ML_BUDGET_WINDOW_DAYS));
    const endpoint = resolveEndpoint(row, this.machineLearningRepository.getRunPodEndpoint());
    return {
      id: row.id,
      kind: row.kind,
      name: row.name,
      url: endpoint?.url ?? null,
      authTokenConfigured:
        row.kind === MlDestinationKind.RunPod ? Boolean(endpoint?.authToken) : row.authToken !== null,
      enabled: row.enabled,
      workloads: row.workloads,
      role: mlWorkerRoleOf(row.workloads),
      sharesLibraryHardware: row.sharesLibraryHardware,
      consent: {
        required: isCloudDestination(row.kind),
        acknowledgedAt: row.consentAcknowledgedAt ? new Date(row.consentAcknowledgedAt).toISOString() : null,
        acknowledgedBy: row.consentAcknowledgedBy,
      },
      costControls: {
        budgetLimitUsd: row.budgetLimitUsd,
        maxRuntimeMinutes: row.maxRuntimeMinutes,
        maxUploadBytes: row.maxUploadBytes === null ? null : Number(row.maxUploadBytes),
        spentUsd,
        budgetWindowDays: ML_BUDGET_WINDOW_DAYS,
      },
      health: this.healthOf(row),
      createdAt: new Date(row.createdAt).toISOString(),
      updatedAt: new Date(row.updatedAt).toISOString(),
    };
  }
}
