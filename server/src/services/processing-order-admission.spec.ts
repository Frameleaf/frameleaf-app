import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MlEndpoint, MlSelection } from 'src/repositories/machine-learning.repository.js';
import type { MlSelectionRequest } from 'src/utils/ml-destination.js';
import type { MlRouteCandidate } from 'src/utils/ml-processing-order.js';
import { MlAdmissionRefusal, MlProcessingSource, MlWorkload } from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { QueueExecution } from 'src/queue/types.js';
import { BaseService } from 'src/services/base.service.js';
import { MlDestinationRefusedError } from 'src/utils/ml-destination.js';
import { mlDestinationStub, mlProbeStub } from 'test/fixtures/ml-destination.stub.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

/** Any service admits library work the same way (`BaseService.selectRoutedMlDestination`). */
class AdmittingService extends BaseService {
  select(request: Omit<MlSelectionRequest, 'destinationId'>) {
    return this.selectRoutedMlDestination(request);
  }
}

const local = mlDestinationStub.local;
const study = { ...mlDestinationStub.libraryLan, workloads: [MlWorkload.Enrichment, MlWorkload.Ocr] };
const rows = new Map([local, study].map((row) => [row.id, row]));

const candidate = (
  destinationId: string,
  source: MlProcessingSource,
  extra: Partial<MlRouteCandidate> = {},
): MlRouteCandidate => ({ destinationId, source, desktopPool: false, available: true, ...extra });

describe('admission follows the processing order (FL-456)', () => {
  let sut: AdmittingService;
  let mocks: ServiceMocks;
  let context: QueueExecution;
  const down = new Set<string>();

  const run = <T>(work: () => Promise<T>) => queueExecution.run(context, work);

  beforeEach(() => {
    ({ sut, mocks } = newTestService(AdmittingService));
    down.clear();
    mocks.mlDestination.getById.mockImplementation((id) => Promise.resolve(rows.get(id)));
    mocks.machineLearning.probe.mockImplementation((endpoint: MlEndpoint) =>
      Promise.resolve(
        [...down].some((id) => rows.get(id)?.url === endpoint.url) ? mlProbeStub.unreachable : mlProbeStub.healthy,
      ),
    );
    mocks.mlDestination.resolveRoute.mockResolvedValue([
      candidate(local.id, MlProcessingSource.Local),
      candidate(study.id, MlProcessingSource.Desktops),
    ]);
    context = {
      claim: {
        id: 'job',
        token: 'claim',
        name: 'test',
        queue: 'test',
        data: {},
        workerId: 'worker',
        attempt: 1,
        runId: null,
        itemKey: null,
        deadlineMs: 60_000,
        startedAt: new Date(),
        safeToRetry: true,
      },
      signal: new AbortController().signal,
      adoptions: [],
      followups: [],
      buffering: false,
      progress: vi.fn(),
      progressUnits: 0,
    } as QueueExecution;
  });

  it('runs on the first place in the order and keeps the job there', async () => {
    const selection = await run(() => sut.select({ workload: MlWorkload.Enrichment }));
    expect(selection.destinationId).toBe(local.id);
    expect(mocks.job.pinDestination).toHaveBeenCalledWith(MlWorkload.Enrichment, local.id);
    expect(context.dependencyReason).toBeUndefined();
  });

  it('moves on to the next place when the first does not answer, without leaving the job waiting', async () => {
    down.add(local.id);
    const selection = await run(() => sut.select({ workload: MlWorkload.Enrichment }));
    expect(selection.destinationId).toBe(study.id);
    expect(mocks.job.pinDestination).toHaveBeenCalledWith(MlWorkload.Enrichment, study.id);
    expect(context.dependencyReason).toBeUndefined();
  });

  it('waits on the first place when no place can take the job', async () => {
    down.add(local.id);
    down.add(study.id);
    const error = await run(() => sut.select({ workload: MlWorkload.Enrichment })).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(MlDestinationRefusedError);
    expect((error as MlDestinationRefusedError).refusal).toBe(MlAdmissionRefusal.DestinationUnhealthy);
    expect((error as MlDestinationRefusedError).destinationId).toBe(local.id);
    expect(context.dependencyReason).toBe('destination-unavailable');
    expect(mocks.job.pinDestination).not.toHaveBeenCalled();
  });

  it('keeps a job on the place it already ran on', async () => {
    mocks.job.pinnedDestination.mockResolvedValue(study.id);
    const selection = await run(() => sut.select({ workload: MlWorkload.Enrichment }));
    expect(selection.destinationId).toBe(study.id);
    expect(mocks.mlDestination.resolveRoute).not.toHaveBeenCalled();
  });

  it('waits on the first place in the order when the stored state says none is available', async () => {
    mocks.mlDestination.resolveRoute.mockResolvedValue([
      candidate(local.id, MlProcessingSource.Local, { available: false }),
      candidate(study.id, MlProcessingSource.Desktops, { available: false }),
    ]);
    down.add(local.id);
    await expect(run(() => sut.select({ workload: MlWorkload.Enrichment }))).rejects.toBeInstanceOf(
      MlDestinationRefusedError,
    );
    expect(mocks.mlDestination.getById).toHaveBeenCalledWith(local.id);
    expect(mocks.mlDestination.getById).not.toHaveBeenCalledWith(study.id);
  });

  it('refuses a workload whose order names nowhere', async () => {
    mocks.mlDestination.resolveRoute.mockResolvedValue([]);
    mocks.mlDestination.getRoute.mockResolvedValue(undefined);
    const error = await run(() => sut.select({ workload: MlWorkload.Enrichment })).catch((error: unknown) => error);
    expect((error as MlDestinationRefusedError).refusal).toBe(MlAdmissionRefusal.WorkloadNotRouted);
  });

  describe('Frameleaf Desktop helpers', () => {
    const order = (first: MlRouteCandidate, second: MlRouteCandidate) =>
      mocks.mlDestination.resolveRoute.mockResolvedValue([first, second]);
    const helpers = candidate(local.id, MlProcessingSource.Desktops, { desktopPool: true });
    const desktopSelection = (selection: MlSelection): MlSelection => ({ ...selection, desktopOcr: vi.fn() });

    it('keep this server for itself when it comes first', async () => {
      order(candidate(local.id, MlProcessingSource.Local), helpers);
      const selection = await run(() => sut.select({ workload: MlWorkload.Ocr }));
      expect(selection.desktopOcr).toBeUndefined();
      expect(mocks.machineLearning.selectBackgroundPool).not.toHaveBeenCalled();
    });

    it('take the job when they come first and one is ready', async () => {
      mocks.machineLearning.selectBackgroundPool.mockImplementation((selection) =>
        Promise.resolve(desktopSelection(selection)),
      );
      order(helpers, candidate(local.id, MlProcessingSource.Local));
      const selection = await run(() => sut.select({ workload: MlWorkload.Ocr, jobId: 'asset' }));
      expect(selection.desktopOcr).toBeDefined();
      expect(mocks.machineLearning.selectBackgroundPool).toHaveBeenCalledWith(expect.anything(), 'asset', true);
    });

    it('hand the job to the next place when none is ready', async () => {
      mocks.machineLearning.selectBackgroundPool.mockImplementation((selection) => Promise.resolve(selection));
      order(helpers, candidate(study.id, MlProcessingSource.Desktops));
      const selection = await run(() => sut.select({ workload: MlWorkload.Ocr }));
      expect(selection.destinationId).toBe(study.id);
      expect(selection.desktopOcr).toBeUndefined();
      expect(context.dependencyReason).toBeUndefined();
    });
  });
});
