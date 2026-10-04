import { Injectable } from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import { HardwareCheck, HardwareCheckResponseDto } from 'src/dtos/hardware-check.dto.js';
import { MlDestinationKind, MlWorkerRole, MlWorkload, RenderWorkerStatus, SystemMetadataKey } from 'src/enum.js';
import { MlDestinationRow } from 'src/repositories/ml-destination.repository.js';
import { BaseService } from 'src/services/base.service.js';
import {
  ContainerTest,
  MlContainerReport,
  WorkerCheck,
  WorkloadBenchmark,
  benchmarkFactors,
  detectHardwareFindings,
  measuredWorkload,
  median,
  mlCheckFrom,
  renderWorkerCheckFrom,
  restorationThroughput,
  restorationWorkerCheckFrom,
  serverCheckFrom,
  unavailableWorkload,
} from 'src/utils/hardware-check.js';
import { mlWorkerRoleOf, resolveEndpoint } from 'src/utils/ml-destination.js';

/** Search embeddings the benchmark times; the median decides, so the first (model load) does not. */
const BENCHMARK_EMBEDDINGS = 5;
/** Test photos the description benchmark times after one that loads the model. */
const BENCHMARK_DESCRIPTIONS = 2;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);

/**
 * Settings → Compute & jobs → Hardware & GPU (FL-159, CLD-201). Checks the GPU each container can
 * use: the server container reads its own devices and runs a short test transcode; the ML container
 * reports through its `GET /hardware` probe, and a test search embedding is timed through the route
 * search uses. Render and restoration workers are shown from the evidence they reported. The result
 * is kept, so the model sliders follow it until the next check.
 */
@Injectable()
export class HardwareCheckService extends BaseService {
  async getCheck(): Promise<HardwareCheckResponseDto> {
    const stored = await this.systemMetadataRepository.get(SystemMetadataKey.HardwareCheck);
    // A check kept by an earlier version lacks the per-container facts; check again rather than guess.
    return stored && 'findings' in stored && 'workers' in stored ? stored : this.runCheck();
  }

  async runCheck(): Promise<HardwareCheckResponseDto> {
    const previous = await this.systemMetadataRepository.get(SystemMetadataKey.HardwareCheck);
    const check = await this.check(1);
    // A benchmark measured on other hardware says nothing about this one.
    const same =
      previous?.benchmark &&
      previous.server.model === check.server.model &&
      previous.server.backend === check.server.backend &&
      previous.ml.model === check.ml.model &&
      previous.ml.backend === check.ml.backend;
    const result: HardwareCheck = {
      ...check,
      benchmark: same ? { ...previous.benchmark!, workloads: previous.benchmark!.workloads ?? [] } : null,
    };
    await this.systemMetadataRepository.set(SystemMetadataKey.HardwareCheck, result);
    return result;
  }

  /**
   * Check again, timing a few search embeddings and the test transcode for the speed factors, and
   * record the throughput of each kind of work the model sliders estimate, or why it has none.
   */
  async runBenchmark(): Promise<HardwareCheckResponseDto> {
    const check = await this.check(BENCHMARK_EMBEDDINGS);
    const embeddingMs = check.ml.test?.gpu || check.ml.test?.ok ? check.ml.test.value : null;
    const transcodeSpeed = check.server.test?.value ?? null;
    const factors = benchmarkFactors(
      { backend: check.ml.backend, embeddingMs },
      { backend: check.server.backend, transcodeSpeed },
    );
    const result: HardwareCheck = {
      ...check,
      benchmark: {
        ranAt: new Date().toISOString(),
        embeddingMs,
        transcodeSpeed,
        mlFactor: factors.ml,
        serverFactor: factors.server,
        workloads: await this.benchmarkWorkloads(check.ml.gpu.usable === true),
      },
    };
    await this.systemMetadataRepository.set(SystemMetadataKey.HardwareCheck, result);
    return result;
  }

  private async check(embeddings: number): Promise<Omit<HardwareCheck, 'benchmark'>> {
    const destinations = await this.mlDestinationRepository.getAll();
    const [serverFacts, mlReport, workers] = await Promise.all([
      this.hardwareProbeRepository.readServer(),
      this.readMlContainer(destinations),
      this.readWorkers(destinations),
    ]);
    const embedding = await this.timeEmbeddings(embeddings, mlReport);
    const findings = detectHardwareFindings(serverFacts, mlReport);
    return {
      checkedAt: new Date().toISOString(),
      server: serverCheckFrom(serverFacts),
      ml: mlCheckFrom(mlReport, embedding),
      mlImage: mlReport?.image ?? null,
      issues: [...new Set(findings.map((finding) => finding.id))],
      findings,
      workers,
    };
  }

  /** The ML container of this server: the first enabled local destination, as the settings probe it. */
  private localDestination(destinations: MlDestinationRow[]) {
    return destinations.find((row) => row.kind === MlDestinationKind.Local && row.enabled);
  }

  private async readMlContainer(destinations: MlDestinationRow[]): Promise<MlContainerReport | null> {
    const local = this.localDestination(destinations);
    const endpoint = local ? resolveEndpoint(local) : null;
    return endpoint ? this.machineLearningRepository.getContainerHardware(endpoint) : null;
  }

  /** Enabled restoration workers on this network (local or LAN, never Frameleaf Cloud). */
  private restorationDestinations(destinations: MlDestinationRow[]) {
    return destinations.filter(
      (row) =>
        row.enabled &&
        row.kind !== MlDestinationKind.FrameleafCloud &&
        mlWorkerRoleOf(row.workloads) === MlWorkerRole.Restoration,
    );
  }

  private async restorationReport(row: MlDestinationRow) {
    const endpoint = resolveEndpoint(row);
    if (!endpoint) {
      return null;
    }
    return this.machineLearningRepository.getRestorationModels(endpoint).catch((error: unknown) => {
      this.logger.warn(`Hardware check could not read restoration worker ${row.id}: ${errorText(error)}`);
      return null;
    });
  }

  /**
   * Enrolled render workers from their live sessions, and restoration workers from their own
   * report. Neither is inspected here; a fact a worker does not report stays unknown.
   */
  private async readWorkers(destinations: MlDestinationRow[]): Promise<WorkerCheck[]> {
    const [renderWorkers, sessions] = await Promise.all([
      this.renderWorkerRepository.listWorkers(),
      this.renderWorkerRepository.listLiveSessions(),
    ]);
    const render = renderWorkers
      .filter((worker) => worker.status === RenderWorkerStatus.Active)
      .map((worker) => {
        const live = sessions
          .filter((entry) => entry.worker.id === worker.id)
          .map((entry) => entry.session)
          .toSorted((a, b) => Number(b.gpuMemoryBytes ?? 0) - Number(a.gpuMemoryBytes ?? 0));
        return renderWorkerCheckFrom(worker, live[0] ?? null);
      });
    const restoration = await Promise.all(
      this.restorationDestinations(destinations).map(async (row) =>
        restorationWorkerCheckFrom(row, await this.restorationReport(row)),
      ),
    );
    return [...render, ...restoration];
  }

  /** Time search embeddings through the route search uses; null when search is off or not routed. */
  private async timeEmbeddings(times: number, report: MlContainerReport | null): Promise<ContainerTest | null> {
    const { machineLearning } = await this.getConfig({ withCache: true });
    if (!machineLearning.enabled || !machineLearning.clip.enabled) {
      return null;
    }
    const gpu = !!report && report.gpus.length > 0 && report.backend !== 'CPU';
    try {
      const selection = await this.selectRoutedMlDestination({ workload: MlWorkload.Clip, jobName: 'HardwareCheck' });
      const timings: number[] = [];
      for (let index = 0; index < times; index++) {
        const started = performance.now();
        await this.machineLearningRepository.encodeText(selection, 'a photo of a dog on a beach', {
          modelName: machineLearning.clip.modelName,
        });
        timings.push(performance.now() - started);
      }
      const ms = median(times > 1 ? timings.slice(1) : timings);
      return { kind: 'embedding', ok: true, gpu, value: ms === null ? null : Math.round(ms), error: null };
    } catch (error) {
      return { kind: 'embedding', ok: false, gpu: false, value: null, error: errorText(error) };
    }
  }

  /**
   * Throughput per kind of work the model sliders estimate. Descriptions are timed on this server's
   * ML container with the configured model and a generated test photo (never sent to Frameleaf
   * Cloud); restoration comes from what its worker measured on the GPU it has now; the rest have no
   * local runner or no measurement, and say so.
   */
  private async benchmarkWorkloads(mlGpu: boolean): Promise<WorkloadBenchmark[]> {
    const destinations = await this.mlDestinationRepository.getAll();
    const studioWorker = destinations.some(
      (row) =>
        row.enabled && row.kind !== MlDestinationKind.FrameleafCloud && row.workloads.includes(MlWorkload.StudioAi),
    );
    return [
      await this.benchmarkDescriptions(destinations, mlGpu),
      unavailableWorkload('upscale', 'no-local-runner'),
      await this.benchmarkRestoration(destinations),
      // A transcription worker publishes no throughput and has no test route to time.
      unavailableWorkload('studio', studioWorker ? 'not-measured' : 'no-local-worker'),
      unavailableWorkload('interpolation', 'no-local-runner'),
    ];
  }

  private async benchmarkDescriptions(destinations: MlDestinationRow[], mlGpu: boolean): Promise<WorkloadBenchmark> {
    const { machineLearning } = await this.getConfig({ withCache: true });
    if (!machineLearning.enabled) {
      return unavailableWorkload('descriptions', 'machine-learning-off');
    }
    const local = this.localDestination(destinations);
    if (!local) {
      return unavailableWorkload('descriptions', 'no-local-worker');
    }
    try {
      const selection = await this.selectMlDestination({
        workload: MlWorkload.Enrichment,
        destinationId: local.id,
        jobName: 'HardwareBenchmark',
      });
      const timings = await this.hardwareProbeRepository.withTestImage(async (path) => {
        const measured: number[] = [];
        // The first photo loads the model; only the ones after it are timed.
        for (let index = 0; index <= BENCHMARK_DESCRIPTIONS; index++) {
          const started = performance.now();
          await this.machineLearningRepository.describeImage(selection, path, machineLearning.imageDescription);
          if (index > 0) {
            measured.push(performance.now() - started);
          }
        }
        return measured;
      });
      const ms = median(timings);
      if (ms === null || ms <= 0) {
        return unavailableWorkload('descriptions', 'failed');
      }
      return measuredWorkload('descriptions', {
        unit: 'photo',
        secondsPerUnit: ms / 1000,
        source: 'benchmark',
        runsOn: mlGpu ? 'gpu' : 'cpu',
        worker: local.name,
      });
    } catch (error) {
      return unavailableWorkload('descriptions', 'failed', errorText(error));
    }
  }

  private async benchmarkRestoration(destinations: MlDestinationRow[]): Promise<WorkloadBenchmark> {
    const rows = this.restorationDestinations(destinations);
    if (rows.length === 0) {
      return unavailableWorkload('restoration', 'no-local-worker');
    }
    let best: { row: MlDestinationRow; fps: number } | null = null;
    for (const row of rows) {
      const report = await this.restorationReport(row);
      const fps = report ? restorationThroughput(report) : null;
      if (fps !== null && (!best || fps > best.fps)) {
        best = { row, fps };
      }
    }
    if (!best) {
      return unavailableWorkload('restoration', 'not-measured');
    }
    return measuredWorkload('restoration', {
      unit: 'frame',
      secondsPerUnit: 1 / best.fps,
      source: 'qualification',
      runsOn: 'gpu',
      worker: best.row.name,
    });
  }
}
