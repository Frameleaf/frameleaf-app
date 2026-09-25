import { Injectable } from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import { HardwareCheck, HardwareCheckResponseDto } from 'src/dtos/hardware-check.dto.js';
import { MlDestinationKind, MlWorkload, SystemMetadataKey } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import {
  ContainerTest,
  MlContainerReport,
  benchmarkFactors,
  detectHardwareIssues,
  median,
  mlCheckFrom,
  serverCheckFrom,
} from 'src/utils/hardware-check.js';
import { resolveEndpoint } from 'src/utils/ml-destination.js';

/** Search embeddings the benchmark times; the median decides, so the first (model load) does not. */
const BENCHMARK_EMBEDDINGS = 5;

/**
 * Settings → Compute & jobs → Hardware & GPU (FL-159, CLD-201). Checks the GPU each container can
 * use: the server container reads its own devices and runs a short test transcode; the ML container
 * reports through its `GET /hardware` probe, and a test search embedding is timed through the route
 * search uses. The result is kept, so the model sliders follow it until the next check.
 */
@Injectable()
export class HardwareCheckService extends BaseService {
  async getCheck(): Promise<HardwareCheckResponseDto> {
    return (await this.systemMetadataRepository.get(SystemMetadataKey.HardwareCheck)) ?? this.runCheck();
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
    const result: HardwareCheck = { ...check, benchmark: same ? previous.benchmark : null };
    await this.systemMetadataRepository.set(SystemMetadataKey.HardwareCheck, result);
    return result;
  }

  /** Check again, timing a few search embeddings and the test transcode, and keep the speed factors. */
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
      },
    };
    await this.systemMetadataRepository.set(SystemMetadataKey.HardwareCheck, result);
    return result;
  }

  private async check(embeddings: number): Promise<Omit<HardwareCheck, 'benchmark'>> {
    const [serverFacts, mlReport] = await Promise.all([
      this.hardwareProbeRepository.readServer(),
      this.readMlContainer(),
    ]);
    const embedding = await this.timeEmbeddings(embeddings, mlReport);
    return {
      checkedAt: new Date().toISOString(),
      server: serverCheckFrom(serverFacts),
      ml: mlCheckFrom(mlReport, embedding),
      mlImage: mlReport?.image ?? null,
      issues: detectHardwareIssues(serverFacts, mlReport),
    };
  }

  /** The ML container of this server: the first enabled local destination, as the settings probe it. */
  private async readMlContainer(): Promise<MlContainerReport | null> {
    const local = (await this.mlDestinationRepository.getAll()).find(
      (row) => row.kind === MlDestinationKind.Local && row.enabled,
    );
    const endpoint = local ? resolveEndpoint(local) : null;
    return endpoint ? this.machineLearningRepository.getContainerHardware(endpoint) : null;
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
      return {
        kind: 'embedding',
        ok: false,
        gpu: false,
        value: null,
        error: error instanceof Error ? error.message.slice(0, 300) : String(error),
      };
    }
  }
}
