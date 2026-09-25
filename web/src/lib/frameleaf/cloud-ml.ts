/**
 * Frameleaf Cloud processing and where each kind of work runs (FL-159, CLD-201): the production
 * helpers behind Settings → Frameleaf Cloud → Cloud processing, Compute & jobs → Hardware & GPU and
 * Where each job runs. Ported from the prototype's `frameleaf-cloud-data.mjs` (effd05ffb7): the
 * routing rows, local capability, route summaries, admission reasons, AI Wallet top-up rules and
 * estimates. The server decides everything (link, consent version, wallet, hardware); these only
 * turn its facts into choices and i18n keys, so nothing here invents a figure.
 *
 * Amounts are USD for everyone (owner decision 2026-09-25): never converted, never localised.
 */
import {
  CloudMlConnection,
  type CloudMlStatusResponseDto,
  type CloudMlWalletDto,
  type HardwareCheckResponseDto,
} from '@immich/sdk';
import type { Translations } from 'svelte-i18n';
import {
  bandFor,
  estimateCost,
  gpuProfileFor,
  ladderFor,
  ladderStates,
  LADDER_WORKLOADS,
  minVramGb,
  workloadUnits,
  type Benchmark,
  type DetectedGpu,
  type GpuProfileId,
  type LadderWorkload,
  type RouteMode,
} from './gpu-model-catalog';

// ------------------------------------------------------------------ money

const usd = (digits: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });

/** "$12.00", or "$0.0025" for amounts under ten cents, as the prototype shows them. Always USD. */
export const formatUsd = (value: number | null | undefined, digits = 2) => {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '—';
  }
  return usd(value !== 0 && Math.abs(value) < 0.1 ? 4 : digits).format(value);
};

/** A GPU-time rate per minute ("$0.0780"), from a per-second customer rate. */
export const formatRatePerMinute = (usdPerSec: number) => formatUsd(usdPerSec * 60);

export const formatDateTime = (value: string, locale: string | undefined | null) =>
  new Intl.DateTimeFormat(locale ?? undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));

/** A duration in plain units ("3 s", "2 min", "1 h 5 min"), in the reader's language. */
export const formatDuration = (seconds: number | null | undefined, locale: string | undefined | null) => {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) {
    return '—';
  }
  const unit = (value: number, name: 'second' | 'minute' | 'hour', digits = 0) =>
    new Intl.NumberFormat(locale ?? undefined, {
      style: 'unit',
      unit: name,
      unitDisplay: 'short',
      maximumFractionDigits: digits,
    }).format(value);
  if (seconds < 10) {
    return unit(Math.round(seconds * 10) / 10, 'second', 1);
  }
  if (seconds < 90) {
    return unit(Math.round(seconds), 'second');
  }
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    const rest = Math.round(seconds % 60);
    return rest ? `${unit(minutes, 'minute')} ${unit(rest, 'second')}` : unit(minutes, 'minute');
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return minutes ? `${unit(hours, 'hour')} ${unit(minutes, 'minute')}` : unit(hours, 'hour');
};

// ------------------------------------------------------------------ AI Wallet (§2.5)

/** Top-ups: $20 minimum, $25 default, presets $25 / $50 / $100, $500 maximum, no bonus credit. */
export const WALLET_MIN_TOP_UP_USD = 20;
export const WALLET_MAX_TOP_UP_USD = 500;
export const walletPacks = Object.freeze([
  { id: 'pack-25', amount: 25 },
  { id: 'pack-50', amount: 50 },
  { id: 'pack-100', amount: 100 },
] as const);
export const DEFAULT_WALLET_PACK = 'pack-25';

/** Balance minus holds, never below zero. */
export const walletAvailable = (wallet: Pick<CloudMlWalletDto, 'balanceUsd' | 'heldUsd'> | null | undefined) =>
  wallet ? Math.max(0, wallet.balanceUsd - wallet.heldUsd) : 0;

/** A custom top-up amount the checkout accepts: whole dollars from $20 to $500. */
export const isTopUpAmount = (amount: number) =>
  Number.isSafeInteger(amount) && amount >= WALLET_MIN_TOP_UP_USD && amount <= WALLET_MAX_TOP_UP_USD;

/**
 * The checkout on frameleaf.cloud for an amount: the top-up address the cloud returned, with the
 * amount. Payment happens there; this server never sees card details. Null without an address.
 */
export const topUpCheckoutUrl = (topUpUrl: string | null | undefined, amount: number) => {
  if (!topUpUrl || !isTopUpAmount(amount)) {
    return null;
  }
  try {
    const url = new URL(topUpUrl);
    if (url.protocol !== 'https:') {
      return null;
    }
    url.searchParams.set('amount', String(amount));
    return url.href;
  } catch {
    return null;
  }
};

export const walletIsEmpty = (wallet: Pick<CloudMlWalletDto, 'balanceUsd' | 'heldUsd'>) => walletAvailable(wallet) <= 0;

export const walletDailyCapReached = (wallet: Pick<CloudMlWalletDto, 'dailyCapUsd' | 'spentTodayUsd'>) =>
  wallet.dailyCapUsd !== null && wallet.spentTodayUsd >= wallet.dailyCapUsd;

// ------------------------------------------------------------------ status and consent

export const cloudConnectionLabelKey = (connection: CloudMlConnection): Translations => {
  switch (connection) {
    case CloudMlConnection.NotConfigured: {
      return 'admin.frameleaf_cloud_ml_connection_not_configured';
    }
    case CloudMlConnection.NotLinked: {
      return 'admin.frameleaf_cloud_ml_connection_not_linked';
    }
    case CloudMlConnection.Ready: {
      return 'admin.frameleaf_cloud_ml_connection_ready';
    }
    case CloudMlConnection.Unavailable: {
      return 'admin.frameleaf_cloud_ml_connection_unavailable';
    }
  }
};

/** Plain-language help for a connection that is not ready; null when it is. */
export const cloudConnectionHelpKey = (connection: CloudMlConnection): Translations | null => {
  switch (connection) {
    case CloudMlConnection.NotConfigured: {
      return 'admin.frameleaf_cloud_ml_connection_not_configured_help';
    }
    case CloudMlConnection.NotLinked: {
      return 'admin.frameleaf_cloud_ml_connection_not_linked_help';
    }
    case CloudMlConnection.Unavailable: {
      return 'admin.frameleaf_cloud_ml_connection_unavailable_help';
    }
    case CloudMlConnection.Ready: {
      return null;
    }
  }
};

/** Consent was never accepted on this server, or was accepted for an older version. */
export const cloudConsentNeeded = (status: Pick<CloudMlStatusResponseDto, 'consent' | 'destination'>): boolean => {
  if (status.consent) {
    return status.consent.acceptedVersion === null || status.consent.outdated;
  }
  return status.destination ? status.destination.consent.acknowledgedAt === null : true;
};

/** The five promises every consent version shows (prototype `consentTerms`). */
export const CONSENT_TERM_KEYS: readonly Translations[] = [
  'admin.frameleaf_cloud_ml_term_previews',
  'admin.frameleaf_cloud_ml_term_retention',
  'admin.frameleaf_cloud_ml_term_training',
  'admin.frameleaf_cloud_ml_term_region',
  'admin.frameleaf_cloud_ml_term_confirm',
];

/**
 * Why a cloud job would be refused before it is submitted, as an i18n key, in the order a person
 * fixes them; null when it could start. With an estimate, the wallet and the daily cap count too.
 */
export const cloudAdmission = (
  status: CloudMlStatusResponseDto | null,
  enabled: boolean,
  estimate: { hold: number; p90: number } | null,
): { key: Translations; values?: Record<string, string> } | null => {
  if (!status || status.connection === CloudMlConnection.NotConfigured) {
    return { key: 'admin.frameleaf_cloud_ml_refusal_not_set_up' };
  }
  if (status.connection === CloudMlConnection.NotLinked) {
    return { key: 'admin.frameleaf_cloud_ml_refusal_link' };
  }
  if (!enabled) {
    return { key: 'admin.frameleaf_cloud_ml_refusal_turn_on' };
  }
  if (cloudConsentNeeded(status)) {
    return { key: 'admin.frameleaf_cloud_ml_refusal_terms' };
  }
  if (status.connection === CloudMlConnection.Unavailable) {
    return { key: 'admin.frameleaf_cloud_ml_refusal_unavailable' };
  }
  if (!estimate || !status.wallet) {
    return null;
  }
  if (estimate.hold > walletAvailable(status.wallet)) {
    return { key: 'admin.frameleaf_cloud_ml_refusal_credit', values: { amount: formatUsd(estimate.hold) } };
  }
  if (status.wallet.dailyCapUsd !== null && status.wallet.spentTodayUsd + estimate.p90 > status.wallet.dailyCapUsd) {
    return { key: 'admin.frameleaf_cloud_ml_refusal_cap' };
  }
  return null;
};

// ------------------------------------------------------------------ where each job runs (§3.2)

/** The kinds of work that can be routed; the config keys of `frameleafCloud.cloudMl.routing`. */
export type RoutedWorkload = 'descriptions' | 'upscale' | 'restoration' | 'studio' | 'interpolation';
export type WorkloadRowId = RoutedWorkload | 'search' | 'faces' | 'ocr' | 'render';

export type WorkloadRow = {
  id: WorkloadRowId;
  /** Routable between this server and Frameleaf Cloud. */
  cloud: boolean;
  /** GPU memory a local run needs, for work without a model ladder. */
  localGb: number;
};

/**
 * Every kind of work in "Where each job runs", in the prototype's order. Search, faces and text
 * recognition stay on this server (§2.8); Studio exports render at home only (§2.7).
 */
export const mlWorkloads: readonly WorkloadRow[] = Object.freeze([
  { id: 'search', cloud: false, localGb: 2 },
  { id: 'faces', cloud: false, localGb: 2 },
  { id: 'ocr', cloud: false, localGb: 2 },
  { id: 'descriptions', cloud: true, localGb: 8 },
  { id: 'upscale', cloud: true, localGb: 6 },
  { id: 'restoration', cloud: true, localGb: 12 },
  { id: 'studio', cloud: true, localGb: 4 },
  { id: 'interpolation', cloud: true, localGb: 2 },
  { id: 'render', cloud: false, localGb: 0 },
]);

export const ROUTED_WORKLOADS: readonly RoutedWorkload[] = [
  'descriptions',
  'upscale',
  'restoration',
  'studio',
  'interpolation',
];

export const workloadNameKey = (id: WorkloadRowId) => `admin.frameleaf_routing_${id}_name` as Translations;
export const workloadUseKey = (id: WorkloadRowId) => `admin.frameleaf_routing_${id}_use` as Translations;
/** Why a local-only kind of work stays on this server. */
export const workloadWhyKey = (id: WorkloadRowId) => `admin.frameleaf_routing_${id}_why` as Translations;

export const routingModes: readonly { id: RouteMode; labelKey: Translations }[] = [
  { id: 'local', labelKey: 'admin.frameleaf_routing_mode_local' },
  { id: 'both', labelKey: 'admin.frameleaf_routing_mode_both' },
  { id: 'cloud', labelKey: 'admin.frameleaf_routing_mode_cloud' },
];

export const isRoutedWorkload = (id: string): id is RoutedWorkload =>
  (ROUTED_WORKLOADS as readonly string[]).includes(id);

/** The saved route of a kind of work; everything not routable runs on this server. */
export const workloadRoute = (routing: Partial<Record<RoutedWorkload, RouteMode>> | undefined, id: WorkloadRowId) =>
  isRoutedWorkload(id) ? (routing?.[id] ?? 'local') : 'local';

/** This server's workers as the hardware check found them: the ML container and the server container. */
export type LocalWorker = {
  gpu: DetectedGpu | null;
  serverGpu: DetectedGpu | null;
  cpuProfile: GpuProfileId;
};

const detected = (
  check: Pick<HardwareCheckResponseDto['ml'], 'model' | 'vramGb' | 'backend'> | null | undefined,
): DetectedGpu | null =>
  check && check.backend !== 'CPU' && check.model && (check.vramGb ?? 0) > 0
    ? {
        name: check.model,
        vramGb: check.vramGb!,
        backend: check.backend,
        profile: gpuProfileFor(check.model, check.vramGb!),
      }
    : null;

/** The GPU each container can actually use, from the Hardware & GPU check (null = processor only). */
export const workerFromHardware = (check: HardwareCheckResponseDto | null | undefined): LocalWorker => ({
  gpu: detected(check?.ml),
  serverGpu: detected(check?.server),
  cpuProfile: 'cpu8',
});

/** The GPU a workload runs on locally: Studio export uses the server container, the rest the ML container. */
export const workerGpu = (worker: LocalWorker | null, workload: LadderWorkload | WorkloadRowId) => {
  if (!worker) {
    return null;
  }
  return (LADDER_WORKLOADS as readonly string[]).includes(workload) &&
    workloadUnits[workload as LadderWorkload].container === 'server'
    ? worker.serverGpu
    : worker.gpu;
};

/** The benchmark's speed factors for every ladder model that runs here (Studio export uses the server's). */
export const benchmarkFor = (check: HardwareCheckResponseDto | null | undefined): Benchmark | null => {
  const benchmark = check?.benchmark;
  if (!benchmark || (benchmark.mlFactor === null && benchmark.serverFactor === null)) {
    return null;
  }
  const factors: Record<string, number> = {};
  for (const workload of LADDER_WORKLOADS) {
    const factor = workloadUnits[workload].container === 'server' ? benchmark.serverFactor : benchmark.mlFactor;
    if (factor === null) {
      continue;
    }
    for (const item of ladderFor(workload)) {
      factors[item.id] = factor;
    }
  }
  return { ranAt: benchmark.ranAt, factors };
};

export type Capability = { ok: boolean; key: Translations; values: Record<string, string | number> };

/**
 * Whether this server can run the work itself, with the reason. Work with a model ladder runs when
 * any position fits the GPU or has a processor path.
 */
export const localCapability = (id: WorkloadRowId, worker: LocalWorker | null): Capability => {
  const row = mlWorkloads.find((entry) => entry.id === id);
  if (!row || !worker) {
    return { ok: false, key: 'admin.frameleaf_routing_local_no_worker', values: {} };
  }
  const gpu = workerGpu(worker, id);
  if ((LADDER_WORKLOADS as readonly string[]).includes(id)) {
    const ladder = ladderFor(id as LadderWorkload);
    const fits = ladder.filter((item) => ['gpu', 'cpu'].includes(bandFor(item, gpu, worker.cpuProfile)));
    if (fits.length > 0) {
      return {
        ok: true,
        key: gpu ? 'admin.frameleaf_routing_local_up_to_gpu' : 'admin.frameleaf_routing_local_up_to_cpu',
        values: { model: fits.at(-1)!.name, gpu: gpu?.name ?? '', memory: gpu?.vramGb ?? 0 },
      };
    }
    const needs = Math.min(...ladder.map((item) => minVramGb(item)).filter((value): value is number => value !== null));
    return gpu
      ? {
          ok: false,
          key: 'admin.frameleaf_routing_local_needs_gpu',
          values: { needs, gpu: gpu.name, memory: gpu.vramGb },
        }
      : { ok: false, key: 'admin.frameleaf_routing_local_needs_gpu_none', values: { needs } };
  }
  if (gpu && gpu.vramGb >= row.localGb) {
    return { ok: true, key: 'admin.frameleaf_routing_local_fits', values: { gpu: gpu.name, memory: gpu.vramGb } };
  }
  return gpu
    ? {
        ok: false,
        key: 'admin.frameleaf_routing_local_needs_gpu',
        values: { needs: row.localGb, gpu: gpu.name, memory: gpu.vramGb },
      }
    : { ok: true, key: 'admin.frameleaf_routing_local_processor', values: {} };
};

/** The smallest GPU memory any position needs, for the row's short "Needs … GB locally" label. */
export const localGbNeeded = (id: WorkloadRowId) => {
  if (!(LADDER_WORKLOADS as readonly string[]).includes(id)) {
    return mlWorkloads.find((entry) => entry.id === id)?.localGb ?? 0;
  }
  const values = ladderFor(id as LadderWorkload)
    .map((item) => minVramGb(item))
    .filter((value): value is number => value !== null);
  return values.length > 0 ? Math.min(...values) : 0;
};

/** The line under each routable row: what its route means with this hardware. */
export const routeSummary = (
  route: RouteMode,
  local: Capability,
): { tone: 'ok' | 'warning'; key: Translations; values: Record<string, string | number>; local: boolean } => {
  if (route === 'local' && !local.ok) {
    return { tone: 'warning', key: 'admin.frameleaf_routing_summary_local_short', values: {}, local: true };
  }
  if (route === 'both') {
    return {
      tone: 'ok',
      key: local.ok ? 'admin.frameleaf_routing_summary_both' : 'admin.frameleaf_routing_summary_both_cloud',
      values: {},
      local: false,
    };
  }
  if (route === 'cloud') {
    return { tone: 'ok', key: 'admin.frameleaf_routing_summary_cloud', values: {}, local: false };
  }
  return { tone: 'ok', key: local.key, values: local.values, local: false };
};

/**
 * The destinations one job may offer, in order: this server, then Frameleaf Cloud. A destination
 * that is not allowed or cannot run stays listed with its reason; a job never moves between them
 * on its own (§2.2).
 */
export const jobDestinations = (route: RouteMode, local: Capability, cloudRefusal: { key: Translations } | null) => [
  {
    id: 'local' as const,
    available: route !== 'cloud' && local.ok,
    key: route === 'cloud' ? ('admin.frameleaf_routing_job_cloud_only' as Translations) : local.key,
  },
  {
    id: 'cloud' as const,
    available: route !== 'local' && !cloudRefusal,
    key:
      route === 'local'
        ? ('admin.frameleaf_routing_job_local_only' as Translations)
        : (cloudRefusal?.key ?? ('admin.frameleaf_routing_job_cloud_ok' as Translations)),
  },
];

/** The destination a job preselects: "When a job can run in both places, start with", if available. */
export const preferredDestination = (options: ReturnType<typeof jobDestinations>, startWith: 'local' | 'cloud') => {
  const available = options.filter((option) => option.available);
  return (available.find((option) => option.id === startWith) ?? available[0])?.id ?? null;
};

/** What the hardware can run for each ladder workload: the heaviest local model and how many are cloud only. */
export const hardwareConsequences = (worker: LocalWorker, benchmark: Benchmark | null) =>
  LADDER_WORKLOADS.map((workload) => {
    const states = ladderStates(workload, {
      gpu: workerGpu(worker, workload),
      cpuProfile: worker.cpuProfile,
      route: 'both',
      benchmark,
    });
    const local = states.filter((entry) => entry.runsOn === 'local');
    return {
      workload,
      heaviest: local.at(-1) ?? null,
      cloudOnly: states.filter((entry) => entry.runsOn === 'cloud').length,
      localStates: local,
    };
  });

/** A cloud job's estimate for a model and quantity (start fees + GPU time, p50–p90 and the hold). */
export const estimateCloudJob = (modelId: string, quantity: number) => estimateCost(modelId, quantity);
