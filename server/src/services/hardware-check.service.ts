import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { MachineLearningConfig } from 'src/dtos/config.dto.js';
import { HardwareCheck, HardwareCheckResponseDto } from 'src/dtos/hardware-check.dto.js';
import { MlDestinationKind, MlWorkerRole, MlWorkload, RenderWorkerStatus, SystemMetadataKey } from 'src/enum.js';
import { MlDestinationRow } from 'src/repositories/ml-destination.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { evaluateApprovedRenderSession } from 'src/utils/gpu-working-budget-policy.js';
import {
  ContainerTest,
  MlContainerReport,
  WORKER_MODEL_MODES,
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
  runsOnDevice,
  serverCheckFrom,
  unavailableWorkload,
} from 'src/utils/hardware-check.js';
import { mlWorkerRoleOf, resolveEndpoint } from 'src/utils/ml-destination.js';

/** Search embeddings the benchmark times; the median decides, so the first (model load) does not. */
const BENCHMARK_EMBEDDINGS = 5;
/** Test photos the description benchmark times after one that loads the model. */
const BENCHMARK_DESCRIPTIONS = 2;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);

type MeasurementSource = { destinations: MlDestinationRow[]; machineLearning: MachineLearningConfig; scope: string };

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
    if (
      stored &&
      'findings' in stored &&
      'workers' in stored &&
      'benchmarkScope' in stored &&
      typeof stored.benchmarkScope === 'string'
    ) {
      const { benchmarkScope: _scope, ...result } = stored;
      return result;
    }
    return this.runCheck();
  }

  async runCheck(): Promise<HardwareCheckResponseDto> {
    const previous = await this.systemMetadataRepository.get(SystemMetadataKey.HardwareCheck);
    const source = await this.readMeasurementSource();
    const check = await this.check(1, source);
    // A benchmark measured on other hardware says nothing about this one.
    const same =
      previous?.benchmark &&
      'benchmarkScope' in previous &&
      previous.benchmarkScope === source.scope &&
      previous.server.model === check.server.model &&
      previous.server.backend === check.server.backend &&
      previous.ml.model === check.ml.model &&
      previous.ml.backend === check.ml.backend;
    const result: HardwareCheck = {
      ...check,
      benchmark: same ? { ...previous.benchmark!, workloads: previous.benchmark!.workloads ?? [] } : null,
    };
    const stored = { ...result, benchmarkScope: source.scope };
    await this.systemMetadataRepository.set(SystemMetadataKey.HardwareCheck, stored);
    return result;
  }

  /**
   * Check again, timing a few search embeddings and the test transcode for the speed factors, and
   * record the throughput of each kind of work the model sliders estimate, or why it has none.
   */
  async runBenchmark(): Promise<HardwareCheckResponseDto> {
    const source = await this.readMeasurementSource();
    const check = await this.check(BENCHMARK_EMBEDDINGS, source);
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
        workloads: await this.benchmarkWorkloads(source),
      },
    };
    const stored = { ...result, benchmarkScope: source.scope };
    await this.systemMetadataRepository.set(SystemMetadataKey.HardwareCheck, stored);
    return result;
  }

  private async readMeasurementSource(): Promise<MeasurementSource> {
    const [destinations, { machineLearning }] = await Promise.all([
      this.mlDestinationRepository.getAll(),
      this.getConfig({ withCache: true }),
    ]);
    const workers = destinations
      .filter((row) => row.enabled && row.kind !== MlDestinationKind.FrameleafCloud)
      .map(({ id, kind, name, url, authToken, workloads }) => ({
        id,
        kind,
        name,
        url,
        authToken,
        workloads: [...workloads].sort(),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    // Only the digest is persisted; endpoint credentials and model settings stay out of responses.
    const scope = createHash('sha256')
      .update(JSON.stringify({ localId: this.localDestination(destinations)?.id ?? null, workers, machineLearning }))
      .digest('hex');
    return { destinations, machineLearning, scope };
  }

  private async check(embeddings: number, source: MeasurementSource): Promise<Omit<HardwareCheck, 'benchmark'>> {
    const { destinations, machineLearning } = source;
    const [serverFacts, mlReport, workers] = await Promise.all([
      this.hardwareProbeRepository.readServer(),
      this.readMlContainer(destinations),
      this.readWorkers(destinations),
    ]);
    const embedding = await this.timeEmbeddings(
      embeddings,
      mlReport,
      this.localDestination(destinations),
      machineLearning,
    );
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
    const evaluated = await Promise.all(
      sessions.map(async (entry) => ({
        ...entry,
        budget: evaluateApprovedRenderSession({
          ...entry,
          capabilities: await this.renderWorkerRepository.getSessionCapabilities(entry.session.id),
          now: new Date(),
        }),
      })),
    );
    const render = renderWorkers
      .filter((worker) => worker.status === RenderWorkerStatus.Active)
      .map((worker) => {
        const qualified = evaluated.find((entry) => entry.worker.id === worker.id && entry.budget.valid);
        return renderWorkerCheckFrom(worker, qualified?.budget.valid ? qualified.budget : null);
      });
    const restoration = await Promise.all(
      this.restorationDestinations(destinations).map(async (row) =>
        restorationWorkerCheckFrom(row, await this.restorationReport(row)),
      ),
    );
    return [...render, ...restoration];
  }

  /** Time the search route only when it still names the local container whose hardware was read. */
  private async timeEmbeddings(
    times: number,
    report: MlContainerReport | null,
    local: MlDestinationRow | undefined,
    machineLearning: MachineLearningConfig,
  ): Promise<ContainerTest | null> {
    if (!machineLearning.enabled || !machineLearning.clip.enabled || !local) {
      return null;
    }
    const gpu = !!report && report.gpus.length > 0 && report.backend !== 'CPU';
    try {
      const selection = await this.selectRoutedMlDestination({ workload: MlWorkload.Clip, jobName: 'HardwareCheck' });
      if (
        selection.destinationId !== local.id ||
        selection.endpoint.url !== local.url ||
        selection.endpoint.authToken !== (local.authToken ?? undefined)
      ) {
        return null;
      }
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
   * Cloud); restoration and Smooth motion (interpolation, which the restoration service runs on the
   * same worker, FL-162) come from what that worker measured on the GPU it has now; the rest have
   * no local runner or no measurement, and say so.
   */
  private async benchmarkWorkloads(source: MeasurementSource): Promise<WorkloadBenchmark[]> {
    const { destinations, machineLearning } = source;
    const studioWorker = destinations.some(
      (row) =>
        row.enabled && row.kind !== MlDestinationKind.FrameleafCloud && row.workloads.includes(MlWorkload.StudioAi),
    );
    const [restoration, interpolation] = await this.benchmarkRestorationWorkers(destinations);
    return [
      await this.benchmarkDescriptions(destinations, machineLearning),
      unavailableWorkload('upscale', 'no-local-runner'),
      restoration,
      // A transcription worker publishes no throughput and has no test route to time.
      unavailableWorkload('studio', studioWorker ? 'not-measured' : 'no-local-worker'),
      interpolation,
    ];
  }

  /**
   * The model and device are what the worker reports for the timed photos (FL-427): the configured
   * model's fallback may answer instead, and OpenVINO may retry on the processor.
   */
  private async benchmarkDescriptions(
    destinations: MlDestinationRow[],
    machineLearning: MachineLearningConfig,
  ): Promise<WorkloadBenchmark> {
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
      if (
        selection.destinationId !== local.id ||
        selection.endpoint.url !== local.url ||
        selection.endpoint.authToken !== (local.authToken ?? undefined)
      ) {
        throw new Error('Local ML destination changed during the hardware benchmark');
      }
      const runs = await this.hardwareProbeRepository.withTestImage(async (path) => {
        const measured: Array<{ ms: number; model: string; device: string | null }> = [];
        // The first photo loads the model; only the ones after it are timed.
        for (let index = 0; index <= BENCHMARK_DESCRIPTIONS; index++) {
          const started = performance.now();
          const run = await this.machineLearningRepository.describeImageRun(
            selection,
            path,
            machineLearning.imageDescription,
          );
          if (index > 0) {
            measured.push({ ms: performance.now() - started, model: run.model, device: run.device });
          }
        }
        return measured;
      });
      const ms = median(runs.map((run) => run.ms));
      const last = runs.at(-1);
      if (ms === null || ms <= 0 || !last) {
        return unavailableWorkload('descriptions', 'failed');
      }
      const configured = machineLearning.imageDescription.modelName;
      return measuredWorkload('descriptions', {
        unit: 'photo',
        secondsPerUnit: ms / 1000,
        source: 'benchmark',
        runsOn: runsOnDevice(last.device),
        worker: local.name,
        model: last.model,
        fallbackFrom: last.model === configured ? null : configured,
      });
    } catch (error) {
      return unavailableWorkload('descriptions', 'failed', errorText(error));
    }
  }

  /**
   * Restoration and Smooth motion from the restoration workers' own reports, each read once: the
   * fastest ready model of the workload's modes measured on the GPU the worker has now. Smooth motion
   * counts only workers allowed to run it.
   */
  private async benchmarkRestorationWorkers(
    destinations: MlDestinationRow[],
  ): Promise<[WorkloadBenchmark, WorkloadBenchmark]> {
    const reports = await Promise.all(
      this.restorationDestinations(destinations).map(async (row) => ({
        row,
        report: await this.restorationReport(row),
      })),
    );
    const benchmark = (
      workload: 'restoration' | 'interpolation',
      serves: (row: MlDestinationRow) => boolean,
    ): WorkloadBenchmark => {
      const candidates = reports.filter(({ row }) => serves(row));
      if (candidates.length === 0) {
        return unavailableWorkload(workload, 'no-local-worker');
      }
      let best: { row: MlDestinationRow; fps: number } | null = null;
      for (const { row, report } of candidates) {
        const fps = report ? restorationThroughput(report, WORKER_MODEL_MODES[workload]) : null;
        if (fps !== null && (!best || fps > best.fps)) {
          best = { row, fps };
        }
      }
      if (!best) {
        return unavailableWorkload(workload, 'not-measured');
      }
      return measuredWorkload(workload, {
        unit: 'frame',
        secondsPerUnit: 1 / best.fps,
        source: 'qualification',
        runsOn: 'gpu',
        worker: best.row.name,
      });
    };
    return [
      benchmark('restoration', () => true),
      benchmark('interpolation', (row) => row.workloads.includes(MlWorkload.Interpolation)),
    ];
  }
}
