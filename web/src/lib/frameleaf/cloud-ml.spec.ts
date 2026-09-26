import { CloudMlConnection, type CloudMlStatusResponseDto, type HardwareCheckResponseDto } from '@immich/sdk';
import { describe, expect, it } from 'vitest';
import {
  benchmarkFor,
  cloudAdmission,
  cloudConnectionHelpKey,
  cloudConnectionLabelKey,
  cloudConsentNeeded,
  DEFAULT_WALLET_PACK,
  estimateCloudJob,
  formatUsd,
  isTopUpAmount,
  jobDestinations,
  localCapability,
  mlWorkloads,
  preferredDestination,
  routeSummary,
  topUpCheckoutUrl,
  walletAvailable,
  walletDailyCapReached,
  walletIsEmpty,
  walletPacks,
  WALLET_MAX_TOP_UP_USD,
  WALLET_MIN_TOP_UP_USD,
  workerFromHardware,
  workloadRoute,
} from '$lib/frameleaf/cloud-ml';
import { cloudPositions } from '$lib/frameleaf/gpu-model-catalog';

const consent = (acceptedVersion: string | null, outdated = false) => ({
  requiredVersion: '2026-10-01',
  recordedVersion: acceptedVersion,
  acceptedVersion,
  features: { identityNames: false, medicalSignals: false, ocrAddon: false },
  summary: 'Media is processed in the EU region.',
  documentUrl: null,
  outdated,
});

const wallet = {
  balanceUsd: 40,
  heldUsd: 0,
  availableUsd: 40,
  spentTodayUsd: 0,
  dailyCapUsd: 20 as number | null,
  autoTopUp: false,
  topUpUrl: null,
  settingsUrl: null,
  updatedAt: '2026-09-25T00:00:00.000Z',
};

const status = (overrides: Partial<CloudMlStatusResponseDto> = {}) =>
  ({
    connection: CloudMlConnection.Ready,
    consent: consent('2026-10-01'),
    destination: { consent: { acknowledgedAt: '2026-09-01T00:00:00.000Z' } },
    wallet,
    region: 'eu',
    ...overrides,
  }) as CloudMlStatusResponseDto;

const hardware = (ml: { model: string; vramGb: number; backend: string } | null) =>
  ({
    ml: ml ?? { model: null, vramGb: null, backend: 'CPU' },
    server: { model: null, vramGb: null, backend: 'CPU' },
    benchmark: null,
  }) as unknown as HardwareCheckResponseDto;

describe('Frameleaf Cloud estimates (FL-159, prototype frameleaf-cloud-data tests)', () => {
  it('are start fees plus GPU time at twice our cost, matching the pricing research', () => {
    // Research worked examples: describe 1,000 photos ≈ $0.85 (7B class), $5.50 (32B class).
    const seven = estimateCloudJob('qwen3.5-9b@1', 1000)!;
    expect(seven.gpuClass.id).toBe('gpu48pro');
    expect(seven.p50).toBeCloseTo(0.85, 2);
    const large = estimateCloudJob('qwen3.5-27b@1', 1000)!;
    expect(Math.abs(large.p50 - 5.5)).toBeLessThan(0.01);
    // 4× upscale of 20 photos ≈ $0.30; transcribe 30 min ≈ $0.10.
    expect(Math.abs(estimateCloudJob('realesrgan-x4plus@1', 20)!.p50 - 0.3)).toBeLessThan(0.01);
    expect(Math.abs(estimateCloudJob('whisper-large-v3@1', 30)!.p50 - 0.1)).toBeLessThan(0.01);
    // Restore 5 min: Faithful ≈ $1.86 on one worker; chunked on 5 workers, each paying a start fee.
    const faithful = estimateCloudJob('realbasicvsr@1', 5)!;
    expect(faithful.workers).toBe(5);
    expect(Math.abs(faithful.p50 - (1.86 + 4 * 0.1))).toBeLessThan(0.01);
    // Creative ≈ $54.22 on 5 chunked workers.
    const creative = estimateCloudJob('seedvr2-3b@1', 5)!;
    expect(creative.workers).toBe(5);
    expect(Math.abs(creative.p50 - 54.22)).toBeLessThan(0.01);
    for (const estimate of [seven, large, faithful, creative]) {
      expect(estimate.p90).toBeGreaterThan(estimate.p50);
      expect(estimate.hold).toBeGreaterThanOrEqual(estimate.p90);
      expect(Number.isSafeInteger(Math.round(estimate.hold * 100 * 1e6) / 1e6)).toBe(true);
    }
  });

  it('refuses unknown models, local-only work and quantities that are not positive numbers', () => {
    for (const [model, quantity] of [
      ['unknown@1', 10],
      ['qwen3.5-9b@1', 0],
      ['qwen3.5-9b@1', -3],
      ['qwen3.5-9b@1', NaN],
      ['render-hardware@1', 10],
    ] as const) {
      expect(estimateCloudJob(model, quantity), `${model} × ${quantity}`).toBeNull();
    }
    expect(estimateCloudJob('qwen3.5-9b@1', 'many' as unknown as number)).toBeNull();
    for (const model of cloudPositions()) {
      expect(estimateCloudJob(model.id, 1), model.id).not.toBeNull();
    }
  });
});

describe('cloud admission (FL-159)', () => {
  const estimate = estimateCloudJob('qwen3.5-27b@1', 1000)!;

  it('explains each refusal in the order a person fixes them and never admits silently', () => {
    expect(cloudAdmission(null, true, estimate)?.key).toBe('admin.frameleaf_cloud_ml_refusal_not_set_up');
    expect(cloudAdmission(status({ connection: CloudMlConnection.NotConfigured }), true, estimate)?.key).toBe(
      'admin.frameleaf_cloud_ml_refusal_not_set_up',
    );
    expect(cloudAdmission(status({ connection: CloudMlConnection.NotLinked }), true, estimate)?.key).toBe(
      'admin.frameleaf_cloud_ml_refusal_link',
    );
    expect(cloudAdmission(status(), false, estimate)?.key).toBe('admin.frameleaf_cloud_ml_refusal_turn_on');
    expect(cloudAdmission(status({ consent: consent('2025-01', true) }), true, estimate)?.key).toBe(
      'admin.frameleaf_cloud_ml_refusal_terms',
    );
    expect(cloudAdmission(status({ connection: CloudMlConnection.Unavailable }), true, estimate)?.key).toBe(
      'admin.frameleaf_cloud_ml_refusal_unavailable',
    );
    const poor = cloudAdmission(status({ wallet: { ...wallet, balanceUsd: 1, heldUsd: 0.9 } }), true, estimate);
    expect(poor?.key).toBe('admin.frameleaf_cloud_ml_refusal_credit');
    expect(poor?.values?.amount).toBe(formatUsd(estimate.hold));
    expect(
      cloudAdmission(status({ wallet: { ...wallet, spentTodayUsd: 19.9, dailyCapUsd: 20 } }), true, estimate)?.key,
    ).toBe('admin.frameleaf_cloud_ml_refusal_cap');
    expect(cloudAdmission(status(), true, estimate)).toBeNull();
    expect(cloudAdmission(status(), true, null)).toBeNull();
  });

  it('labels every connection state and explains every state that is not ready', () => {
    for (const connection of Object.values(CloudMlConnection)) {
      expect(cloudConnectionLabelKey(connection)).toMatch(/^admin\.frameleaf_cloud_ml_connection_/);
      if (connection !== CloudMlConnection.Ready) {
        expect(cloudConnectionHelpKey(connection)).toMatch(/^admin\.frameleaf_cloud_ml_connection_/);
      }
    }
    expect(cloudConsentNeeded(status())).toBe(false);
    expect(cloudConsentNeeded(status({ consent: consent(null) }))).toBe(true);
    expect(cloudConsentNeeded(status({ consent: consent('2025-01', true) }))).toBe(true);
  });
});

describe('AI Wallet (FL-159 §2.5)', () => {
  it('excludes held credit, and top-ups are $25, $50 or $100 with no bonus, from $20 to $500', () => {
    expect(walletAvailable({ balanceUsd: 10, heldUsd: 2.5 })).toBe(7.5);
    expect(walletAvailable({ balanceUsd: 1, heldUsd: 2 })).toBe(0);
    expect(walletAvailable(null)).toBe(0);
    expect(DEFAULT_WALLET_PACK).toBe('pack-25');
    expect(walletPacks.map((pack) => pack.amount)).toEqual([25, 50, 100]);
    expect(walletPacks.every((pack) => !('bonus' in pack))).toBe(true);
    expect(
      walletPacks.every((pack) => pack.amount >= WALLET_MIN_TOP_UP_USD && pack.amount <= WALLET_MAX_TOP_UP_USD),
    ).toBe(true);
    expect([19, 20, 500, 501, 25.5].map((amount) => isTopUpAmount(amount))).toEqual([false, true, true, false, false]);
    expect(walletIsEmpty({ balanceUsd: 2, heldUsd: 2 })).toBe(true);
    expect(walletDailyCapReached({ spentTodayUsd: 20, dailyCapUsd: 20 })).toBe(true);
    expect(walletDailyCapReached({ spentTodayUsd: 20, dailyCapUsd: null })).toBe(false);
  });

  it('checks out only on an https address the cloud returned, with the amount', () => {
    expect(topUpCheckoutUrl('https://frameleaf.cloud/wallet/top-up?s=1', 50)).toBe(
      'https://frameleaf.cloud/wallet/top-up?s=1&amount=50',
    );
    expect(topUpCheckoutUrl('ftp://frameleaf.cloud/top-up', 50)).toBeNull();
    expect(topUpCheckoutUrl('javascript:alert(1)', 50)).toBeNull();
    expect(topUpCheckoutUrl(null, 50)).toBeNull();
    expect(topUpCheckoutUrl('https://frameleaf.cloud/top-up', 5)).toBeNull();
  });

  it('formats every amount as US dollars, with four decimals under ten cents', () => {
    expect(formatUsd(0.0025)).toBe('$0.0025');
    expect(formatUsd(12)).toBe('$12.00');
    expect(formatUsd(NaN)).toBe('—');
    expect(formatUsd(null)).toBe('—');
  });
});

describe('where each job runs (FL-159 §3.2)', () => {
  it('starts everything on this server and keeps search, faces, text and Studio export there', () => {
    for (const row of mlWorkloads) {
      expect(workloadRoute(undefined, row.id)).toBe('local');
      expect(workloadRoute({ descriptions: 'cloud' }, row.id)).toBe(row.id === 'descriptions' ? 'cloud' : 'local');
    }
    expect(mlWorkloads.filter((row) => !row.cloud).map((row) => row.id)).toEqual(['search', 'faces', 'ocr', 'render']);
  });

  it('without a usable GPU restoration cannot run here, and nothing moves to the cloud on its own', () => {
    const worker = workerFromHardware(hardware(null));
    const local = localCapability('restoration', worker);
    expect(local.ok).toBe(false);
    expect(local.key).toBe('admin.frameleaf_routing_local_needs_gpu_none');
    const options = jobDestinations('local', local, null);
    expect(options.map((option) => [option.id, option.available])).toEqual([
      ['local', false],
      ['cloud', false],
    ]);
    expect(preferredDestination(options, 'cloud')).toBeNull();
    expect(routeSummary('local', local).key).toBe('admin.frameleaf_routing_summary_local_short');
  });

  it('with both, each job offers what can run and preselects the start-with choice', () => {
    const worker = workerFromHardware(hardware({ model: 'NVIDIA GeForce RTX 4090', vramGb: 24, backend: 'CUDA' }));
    const local = localCapability('upscale', worker);
    expect(local.ok).toBe(true);
    const both = jobDestinations('both', local, null);
    expect(both.map((option) => option.available)).toEqual([true, true]);
    expect(preferredDestination(both, 'local')).toBe('local');
    expect(preferredDestination(both, 'cloud')).toBe('cloud');
    // Cloud only removes the local choice even when it fits.
    expect(jobDestinations('cloud', local, null).map((option) => option.available)).toEqual([false, true]);
    // A refused cloud stays listed with its reason.
    const refused = jobDestinations('both', local, { key: 'admin.frameleaf_cloud_ml_refusal_terms' });
    expect(refused[1]).toMatchObject({ available: false, key: 'admin.frameleaf_cloud_ml_refusal_terms' });
  });

  it('applies the benchmark to the ladders of the container it measured', () => {
    expect(benchmarkFor(hardware(null))).toBeNull();
    const check = {
      ...hardware(null),
      benchmark: { ranAt: '2026-09-25T00:00:00.000Z', mlFactor: 2, serverFactor: null },
    } as unknown as HardwareCheckResponseDto;
    const benchmark = benchmarkFor(check)!;
    expect(benchmark.factors['qwen3.5-9b@1']).toBe(2);
    expect(Object.keys(benchmark.factors).some((id) => id.startsWith('render-'))).toBe(false);
  });
});

describe('canLowerCap (FL-177)', () => {
  it('lets this server only reduce spend: a lower cap, or a first cap', async () => {
    const { canLowerCap } = await import('$lib/frameleaf/cloud-ml');
    expect(canLowerCap(20, 15)).toBe(true);
    expect(canLowerCap(null, 40)).toBe(true);
    expect(canLowerCap(undefined, 40)).toBe(true);
    expect(canLowerCap(20, 20)).toBe(false);
    expect(canLowerCap(20, 30)).toBe(false);
  });
});
