import { BadRequestException, Injectable } from '@nestjs/common';
import type { SystemConfig } from 'src/config.js';
import type { CloudMlGateway } from 'src/repositories/frameleaf-cloud-ml.repository.js';
import type { MachineLearningHardwareResponse, MlEndpointProbe } from 'src/repositories/machine-learning.repository.js';
import type { MlDestinationRow } from 'src/repositories/ml-destination.repository.js';
import type { FrameleafMlWallet } from 'src/types.js';
import { OnEvent } from 'src/decorators.js';
import {
  CloudMlCatalogResponseDto,
  CloudMlConsentHistoryResponseDto,
  CloudMlDestinationCreateDto,
  CloudMlSettlementsResponseDto,
  CloudMlStatusResponseDto,
  CloudMlWalletDto,
  CloudMlWalletUpdateDto,
} from 'src/dtos/cloud-ml.dto.js';
import { MlDestinationResponseDto } from 'src/dtos/ml-destination.dto.js';
import {
  FRAMELEAF_CLOUD_ML_WORKLOADS,
  ImmichWorker,
  MachineLearningHardwareAcceleration,
  MlAdmissionRefusal,
  MlDestinationKind,
  MlWorkload,
  NotificationLevel,
  NotificationType,
  SystemMetadataKey,
} from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import {
  CloudConnectionState,
  CloudGatewayDeps,
  CloudGatewayResolution,
  resolveCloudGateway,
} from 'src/utils/frameleaf-cloud-gateway.js';
import {
  CloudProbeFacts,
  CloudUsage,
  FrameleafCloudError,
  cloudFactsFromCapabilities,
  isLocalOnlyModel,
  knownWorkloads,
} from 'src/utils/frameleaf-cloud.js';
import { mapMlDestination } from 'src/utils/ml-destination-dto.js';
import { ML_BUDGET_WINDOW_DAYS, workloadPolicyProblem } from 'src/utils/ml-destination.js';

/** The routed kind of work (Where each job runs) each cloud workload belongs to. */
const ROUTED_KIND: Partial<
  Record<MlWorkload, 'descriptions' | 'upscale' | 'restoration' | 'studio' | 'interpolation'>
> = {
  [MlWorkload.Enrichment]: 'descriptions',
  [MlWorkload.Upscale]: 'upscale',
  [MlWorkload.RestorationFaithful]: 'restoration',
  [MlWorkload.RestorationCreative]: 'restoration',
  [MlWorkload.StudioAi]: 'studio',
  [MlWorkload.Interpolation]: 'interpolation',
};

/** Whether the administrator allowed this workload on Frameleaf Cloud ("Both" or "Cloud only"). */
export const cloudRouteAllows = (
  cloudMl: Pick<SystemConfig['frameleafCloud']['cloudMl'], 'routing'>,
  workload: MlWorkload,
): boolean => {
  const kind = ROUTED_KIND[workload];
  return !!kind && cloudMl.routing[kind] !== 'local';
};

/** How many settled charges the processing section lists. */
const CLOUD_ML_SETTLEMENT_LIMIT = 50;

/** How far back a usage reconcile looks for settlements. */
export const CLOUD_ML_USAGE_WINDOW_DAYS = 30;

const emptyFeatures = { identityNames: false, medicalSignals: false, ocrAddon: false };

const refusedFacts = (refusal: MlAdmissionRefusal, detail: string, region: string | null = null): CloudProbeFacts => ({
  region,
  consentRequiredVersion: null,
  consentRecordedVersion: null,
  features: emptyFeatures,
  entitled: false,
  balanceUsd: 0,
  heldUsd: 0,
  dailyCapUsd: null,
  spentTodayUsd: 0,
  limits: {},
  catalogEtag: null,
  modelIds: [],
  refusal: { refusal, detail },
});

/**
 * Frameleaf Cloud as the processing destination (FL-159, CLD-201; replaces the previous GPU-provider
 * integration per the FL-146 owner decision of 2026-09-25).
 *
 * - The destination row exists only after `createDestination` (`POST admin/cloud/ml/destination`):
 *   never from configuration or a seed, never with a URL or token.
 * - `probe` is the check `MachineLearningRepository.probe` delegates to for the cloud destination: it
 *   reads `/ping`, `/capabilities`, `/hardware` and `/v2/catalog` from the regional gateway and
 *   turns the answer (or the error envelope) into `CloudProbeFacts` that admission decides on.
 * - Nothing is contacted unless `FRAMELEAF_CLOUD_URL` is configured, the server is linked, and
 *   Frameleaf Cloud processing is turned on. Every failure refuses the cloud destination; no work is
 *   ever moved to another destination.
 */
@Injectable()
export class CloudMlService extends BaseService {
  private lastProbe?: { at: number; probe: MlEndpointProbe };

  @OnEvent({ name: 'AppBootstrap' })
  async onBootstrap() {
    this.machineLearningRepository.setCloudProber(({ maxAgeMs }) => this.probe(maxAgeMs));
    if (this.configRepository.getWorker() === ImmichWorker.Api) {
      await this.deliverMigrationNotice();
    }
  }

  @OnEvent({ name: 'AppShutdown' })
  onShutdown() {
    this.machineLearningRepository.setCloudProber(null);
  }

  /** What the Frameleaf Cloud processing section shows. Contacts the cloud only when linked and turned on. */
  async getStatus(): Promise<CloudMlStatusResponseDto> {
    const config = await this.getConfig({ withCache: false });
    const enabled = config.frameleafCloud.cloudMl.enabled;
    const destination = await this.findDestination();
    const resolution = await resolveCloudGateway(this.gatewayDeps());
    const wallet = await this.systemMetadataRepository.get(SystemMetadataKey.FrameleafMlWallet);

    const status: CloudMlStatusResponseDto = {
      connection: resolution.state,
      detail: resolution.state === CloudConnectionState.Ready ? null : resolution.detail,
      enabled,
      region: resolution.link?.dataRegion ?? destination?.region ?? null,
      entitled: destination?.lastProbeCloud?.refusal ? null : (destination?.lastProbeCloud?.entitled ?? null),
      destination: destination ? await this.toDto(destination) : null,
      consent: null,
      wallet: wallet ? this.toWalletDto(wallet) : null,
      checkedAt: new Date().toISOString(),
    };
    if (resolution.state !== CloudConnectionState.Ready) {
      return status;
    }

    try {
      const consent = await this.frameleafCloudMlRepository.getConsent(resolution.gateway);
      const accepted = destination?.consentVersion ?? null;
      status.consent = {
        requiredVersion: consent.requiredVersion,
        recordedVersion: consent.recordedVersion,
        acceptedVersion: accepted,
        features: consent.features,
        summary: consent.summary,
        documentUrl: consent.documentUrl,
        outdated: accepted !== null && accepted !== consent.requiredVersion,
      };
      status.wallet = this.toWalletDto(await this.refreshWallet(resolution.gateway));
      if (destination) {
        // Settled costs land on the accounting rows so spend and budgets reflect what was charged.
        await this.reconcileUsage().catch((error) =>
          this.logger.warn(`Frameleaf Cloud usage reconcile failed: ${error}`),
        );
      }
    } catch (error) {
      if (!(error instanceof FrameleafCloudError)) {
        throw error;
      }
      status.connection = CloudConnectionState.Unavailable;
      status.detail = error.message;
    }
    return status;
  }

  /** `POST admin/cloud/ml/destination`: the only way the Frameleaf Cloud destination is created. */
  async createDestination(dto: CloudMlDestinationCreateDto): Promise<MlDestinationResponseDto> {
    const workloads = [...new Set(dto.workloads)];
    const problem = workloadPolicyProblem(MlDestinationKind.FrameleafCloud, workloads);
    if (problem) {
      throw new BadRequestException(problem);
    }
    if (await this.findDestination()) {
      throw new BadRequestException('Frameleaf Cloud is already added; change it instead');
    }
    const resolution = await resolveCloudGateway(this.gatewayDeps());
    if (
      resolution.state === CloudConnectionState.NotConfigured ||
      resolution.state === CloudConnectionState.NotLinked
    ) {
      throw new BadRequestException(resolution.detail);
    }
    const row = await this.mlDestinationRepository.create({
      kind: MlDestinationKind.FrameleafCloud,
      name: dto.name,
      url: null,
      authToken: null,
      // Added switched on but unusable until consent is recorded; never routed automatically.
      enabled: true,
      workloads,
      budgetLimitUsd: dto.budgetLimitUsd ?? null,
      maxRuntimeMinutes: null,
      maxUploadBytes: null,
      sharesLibraryHardware: false,
      region: resolution.link?.dataRegion ?? null,
    });
    return this.toDto(row);
  }

  /** The AI Wallet, read now from Frameleaf Cloud and cached for the section and the overview. */
  async getWallet(): Promise<CloudMlWalletDto> {
    const gateway = await this.requireGateway();
    return this.toWalletDto(await this.refreshWallet(gateway));
  }

  /**
   * Change the account's daily cap or automatic top-up (`PATCH /v2/wallet`). Card details never
   * pass through this server: automatic top-up uses the payment method saved on frameleaf.cloud.
   */
  async updateWallet(dto: CloudMlWalletUpdateDto): Promise<CloudMlWalletDto> {
    const gateway = await this.requireGateway();
    const settings = {
      ...(dto.dailyCapUsd !== undefined && { dailyCapUsd: dto.dailyCapUsd }),
      ...(dto.autoTopUp !== undefined && { autoTopUp: dto.autoTopUp }),
    };
    if (Object.keys(settings).length === 0) {
      throw new BadRequestException('Nothing to change');
    }
    const wallet = await this.callCloud(() => this.frameleafCloudMlRepository.updateWallet(gateway, settings));
    return this.toWalletDto(await this.cacheWallet({ ...wallet }, wallet.topUpUrl));
  }

  /** The models Frameleaf Cloud offers now, for the model picker. Retired models are left out. */
  async getCatalog(): Promise<CloudMlCatalogResponseDto> {
    const gateway = await this.requireGateway();
    const catalog = await this.callCloud(() => this.frameleafCloudMlRepository.getCatalog(gateway));
    return {
      models: catalog.models
        .filter((model) => !model.retired && !isLocalOnlyModel(model.id))
        .map((model) => ({
          id: model.id,
          workload: knownWorkloads([model.workload])[0] ?? null,
          name: model.name,
          description: model.description,
          fingerprint: model.fingerprint,
          pricingUnit: model.pricing?.unit ?? null,
          priceUsd: model.pricing?.usd ?? null,
        })),
    };
  }

  /** Every consent recorded for the Frameleaf Cloud destination, newest first. */
  async getConsentHistory(): Promise<CloudMlConsentHistoryResponseDto> {
    const destination = await this.findDestination();
    if (!destination) {
      return { records: [] };
    }
    const rows = await this.frameleafConsentRepository.getHistory(destination.id);
    return {
      records: rows.map((row) => ({
        version: row.version,
        features: { ...emptyFeatures, ...row.features },
        acceptedBy: row.acceptedBy,
        acceptedAt: new Date(row.acceptedAt).toISOString(),
        revokedAt: row.revokedAt ? new Date(row.revokedAt).toISOString() : null,
      })),
    };
  }

  /** The settled charges recorded for the Frameleaf Cloud destination, newest first (FL-159). */
  async getSettlements(): Promise<CloudMlSettlementsResponseDto> {
    const destination = await this.findDestination();
    if (!destination) {
      return { items: [] };
    }
    const rows = await this.mlDestinationRepository.getSettlements(destination.id, CLOUD_ML_SETTLEMENT_LIMIT);
    // What each charge is made of (model, GPU time, workers, the estimate shown) comes from the cloud's
    // usage record when it answers; the local rows stand on their own when it does not.
    const details = new Map<string, CloudUsage['items'][number]>();
    const resolution = await resolveCloudGateway(this.gatewayDeps());
    if (resolution.state === CloudConnectionState.Ready && rows.length > 0) {
      const since = new Date(Date.now() - CLOUD_ML_USAGE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
      const usage = await this.frameleafCloudMlRepository.getUsage(resolution.gateway, since).catch(() => null);
      for (const item of usage?.items ?? []) {
        details.set(item.jobId, item);
      }
    }
    return {
      items: rows.map((row) => {
        const detail = details.get(row.cloudJobId!);
        return {
          cloudJobId: row.cloudJobId!,
          workload: row.workload,
          jobName: row.jobName,
          succeeded: row.outcome === 'success',
          costUsd: Number(row.costUsd),
          credits: row.credits === null ? null : Number(row.credits),
          finishedAt: new Date(row.finishedAt).toISOString(),
          modelId: detail?.modelId ?? null,
          gpuSeconds: detail?.gpuSeconds ?? null,
          workers: detail?.workers ?? null,
          estimateUsd: detail?.estimateUsd ?? null,
        };
      }),
    };
  }

  /**
   * Apply Frameleaf Cloud settlements (`GET /v2/usage`) to the accounting rows of their jobs, so
   * `ml_workload_accounting.costUsd`, `credits` and the destination's spend reflect what was charged.
   */
  async reconcileUsage(): Promise<{ settled: number }> {
    const gateway = await this.requireGateway();
    const since = new Date(Date.now() - CLOUD_ML_USAGE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const usage = await this.callCloud(() => this.frameleafCloudMlRepository.getUsage(gateway, since));
    const settled = await this.mlDestinationRepository.applySettlements(
      usage.items.map((item) => ({ cloudJobId: item.jobId, costUsd: item.settledUsd, credits: item.credits })),
    );
    return { settled };
  }

  /**
   * The Frameleaf Cloud check `MachineLearningRepository.probe` delegates to. A result younger than
   * `maxAgeMs` is reused so a burst of jobs does not become a burst of calls.
   */
  async probe(maxAgeMs = 0): Promise<MlEndpointProbe> {
    if (this.lastProbe && maxAgeMs > 0 && Date.now() - this.lastProbe.at < maxAgeMs) {
      return this.lastProbe.probe;
    }
    const started = Date.now();
    const probe = await this.runProbe(started);
    this.lastProbe = { at: started, probe };
    return probe;
  }

  private async runProbe(started: number): Promise<MlEndpointProbe> {
    const probedAt = new Date(started);
    const unreachable = (facts: CloudProbeFacts, error: string): MlEndpointProbe => ({
      reachable: false,
      workloads: [],
      hardware: null,
      latencyMs: Date.now() - started,
      probedAt,
      error,
      cloud: facts,
    });

    const config = await this.getConfig({ withCache: true });
    if (!config.frameleafCloud.cloudMl.enabled) {
      const detail = 'Frameleaf Cloud processing is turned off in settings';
      return unreachable(refusedFacts(MlAdmissionRefusal.CloudUnavailable, detail), detail);
    }
    const resolution: CloudGatewayResolution = await resolveCloudGateway(this.gatewayDeps());
    if (resolution.state !== CloudConnectionState.Ready) {
      return unreachable(
        refusedFacts(resolution.refusal, resolution.detail, resolution.link?.dataRegion ?? null),
        resolution.detail,
      );
    }
    const { gateway, region } = resolution;

    try {
      await this.frameleafCloudMlRepository.ping(gateway);
    } catch (error) {
      if (!(error instanceof FrameleafCloudError)) {
        throw error;
      }
      return unreachable(refusedFacts(error.refusal, error.message, region), error.message);
    }

    try {
      const capabilities = await this.frameleafCloudMlRepository.getCapabilities(gateway);
      const [hardware, catalog] = await Promise.all([
        this.frameleafCloudMlRepository.getHardware(gateway).catch(() => null),
        this.frameleafCloudMlRepository.getCatalog(gateway).catch(() => null),
      ]);
      // Local-only models (FL-146) never count as offered, even if a catalogue lists them.
      const modelIds = (catalog?.models ?? [])
        .filter((model) => !model.retired && !isLocalOnlyModel(model.id))
        .map((model) => model.id);
      const facts = cloudFactsFromCapabilities(capabilities, modelIds);
      await this.cacheWallet({
        balanceUsd: capabilities.wallet.balanceUsd,
        heldUsd: capabilities.wallet.heldUsd,
        dailyCapUsd: capabilities.wallet.dailyCapUsd,
        spentTodayUsd: capabilities.wallet.spentTodayUsd,
      });
      return {
        reachable: true,
        // Only what the gateway offers, and only work the administrator allowed on the cloud (§3.2):
        // a kind of work set to "Local only" is not served here, so admission refuses it.
        workloads: knownWorkloads(capabilities.workloads).filter(
          (workload) =>
            FRAMELEAF_CLOUD_ML_WORKLOADS.includes(workload) &&
            cloudRouteAllows(config.frameleafCloud.cloudMl, workload),
        ),
        hardware: this.toHardware(hardware),
        latencyMs: Date.now() - started,
        probedAt,
        error: null,
        cloud: facts,
      };
    } catch (error) {
      if (!(error instanceof FrameleafCloudError)) {
        throw error;
      }
      // The gateway answered but refused (for example 402 or 403): reachable, with the refusal kept.
      return {
        reachable: true,
        workloads: [],
        hardware: null,
        latencyMs: Date.now() - started,
        probedAt,
        error: error.message,
        cloud: refusedFacts(error.refusal, error.message, region),
      };
    }
  }

  private toHardware(
    hardware: { providers: string[]; cudaDeviceCount: number } | null,
  ): MachineLearningHardwareResponse {
    // The gateway's report is synthetic (one accelerator per job), so the inventory reads it as GPU-backed.
    return {
      providers: hardware?.providers.length ? hardware.providers : ['CUDAExecutionProvider'],
      openvinoDeviceIds: [],
      torchCudaAvailable: true,
      cudaDeviceCount: Math.max(1, hardware?.cudaDeviceCount ?? 1),
      preferredAcceleration: MachineLearningHardwareAcceleration.Cuda,
    };
  }

  private async refreshWallet(gateway: CloudMlGateway): Promise<FrameleafMlWallet> {
    const wallet = await this.callCloud(() => this.frameleafCloudMlRepository.getWallet(gateway));
    return this.cacheWallet({ ...wallet }, wallet.topUpUrl);
  }

  private async cacheWallet(
    wallet: Pick<FrameleafMlWallet, 'balanceUsd' | 'heldUsd' | 'dailyCapUsd' | 'spentTodayUsd'> &
      Partial<Pick<FrameleafMlWallet, 'autoTopUp'>>,
    topUpUrl?: string | null,
  ): Promise<FrameleafMlWallet> {
    const previous = await this.systemMetadataRepository.get(SystemMetadataKey.FrameleafMlWallet);
    const value: FrameleafMlWallet = {
      balanceUsd: wallet.balanceUsd,
      heldUsd: wallet.heldUsd,
      dailyCapUsd: wallet.dailyCapUsd,
      spentTodayUsd: wallet.spentTodayUsd,
      autoTopUp: wallet.autoTopUp ?? previous?.autoTopUp ?? false,
      topUpUrl: topUpUrl === undefined ? (previous?.topUpUrl ?? null) : topUpUrl,
      updatedAt: new Date().toISOString(),
    };
    await this.systemMetadataRepository.set(SystemMetadataKey.FrameleafMlWallet, value);
    return value;
  }

  private toWalletDto(wallet: FrameleafMlWallet): CloudMlWalletDto {
    return {
      balanceUsd: wallet.balanceUsd,
      heldUsd: wallet.heldUsd,
      availableUsd: Math.max(0, wallet.balanceUsd - wallet.heldUsd),
      dailyCapUsd: wallet.dailyCapUsd,
      spentTodayUsd: wallet.spentTodayUsd,
      topUpUrl: wallet.topUpUrl,
      autoTopUp: wallet.autoTopUp ?? false,
      updatedAt: wallet.updatedAt,
    };
  }

  /**
   * Migration 2100000000620 removed the previous cloud provider's destinations and failed their
   * unfinished jobs. Tell every administrator once, in plain words, then forget the notice.
   */
  private async deliverMigrationNotice() {
    const notice = await this.systemMetadataRepository.get(SystemMetadataKey.FrameleafCloudMigrationNotice);
    if (!notice) {
      return;
    }
    const names = notice.removedDestinations.map((destination) => destination.name);
    const parts = [
      names.length > 0
        ? `The cloud processing destination${names.length === 1 ? '' : 's'} ${names.join(', ')} ${names.length === 1 ? 'was' : 'were'} removed: Frameleaf Cloud replaces the previous cloud processing service.`
        : 'Frameleaf Cloud replaces the previous cloud processing service.',
      'The work that used it is not sent anywhere else. Choose where it runs under Processing destinations, or add Frameleaf Cloud.',
    ];
    if (notice.cancelledOperations > 0) {
      parts.push(
        `${notice.cancelledOperations} unfinished job${notice.cancelledOperations === 1 ? '' : 's'} stopped and can be started again.`,
      );
    }
    if ((notice.revokedRenderWorkers ?? 0) > 0) {
      parts.push(
        `${notice.revokedRenderWorkers} render worker${notice.revokedRenderWorkers === 1 ? ' was' : 's were'} signed out.`,
      );
    }
    try {
      const admins = (await this.userRepository.getList()).filter((user) => user.isAdmin && !user.deletedAt);
      for (const admin of admins) {
        await this.notificationRepository.create({
          userId: admin.id,
          type: NotificationType.SystemMessage,
          level: NotificationLevel.Warning,
          title: 'Cloud processing moved to Frameleaf Cloud',
          description: parts.join(' '),
        });
      }
      await this.systemMetadataRepository.delete(SystemMetadataKey.FrameleafCloudMigrationNotice);
    } catch (error) {
      this.logger.warn(`Could not tell administrators about the Frameleaf Cloud change: ${error}`);
    }
  }

  private async requireGateway(): Promise<CloudMlGateway> {
    const resolution = await resolveCloudGateway(this.gatewayDeps());
    if (resolution.state !== CloudConnectionState.Ready) {
      throw new BadRequestException(resolution.detail);
    }
    return resolution.gateway;
  }

  private async callCloud<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof FrameleafCloudError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  private async findDestination(): Promise<MlDestinationRow | undefined> {
    return (await this.mlDestinationRepository.getAll()).find((row) => row.kind === MlDestinationKind.FrameleafCloud);
  }

  private async toDto(row: MlDestinationRow): Promise<MlDestinationResponseDto> {
    const spentUsd =
      row.budgetLimitUsd === null
        ? 0
        : await this.mlDestinationRepository.getSpend(
            row.id,
            new Date(Date.now() - ML_BUDGET_WINDOW_DAYS * 24 * 60 * 60 * 1000),
          );
    return mapMlDestination(row, spentUsd);
  }

  private gatewayDeps(): CloudGatewayDeps {
    return {
      configRepository: this.configRepository,
      databaseRepository: this.databaseRepository,
      systemMetadataRepository: this.systemMetadataRepository,
      instanceIdentityRepository: this.instanceIdentityRepository,
      frameleafCloudRepository: this.frameleafCloudRepository,
    };
  }
}
