import { describe, expect, it, vi } from 'vitest';
import { MlAdmissionRefusal, MlDestinationHealth, MlDestinationKind, MlWorkload } from 'src/enum.js';
import type { MachineLearningRepository, MlEndpointProbe } from 'src/repositories/machine-learning.repository.js';
import type { MlDestinationRepository } from 'src/repositories/ml-destination.repository.js';
import {
  MlDestinationNotFoundError,
  MlDestinationRefusedError,
  evaluateAdmission,
  hasRequiredConsent,
  healthFromProbe,
  resolveEndpoint,
  routedMlDestinationId,
  selectMlDestination,
  summarizeProbe,
} from 'src/utils/ml-destination.js';
import { mlDestinationStub, mlProbeStub } from 'test/fixtures/ml-destination.stub.js';

const endpoint = { url: 'http://immich-machine-learning:3003' };

const deps = (overrides: {
  destination?: typeof mlDestinationStub.local | undefined;
  probe?: MlEndpointProbe;
  spend?: number;
  runPod?: { url: string; authToken?: string } | null;
  route?: { workload: MlWorkload; destinationId: string } | undefined;
}) => {
  const mlDestinationRepository = {
    getById: vi.fn().mockResolvedValue('destination' in overrides ? overrides.destination : mlDestinationStub.local),
    getSpend: vi.fn().mockResolvedValue(overrides.spend ?? 0),
    recordProbe: vi.fn().mockResolvedValue(undefined),
    recordAccounting: vi.fn().mockResolvedValue(undefined),
    getRoute: vi.fn().mockResolvedValue(overrides.route),
  } as unknown as MlDestinationRepository;
  const machineLearningRepository = {
    probe: vi.fn().mockResolvedValue(overrides.probe ?? mlProbeStub.healthy),
    getRunPodEndpoint: vi.fn().mockReturnValue(overrides.runPod ?? null),
  } as unknown as MachineLearningRepository;
  return { mlDestinationRepository, machineLearningRepository };
};

describe('evaluateAdmission', () => {
  const base = {
    destination: mlDestinationStub.local,
    workload: MlWorkload.Face,
    endpoint,
    probe: mlProbeStub.healthy,
    spentUsd: 0,
  };

  it('admits a healthy, enabled local destination that serves the workload', () => {
    expect(evaluateAdmission(base)).toEqual({ admitted: true });
  });

  it('refuses a missing destination before anything else', () => {
    expect(evaluateAdmission({ ...base, destination: undefined })).toMatchObject({
      admitted: false,
      refusal: MlAdmissionRefusal.DestinationMissing,
    });
  });

  it('refuses a disabled destination', () => {
    expect(evaluateAdmission({ ...base, destination: { ...mlDestinationStub.local, enabled: false } })).toMatchObject({
      admitted: false,
      refusal: MlAdmissionRefusal.DestinationDisabled,
    });
  });

  it('refuses a workload the administrator did not allow', () => {
    expect(evaluateAdmission({ ...base, workload: MlWorkload.RestorationFaithful })).toMatchObject({
      admitted: false,
      refusal: MlAdmissionRefusal.WorkloadNotAllowed,
    });
  });

  it('refuses a cloud destination without recorded consent even when it is healthy', () => {
    expect(
      evaluateAdmission({
        ...base,
        destination: mlDestinationStub.runPod,
        workload: MlWorkload.Enrichment,
        endpoint: { url: 'https://endpoint.api.runpod.ai/', authToken: 'rp' },
        probe: { ...mlProbeStub.healthy, workloads: [MlWorkload.Enrichment] },
      }),
    ).toMatchObject({ admitted: false, refusal: MlAdmissionRefusal.ConsentMissing });
  });

  it('refuses a cloud destination at its budget limit', () => {
    expect(
      evaluateAdmission({
        ...base,
        destination: mlDestinationStub.runPodConsented,
        workload: MlWorkload.Enrichment,
        endpoint: { url: 'https://endpoint.api.runpod.ai/', authToken: 'rp' },
        probe: { ...mlProbeStub.healthy, workloads: [MlWorkload.Enrichment] },
        spentUsd: 25,
      }),
    ).toMatchObject({ admitted: false, refusal: MlAdmissionRefusal.BudgetExceeded });
  });

  it('refuses a consented RunPod destination with no ready worker instead of using anything else', () => {
    expect(
      evaluateAdmission({
        ...base,
        destination: mlDestinationStub.runPodConsented,
        workload: MlWorkload.Enrichment,
        endpoint: null,
        probe: null,
      }),
    ).toMatchObject({ admitted: false, refusal: MlAdmissionRefusal.EndpointUnresolved });
  });

  it('refuses an unreachable destination', () => {
    expect(evaluateAdmission({ ...base, probe: mlProbeStub.unreachable })).toMatchObject({
      admitted: false,
      refusal: MlAdmissionRefusal.DestinationUnhealthy,
    });
  });

  it('refuses when the worker itself does not report the workload, whatever the allow-list says', () => {
    const lan = { ...mlDestinationStub.lan, consentAcknowledgedAt: null };
    expect(
      evaluateAdmission({
        ...base,
        destination: lan,
        workload: MlWorkload.RestorationFaithful,
        endpoint: { url: lan.url!, authToken: 'lan-token' },
        probe: mlProbeStub.healthy,
      }),
    ).toMatchObject({ admitted: false, refusal: MlAdmissionRefusal.WorkloadNotServed });
  });
});

describe('resolveEndpoint', () => {
  it('uses the stored URL and token for local and LAN destinations', () => {
    expect(resolveEndpoint(mlDestinationStub.local, null)).toEqual({ url: mlDestinationStub.local.url });
    expect(resolveEndpoint(mlDestinationStub.lan, null)).toEqual({ url: mlDestinationStub.lan.url, authToken: 'lan-token' });
  });

  it('resolves a RunPod destination only to what the RunPod service published', () => {
    expect(resolveEndpoint(mlDestinationStub.runPodConsented, null)).toBeNull();
    const published = { url: 'https://endpoint.api.runpod.ai/', authToken: 'rp' };
    expect(resolveEndpoint(mlDestinationStub.runPodConsented, published)).toEqual(published);
  });

  it('never resolves a non-cloud destination to the RunPod endpoint', () => {
    const published = { url: 'https://endpoint.api.runpod.ai/', authToken: 'rp' };
    expect(resolveEndpoint({ ...mlDestinationStub.local, url: null }, published)).toBeNull();
  });
});

describe('consent and probe helpers', () => {
  it('requires consent for cloud kinds only', () => {
    expect(hasRequiredConsent(mlDestinationStub.local)).toBe(true);
    expect(hasRequiredConsent(mlDestinationStub.runPod)).toBe(false);
    expect(hasRequiredConsent(mlDestinationStub.runPodConsented)).toBe(true);
  });

  it('derives health and a readable summary from a probe', () => {
    expect(healthFromProbe(mlProbeStub.healthy)).toBe(MlDestinationHealth.Healthy);
    expect(healthFromProbe(mlProbeStub.unreachable)).toBe(MlDestinationHealth.Unhealthy);
    expect(summarizeProbe(mlProbeStub.unreachable)).toBe('Unreachable: fetch failed');
    expect(summarizeProbe(mlProbeStub.healthy)).toContain('Serves face, clip, ocr, enrichment');
  });
});

describe('selectMlDestination', () => {
  it('admits and returns a selection whose accounting hook records the request', async () => {
    const d = deps({});
    const selection = await selectMlDestination(d, { workload: MlWorkload.Face, destinationId: 'ml-destination-local', jobId: 'asset-1', jobName: 'faceDetection' });

    expect(selection).toMatchObject({
      destinationId: 'ml-destination-local',
      kind: MlDestinationKind.Local,
      workload: MlWorkload.Face,
      endpoint,
    });
    expect(d.machineLearningRepository.probe).toHaveBeenCalledWith(endpoint, { maxAgeMs: expect.any(Number) });
    expect(d.mlDestinationRepository.recordProbe).toHaveBeenCalledWith(
      'ml-destination-local',
      expect.objectContaining({ health: MlDestinationHealth.Healthy }),
    );

    selection.record({ bytesSent: 1024, bytesReceived: 64, durationMs: 40, outcome: 'success' });
    await vi.waitFor(() =>
      expect(d.mlDestinationRepository.recordAccounting).toHaveBeenCalledWith(
        expect.objectContaining({
          destinationId: 'ml-destination-local',
          destinationKind: MlDestinationKind.Local,
          workload: MlWorkload.Face,
          jobId: 'asset-1',
          jobName: 'faceDetection',
          bytesSent: 1024,
          bytesReceived: 64,
          durationMs: 40,
          outcome: 'success',
        }),
      ),
    );
  });

  it('throws not-found for an unknown destination and never probes anything', async () => {
    const d = deps({ destination: undefined });
    await expect(selectMlDestination(d, { workload: MlWorkload.Face, destinationId: 'gone' })).rejects.toBeInstanceOf(
      MlDestinationNotFoundError,
    );
    expect(d.machineLearningRepository.probe).not.toHaveBeenCalled();
  });

  it('refuses an unconsented cloud destination before touching the network', async () => {
    const d = deps({
      destination: mlDestinationStub.runPod,
      runPod: { url: 'https://endpoint.api.runpod.ai/', authToken: 'rp' },
    });
    const error = await selectMlDestination(d, { workload: MlWorkload.Enrichment, destinationId: 'ml-destination-runpod' }).catch(
      (error_) => error_,
    );
    expect(error).toBeInstanceOf(MlDestinationRefusedError);
    expect((error as MlDestinationRefusedError).refusal).toBe(MlAdmissionRefusal.ConsentMissing);
    expect(d.machineLearningRepository.probe).not.toHaveBeenCalled();
  });

  it('refuses when the destination is unreachable and records the failed probe', async () => {
    const d = deps({ probe: mlProbeStub.unreachable });
    const error = await selectMlDestination(d, { workload: MlWorkload.Face, destinationId: 'ml-destination-local' }).catch(
      (error_) => error_,
    );
    expect((error as MlDestinationRefusedError).refusal).toBe(MlAdmissionRefusal.DestinationUnhealthy);
    expect(d.mlDestinationRepository.recordProbe).toHaveBeenCalledWith(
      'ml-destination-local',
      expect.objectContaining({ health: MlDestinationHealth.Unhealthy, workloads: null }),
    );
  });

  it('refuses a consented RunPod destination with no published worker rather than resolving elsewhere', async () => {
    const d = deps({ destination: mlDestinationStub.runPodConsented, runPod: null });
    const error = await selectMlDestination(d, { workload: MlWorkload.Enrichment, destinationId: 'ml-destination-runpod' }).catch(
      (error_) => error_,
    );
    expect((error as MlDestinationRefusedError).refusal).toBe(MlAdmissionRefusal.EndpointUnresolved);
    expect(d.machineLearningRepository.probe).not.toHaveBeenCalled();
  });

  it('checks the budget only when a limit is set', async () => {
    const d = deps({});
    await selectMlDestination(d, { workload: MlWorkload.Face, destinationId: 'ml-destination-local' });
    expect(d.mlDestinationRepository.getSpend).not.toHaveBeenCalled();
  });
});

describe('routedMlDestinationId', () => {
  it('returns the routed destination', async () => {
    const d = deps({ route: { workload: MlWorkload.Clip, destinationId: 'ml-destination-local' } });
    await expect(routedMlDestinationId(d.mlDestinationRepository, MlWorkload.Clip)).resolves.toBe('ml-destination-local');
  });

  it('refuses an unrouted workload instead of choosing a destination', async () => {
    const d = deps({ route: undefined });
    const error = await routedMlDestinationId(d.mlDestinationRepository, MlWorkload.Ocr).catch((error_) => error_);
    expect(error).toBeInstanceOf(MlDestinationRefusedError);
    expect((error as MlDestinationRefusedError).refusal).toBe(MlAdmissionRefusal.WorkloadNotRouted);
  });
});
