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
  MediaOperationDestination,
  MlDestinationHealth,
  MlDestinationKind,
  MlWorkerRole,
  MlWorkload,
  RESTORATION_ML_WORKLOADS,
  RenderWorkerStatus,
} from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { CloudConnectionState, CloudMlGatewayDeps, resolveCloudGateway } from 'src/utils/frameleaf-cloud-gateway.js';
import { CloudErrorCode, FrameleafCloudError, cloudErrorCode, isLocalOnlyModel } from 'src/utils/frameleaf-cloud.js';
import { mapMlDestination, mlDestinationHealthOf } from 'src/utils/ml-destination-dto.js';
import {
  ML_BUDGET_WINDOW_DAYS,
  accelerationOf,
  hardwareFromProbe,
  hasRequiredConsent,
  healthFromProbe,
  insufficientMemoryDetail,
  isCloudDestination,
  mayMixRoles,
  mlWorkerRoleOf,
  resolveEndpoint,
  restorationRoleConflict,
  sameEndpointUrl,
  summarizeProbe,
  unresolvedEndpointSummary,
  workloadPolicyProblem,
} from 'src/utils/ml-destination.js';
import { SDR_ONLY, isQualifiedRenderSession } from 'src/utils/render-admission.js';

/**
 * The check summary a local destination carries while it is off because its URL left the
 * machine-learning URL list (FL-72). Only a destination carrying it is turned back on when the
 * URL returns.
 */
export const ML_URL_REMOVED_SUMMARY = 'Removed from the machine-learning URL list';

/**
 * FL-42: how long a destination's last check counts as evidence in the capability snapshot. The
 * periodic check runs every availability interval (30 s by default); anything older is stale and
 * never makes a workload available (admission itself always checks live).
 */
export const ML_CAPABILITY_FRESHNESS_MS = 15 * 60 * 1000;

/** Window over which measured throughput is averaged for estimates. */
export const ML_ESTIMATE_WINDOW_DAYS = 30;

const windowStart = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

/**
 * Administration of machine-learning destinations, workload routes, consent, cost controls
 * and health probes, plus the capability snapshot the Studio host reads (FL-110).
 *
 * Bootstrap creates a local destination for each configured ML URL and routes the library
 * workloads to the first one when they have no route; that is the only implicit creation,
 * and it is local. The Frameleaf Cloud destination is created only by an administrator (FL-159),
 * needs a separate versioned consent, and is never routed automatically.
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
   * has a route. Nothing here touches LAN or Frameleaf Cloud rows.
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
    if (dto.kind === MlDestinationKind.FrameleafCloud) {
      // FL-159: the Frameleaf Cloud destination is created only by POST admin/cloud/ml/destination,
      // never here, by configuration or by a seed.
      throw new BadRequestException('Add Frameleaf Cloud from its own settings section');
    }
    if (dto.kind === MlDestinationKind.Lan && !dto.url) {
      throw new BadRequestException('A LAN destination needs a URL');
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
    if (current.kind === MlDestinationKind.FrameleafCloud && (dto.url || dto.authToken)) {
      throw new BadRequestException('Frameleaf Cloud takes no URL or credential; it uses the link to this server');
    }
    if (current.kind === MlDestinationKind.Lan && dto.url === null) {
      throw new BadRequestException('A LAN destination needs a URL');
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
    if (current.kind === MlDestinationKind.FrameleafCloud) {
      return this.toDto(await this.grantCloudConsent(auth, current, dto));
    }
    const row = await this.mlDestinationRepository.update(id, {
      consentAcknowledgedAt: new Date(),
      consentAcknowledgedBy: auth.user.id,
    });
    return this.toDto(row);
  }

  /**
   * FL-159: Frameleaf Cloud consent is versioned. The administrator accepts exactly the version the
   * cloud requires now, with every feature choice explicit (all off by default). It is recorded with
   * Frameleaf Cloud (`POST /v2/consent`) and in `immich_fork.frameleaf_consent`; only then does the
   * destination carry it. If the cloud cannot be reached, nothing is recorded.
   */
  private async grantCloudConsent(auth: AuthDto, current: MlDestinationRow, dto: MlDestinationConsentRequestDto) {
    if (!dto.version) {
      throw new BadRequestException('Frameleaf Cloud consent names the version being accepted');
    }
    const features = {
      identityNames: dto.features?.identityNames ?? false,
      medicalSignals: dto.features?.medicalSignals ?? false,
      ocrAddon: dto.features?.ocrAddon ?? false,
    };
    const resolution = await resolveCloudGateway(this.cloudGatewayDeps());
    if (resolution.state !== CloudConnectionState.Ready) {
      throw new BadRequestException(resolution.detail);
    }
    let recordedVersion: string;
    try {
      const required = await this.frameleafCloudMlRepository.getConsent(resolution.gateway);
      if (required.requiredVersion !== dto.version) {
        throw new BadRequestException(
          `Frameleaf Cloud now asks for consent version ${required.requiredVersion}; review it and accept again`,
        );
      }
      recordedVersion = (
        await this.frameleafCloudMlRepository.recordConsent(resolution.gateway, { version: dto.version, features })
      ).recordedVersion;
    } catch (error) {
      if (error instanceof FrameleafCloudError) {
        // FL-183 (FC-34): consent is versioned; a disclosure that changed between reading and
        // recording is answered 403 consent-version-outdated with the version now required
        const required = error.envelope?.data?.requiredVersion;
        if (cloudErrorCode(error) === CloudErrorCode.ConsentVersionOutdated && typeof required === 'string') {
          throw new BadRequestException(
            `Frameleaf Cloud now asks for consent version ${required}; review it and accept again`,
          );
        }
        throw new BadRequestException(`Frameleaf Cloud did not record the consent: ${error.message}`);
      }
      throw error;
    }
    await this.frameleafConsentRepository.record({
      destinationId: current.id,
      version: dto.version,
      features,
      acceptedBy: auth.user.id,
      cloudRecordedVersion: recordedVersion,
    });
    return this.mlDestinationRepository.update(current.id, {
      consentAcknowledgedAt: new Date(),
      consentAcknowledgedBy: auth.user.id,
      consentVersion: dto.version,
    });
  }

  /**
   * Withdraw consent. For Frameleaf Cloud the consent records and the destination are cleared here
   * first, in one transaction (refused with 409 during a handoff, like recording it), then with
   * Frameleaf Cloud; whatever happens there, the withdrawal stands on this server, which refuses
   * every cloud job without consent, and a miss is logged.
   */
  async revokeConsent(id: string): Promise<MlDestinationResponseDto> {
    const current = await this.require(id);
    if (current.kind === MlDestinationKind.FrameleafCloud) {
      await this.frameleafConsentRepository.revoke(id);
      await this.revokeCloudConsent(current);
      return this.toDto(await this.require(id));
    }
    const row = await this.mlDestinationRepository.update(id, {
      consentAcknowledgedAt: null,
      consentAcknowledgedBy: null,
      consentVersion: null,
    });
    return this.toDto(row);
  }

  private async revokeCloudConsent(destination: MlDestinationRow) {
    try {
      const resolution = await resolveCloudGateway(this.cloudGatewayDeps());
      if (resolution.state !== CloudConnectionState.Ready) {
        this.logger.warn(
          `Consent for ${destination.name} was withdrawn on this server only; Frameleaf Cloud is not reachable (${resolution.detail})`,
        );
        return;
      }
      await this.frameleafCloudMlRepository.revokeConsent(resolution.gateway);
    } catch (error) {
      // Never undoes the local withdrawal, whatever went wrong on the way to the cloud.
      this.logger.warn(
        `Consent for ${destination.name} was withdrawn on this server only; Frameleaf Cloud did not record it: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private cloudGatewayDeps(): CloudMlGatewayDeps {
    return {
      configRepository: this.configRepository,
      databaseRepository: this.databaseRepository,
      systemMetadataRepository: this.systemMetadataRepository,
      instanceIdentityRepository: this.instanceIdentityRepository,
      frameleafCloudRepository: this.frameleafCloudRepository,
      eventRepository: this.eventRepository,
      logger: this.logger,
    };
  }

  /** Probe one destination now and persist the result. */
  async probe(id: string): Promise<MlDestinationHealthStateDto> {
    const row = await this.require(id);
    return this.probeRow(row);
  }

  private async probeRow(row: MlDestinationRow): Promise<MlDestinationHealthStateDto> {
    const endpoint = resolveEndpoint(row);
    const probedAt = new Date();
    if (!endpoint) {
      const summary = unresolvedEndpointSummary(row.kind);
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
    // Only metadata travels, so a cloud destination needs no consent for this (FL-114). Frameleaf
    // Cloud reports its models through its catalogue instead.
    let gpus: Array<{ name: string; memoryTotalBytes: number }> = [];
    if (
      !endpoint.cloud &&
      probe.reachable &&
      probe.workloads.some((workload) => RESTORATION_ML_WORKLOADS.includes(workload))
    ) {
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
      ...(probe.cloud !== undefined && { cloud: probe.cloud }),
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

    const endpoint = resolveEndpoint(row);
    if (!endpoint) {
      return unreachable(unresolvedEndpointSummary(row.kind));
    }
    if (endpoint.cloud) {
      return unreachable('Frameleaf Cloud models are listed in its catalogue under Frameleaf Cloud processing');
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
    const byWorkload = new Map(routes.map((route) => [route.workload, route]));
    return {
      routes: Object.values(MlWorkload).map((workload) => ({
        workload,
        destinationId: byWorkload.get(workload)?.destinationId ?? null,
        modelId: byWorkload.get(workload)?.modelId ?? null,
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
    // FL-159: a catalogue model is chosen per workload for Frameleaf Cloud only, and must be one the
    // cloud's catalogue listed at the last check.
    const modelId = dto.modelId ?? null;
    if (modelId !== null) {
      if (destination.kind !== MlDestinationKind.FrameleafCloud) {
        throw new BadRequestException('Only Frameleaf Cloud work names a catalogue model');
      }
      if (isLocalOnlyModel(modelId)) {
        throw new BadRequestException(`The model ${modelId} runs on this server only`);
      }
      if (!(destination.lastProbeCloud?.modelIds ?? []).includes(modelId)) {
        throw new BadRequestException(`The model ${modelId} is not in the Frameleaf Cloud catalogue`);
      }
    }
    await this.mlDestinationRepository.setRoute(workload, destination.id, modelId);
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
    const qualified = sessions.filter(({ worker, session }) =>
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
    const qualifiedRenderer = qualified.length > 0;
    const routed = new Map(routes.map((route) => [route.workload, route.destinationId]));

    const workloads: MlWorkloadCapabilityDto[] = Object.values(MlWorkload).map((workload) => {
      const destinations = rows.map((row) => {
        const consentGranted = hasRequiredConsent(row);
        // FL-72: restoration is never available on a local or LAN worker that is also allowed
        // library analysis, matching what admission would answer.
        const roleConflict =
          RESTORATION_ML_WORKLOADS.includes(workload) &&
          !mayMixRoles(row.kind) &&
          mlWorkerRoleOf(row.workloads) === MlWorkerRole.Mixed;
        // FL-42: a check older than the freshness window is not evidence; the destination is
        // checked again (admission always probes live) before it counts as available.
        const checkedAt = row.lastProbeAt ? new Date(row.lastProbeAt) : null;
        const stale = !checkedAt || now.getTime() - checkedAt.getTime() > ML_CAPABILITY_FRESHNESS_MS;
        const available =
          row.enabled &&
          consentGranted &&
          !roleConflict &&
          !stale &&
          row.workloads.includes(workload) &&
          row.lastProbeHealth === MlDestinationHealth.Healthy &&
          (row.lastProbeWorkloads ?? []).includes(workload) &&
          // FL-58: a worker that reported too little GPU memory for the workload is not offered.
          insufficientMemoryDetail(row, workload) === null;
        const gpus = row.lastProbeHardware?.gpus ?? [];
        return {
          id: row.id,
          kind: row.kind,
          name: row.name,
          health: row.lastProbeHealth,
          consentGranted,
          available,
          leavesNetwork: isCloudDestination(row.kind),
          region: row.region,
          checkedAt: checkedAt ? checkedAt.toISOString() : null,
          stale,
          acceleration: accelerationOf(row.lastProbeHardware),
          gpuMemoryBytes: gpus.length > 0 ? Math.max(...gpus.map((gpu) => gpu.memoryTotalBytes)) : null,
          servedWorkloads: row.lastProbeWorkloads,
        };
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

    // FL-42: what qualified sessions verified, per destination, so the Studio host can offer only
    // exports some worker can actually produce.
    const byDestination = new Map<MediaOperationDestination, typeof qualified>();
    for (const entry of qualified) {
      const list = byDestination.get(entry.worker.destination) ?? [];
      list.push(entry);
      byDestination.set(entry.worker.destination, list);
    }
    const render = [...byDestination].map(([destination, entries]) => {
      const memories = entries
        .map(({ session }) => (session.gpuMemoryBytes === null ? null : Number(session.gpuMemoryBytes)))
        .filter((value): value is number => value !== null);
      const precisions = entries.map(({ session }) => session.colorPrecision ?? SDR_ONLY);
      return {
        destination,
        gpuMemoryBytes: memories.length > 0 ? Math.max(...memories) : null,
        codecs: [...new Set(entries.flatMap(({ session }) => session.codecs ?? []))].toSorted(),
        maxBitDepth: Math.max(...precisions.map((precision) => precision.maxBitDepth)),
        hdr10: precisions.some((precision) => precision.hdr10),
        dolbyVision: precisions.some((precision) => precision.dolbyVision),
        sessions: entries.length,
      };
    });

    return {
      workloads,
      studio: {
        gpuWorker: qualifiedRenderer,
        renderWorker: qualifiedRenderer,
        restorationWorker: available(MlWorkload.RestorationFaithful) || available(MlWorkload.RestorationCreative),
        transcriptionWorker: available(MlWorkload.StudioAi),
        render,
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
   * FL-72: library analysis and restoration never share a local or LAN worker; Frameleaf Cloud runs
   * only the workloads it offers (FL-159). The shared-hardware flag only means something on a local
   * or LAN restoration worker.
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
    return mlDestinationHealthOf(row);
  }

  private async toDto(row: MlDestinationRow): Promise<MlDestinationResponseDto> {
    const spentUsd =
      row.budgetLimitUsd === null
        ? 0
        : await this.mlDestinationRepository.getSpend(row.id, windowStart(ML_BUDGET_WINDOW_DAYS));
    return mapMlDestination(row, spentUsd);
  }
}
