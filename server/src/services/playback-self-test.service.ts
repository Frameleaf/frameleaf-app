import { Injectable } from '@nestjs/common';
import { isEqual } from 'lodash-es';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { ConfigFFmpegDto } from 'src/dtos/config.dto.js';
import type { PlaybackSelfTestResponseDto } from 'src/dtos/playback-self-test.dto.js';
import type { ArgOf } from 'src/repositories/event.repository.js';
import type { VideoStreamInfo } from 'src/types.js';
import { serverVersion } from 'src/constants.js';
import { OnEvent } from 'src/decorators.js';
import {
  DvProfile,
  FrameleafWorker,
  SystemMetadataKey,
  ToneMapping,
  TranscodeHardwareAcceleration,
  TranscodePolicy,
  TranscodeTarget,
} from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { DecodeSupport, qualifySourceDecode, selectDecodeAcceleration } from 'src/utils/media-decode.js';
import { BaseConfig } from 'src/utils/media.js';
import {
  HDR_PLAYBACK_CASES,
  PLAYBACK_SELF_TEST_DEADLINE_MS,
  PLAYBACK_SELF_TEST_FOLDER,
  type PlaybackCopyFacts,
  type PlaybackSelfTestCase,
  type PlaybackSelfTestCaseResult,
  type PlaybackSelfTestManifestCase,
  type PlaybackSelfTestProblem,
  type PlaybackSelfTestReason,
  type PlaybackSelfTestState,
  judgePlaybackCopy,
  playbackSettingsChanged,
  readPlaybackSelfTestManifest,
} from 'src/utils/playback-self-test.js';

/** A check that says it is still running after this long was cut short by a restart. */
const STALE_RUNNING_MS = 5 * 60_000;

/**
 * FL-977: the video playback self-test. It converts a short reference clip of each kind of video
 * (`resources/playback-self-test`: SDR H.264, iPhone HLG, Dolby Vision 8.4, HDR10 and hev1-tagged HEVC)
 * the way a playback copy is made, with the configured hardware acceleration, and checks each copy: its
 * format and tag, its colour tags and how bright it is, against the manifest and, on the graphics card,
 * against the same clip converted on the processor. The kinds that come out wrong go in
 * `ffmpeg.softwareFallback`, which `MediaService` reads to convert those kinds on the processor.
 *
 * It runs in the API worker, beside the card test of Video playback copies, so it never holds up the
 * video conversion queue; the whole check stops after `PLAYBACK_SELF_TEST_DEADLINE_MS`. It runs after
 * each upgrade, when the hardware acceleration settings change, and when asked.
 */
@Injectable()
export class PlaybackSelfTestService extends BaseService {
  private running?: Promise<void>;

  /** After an upgrade: the latest check was made by another version (or, with a card on, never made). */
  @OnEvent({ name: 'AppBootstrap', workers: [FrameleafWorker.Api] })
  async onBootstrap(): Promise<void> {
    try {
      const [state, { ffmpeg }] = await Promise.all([this.read(), this.getConfig({ withCache: false })]);
      const version = serverVersion.toString();
      const upgraded = state
        ? state.serverVersion !== version
        : ffmpeg.accel !== TranscodeHardwareAcceleration.Disabled;
      if (upgraded) {
        await this.start('upgrade');
      }
    } catch (error) {
      // the check never stops a start
      this.logger.warn(`Could not start the playback self-test: ${error}`);
    }
  }

  @OnEvent({ name: 'ConfigUpdate', server: true, workers: [FrameleafWorker.Api] })
  async onConfigUpdate({ oldConfig, newConfig }: ArgOf<'ConfigUpdate'>): Promise<void> {
    if (playbackSettingsChanged(oldConfig.ffmpeg, newConfig.ffmpeg)) {
      await this.start('settings');
    }
  }

  async getPlaybackSelfTest(): Promise<PlaybackSelfTestResponseDto> {
    return toResponse(await this.read());
  }

  /** `POST /admin/playback-self-test`: starts a check (or joins the one running) and answers at once. */
  async startPlaybackSelfTest(): Promise<PlaybackSelfTestResponseDto> {
    await this.start('manual');
    return toResponse(await this.read());
  }

  /**
   * Starts a check in the background, unless this worker is running one, and resolves once it is on
   * record as running; the check itself goes on without anyone waiting for it.
   */
  private async start(reason: PlaybackSelfTestReason): Promise<void> {
    if (this.running) {
      return;
    }
    let onRecord!: () => void;
    const recorded = new Promise<void>((resolve) => (onRecord = resolve));
    const running = this.run(reason, onRecord)
      .then(() => {})
      .catch((error) => {
        this.logger.error(`The playback self-test stopped: ${error}`);
      })
      .finally(() => {
        this.running = undefined;
      });
    this.running = running;
    await Promise.race([recorded, running]);
  }

  /** Waits for the check this worker is running, if any (for tests and shutdown). */
  async settled(): Promise<void> {
    await this.running;
  }

  /** Runs the whole check and keeps its result; resolves with what was kept. */
  async run(reason: PlaybackSelfTestReason, onRecord?: () => void): Promise<PlaybackSelfTestState> {
    const { ffmpeg } = await this.getConfig({ withCache: false });
    const state: PlaybackSelfTestState = {
      status: 'running',
      reason,
      serverVersion: serverVersion.toString(),
      startedAt: new Date().toISOString(),
      finishedAt: null,
      accel: ffmpeg.accel,
      accelDecode: ffmpeg.accelDecode,
      cases: [],
      softwareFallback: ffmpeg.softwareFallback ?? [],
      error: null,
    };
    await this.systemMetadataRepository.set(SystemMetadataKey.PlaybackSelfTest, { ...state });
    onRecord?.();
    this.logger.log(`Playback self-test started (${reason}, ${ffmpeg.accel})`);

    const deadline = AbortSignal.timeout(PLAYBACK_SELF_TEST_DEADLINE_MS);
    const folder = await this.storageRepository.mkdtemp('frameleaf-playback-self-test-');
    try {
      const manifest = readPlaybackSelfTestManifest();
      const interfaces = await this.storageCore.getVideoInterfaces();
      for (const clip of manifest.cases) {
        state.cases.push(await this.check(clip, ffmpeg, interfaces, folder, deadline));
      }
      state.status = 'done';
    } catch (error) {
      state.status = 'failed';
      state.error = deadline.aborted ? 'The check took too long' : String(error);
      this.logger.warn(`The playback self-test could not finish: ${state.error}`);
    } finally {
      await this.storageRepository.unlinkDir(folder, { recursive: true, force: true }).catch(() => {});
    }

    state.softwareFallback = fallbackFor(state, ffmpeg);
    state.finishedAt = new Date().toISOString();
    await this.systemMetadataRepository.set(SystemMetadataKey.PlaybackSelfTest, state);
    await this.saveFallback(state.softwareFallback);
    const failed = state.cases.filter((result) => !result.passed).map((result) => result.id);
    this.logger.log(
      `Playback self-test ${state.status}: ${failed.length === 0 ? 'every kind of video came out right' : `wrong for ${failed.join(', ')}`}`,
    );
    return state;
  }

  /** One reference clip: converted as configured, then (on a card) on the processor for comparison. */
  private async check(
    clip: PlaybackSelfTestManifestCase,
    ffmpeg: ConfigFFmpegDto,
    interfaces: Parameters<typeof BaseConfig.create>[1],
    folder: string,
    signal: AbortSignal,
  ): Promise<PlaybackSelfTestCaseResult> {
    const { lumaTolerance, referenceTolerance } = readPlaybackSelfTestManifest();
    const input = join(PLAYBACK_SELF_TEST_FOLDER, clip.file);
    const [stream] = (await this.mediaRepository.probe(input, { countFrames: false, signal })).videoStreams;
    if (!stream) {
      throw new Error(`The reference clip ${clip.file} has no picture`);
    }
    // a copy is always made, whatever the playback copy policy, and in one pass
    const config: ConfigFFmpegDto = { ...ffmpeg, transcode: TranscodePolicy.All, twoPass: false };
    const hardware = config.accel !== TranscodeHardwareAcceleration.Disabled;

    const started = performance.now();
    const copy = await this.convert(clip, input, stream, config, interfaces, folder, signal);
    const seconds = Math.round((performance.now() - started) / 100) / 10;
    let reference: PlaybackCopyFacts | null = null;
    if (hardware && copy.facts) {
      const software = { ...config, accel: TranscodeHardwareAcceleration.Disabled, accelDecode: false };
      reference = (await this.convert(clip, input, stream, software, interfaces, folder, signal, 'reference')).facts;
      if (!reference) {
        throw new Error(`The reference clip ${clip.file} could not be converted on the processor`);
      }
    }

    const problems: PlaybackSelfTestProblem[] = copy.facts
      ? judgePlaybackCopy(clip, copy.facts, {
          targetVideoCodec: config.targetVideoCodec,
          toneMapped: config.tonemap !== ToneMapping.Disabled,
          lumaTolerance,
          referenceTolerance,
          reference,
        })
      : ['convert-failed'];
    if (problems.length > 0) {
      this.logger.warn(`Playback self-test: ${clip.id} came out wrong (${problems.join(', ')})`);
    }
    return {
      id: clip.id,
      passed: problems.length === 0,
      problems,
      hardware: copy.hardware,
      meanLuma: copy.facts?.meanLuma ?? null,
      referenceMeanLuma: reference?.meanLuma ?? null,
      codecName: copy.facts?.codecName ?? null,
      codecTag: copy.facts?.codecTag ?? null,
      colorPrimaries: copy.facts?.colorPrimaries ?? null,
      colorTransfer: copy.facts?.colorTransfer ?? null,
      seconds,
    };
  }

  /**
   * Converts one clip the way `MediaService.handleVideoConversion` makes a playback copy: the same source
   * qualification, the same narrowing of hardware decoding and the same command builder, and, as there,
   * once more with software decoding when hardware decoding fails. Facts are null when it fails.
   */
  private async convert(
    clip: PlaybackSelfTestManifestCase,
    input: string,
    videoStream: VideoStreamInfo,
    config: ConfigFFmpegDto,
    interfaces: Parameters<typeof BaseConfig.create>[1],
    folder: string,
    signal: AbortSignal,
    suffix = 'copy',
  ): Promise<{ facts: PlaybackCopyFacts | null; hardware: boolean }> {
    const qualification = qualifySourceDecode(videoStream, config, {
      baseLayerOnly: true,
      libplacebo: videoStream.dvProfile === DvProfile.Dvhe05 && (await this.mediaRepository.hasLibplacebo()),
    });
    if (qualification.support === DecodeSupport.Refused) {
      throw new Error(`The reference clip ${clip.file} is refused: ${qualification.reason}`);
    }
    let ffmpeg = selectDecodeAcceleration(config, qualification).config;
    const stream = qualification.reshapeDolbyVision ? { ...videoStream, dolbyVisionReshape: true } : videoStream;
    const output = join(folder, `${clip.id}-${suffix}.mp4`);
    const encode = () =>
      this.mediaRepository.transcode(
        input,
        output,
        BaseConfig.create(ffmpeg, interfaces).getCommand(TranscodeTarget.Video, stream),
        signal,
      );

    try {
      await encode();
    } catch (error) {
      signal.throwIfAborted();
      if (ffmpeg.accel === TranscodeHardwareAcceleration.Disabled || !ffmpeg.accelDecode) {
        this.logger.warn(`Playback self-test: ${clip.id} could not be converted: ${error}`);
        return { facts: null, hardware: ffmpeg.accel !== TranscodeHardwareAcceleration.Disabled };
      }
      ffmpeg = { ...ffmpeg, accelDecode: false };
      try {
        await encode();
      } catch (retryError) {
        signal.throwIfAborted();
        this.logger.warn(`Playback self-test: ${clip.id} could not be converted: ${retryError}`);
        return { facts: null, hardware: true };
      }
    }
    return {
      facts: await this.mediaRepository.inspectPlaybackCopy(output, signal),
      hardware: ffmpeg.accel !== TranscodeHardwareAcceleration.Disabled,
    };
  }

  /** Writes the kinds to convert on the processor into `ffmpeg.softwareFallback`, when they changed. */
  private async saveFallback(fallback: PlaybackSelfTestCase[]) {
    const { ffmpeg } = await this.getConfig({ withCache: false });
    if (isEqual([...(ffmpeg.softwareFallback ?? [])].sort(), [...fallback].sort())) {
      return;
    }
    try {
      const { oldConfig, newConfig } = await this.updateConfigExclusively((config) => {
        config.ffmpeg.softwareFallback = fallback;
      });
      await this.eventRepository.emit('ConfigUpdate', { oldConfig, newConfig });
    } catch (error) {
      // a configuration file is changed by the administrator only
      this.logger.warn(`The playback self-test could not save which videos use the processor: ${error}`);
    }
  }

  private async read(): Promise<PlaybackSelfTestState | null> {
    const state = await this.systemMetadataRepository.get(SystemMetadataKey.PlaybackSelfTest);
    if (state?.status === 'running' && !this.running && Date.now() - Date.parse(state.startedAt) > STALE_RUNNING_MS) {
      return { ...state, status: 'failed', error: 'The check was cut short' };
    }
    return state;
  }
}

/**
 * The kinds to convert on the processor after a check: none without a card; the kinds that came out
 * wrong after a finished check; and, when the check could not finish, also every HDR kind not shown
 * to come out right, so HDR videos keep converting on the processor until a check passes.
 */
const fallbackFor = (state: PlaybackSelfTestState, ffmpeg: ConfigFFmpegDto): PlaybackSelfTestCase[] => {
  if (ffmpeg.accel === TranscodeHardwareAcceleration.Disabled) {
    return [];
  }
  const failed = new Set(state.cases.filter((result) => !result.passed).map((result) => result.id));
  if (state.status === 'failed') {
    const passed = new Set(state.cases.filter((result) => result.passed).map((result) => result.id));
    for (const kind of HDR_PLAYBACK_CASES) {
      if (!passed.has(kind)) {
        failed.add(kind);
      }
    }
  }
  return readPlaybackSelfTestManifest()
    .cases.map((clip) => clip.id)
    .filter((id) => failed.has(id));
};

const toResponse = (state: PlaybackSelfTestState | null): PlaybackSelfTestResponseDto => ({
  status: state?.status ?? 'none',
  startedAt: state?.startedAt ?? null,
  finishedAt: state?.finishedAt ?? null,
  accel: state?.accel ?? null,
  cases: (state?.cases ?? []).map((result) => ({
    id: result.id,
    passed: result.passed,
    problems: result.problems,
    hardware: result.hardware,
    meanLuma: result.meanLuma,
    referenceMeanLuma: result.referenceMeanLuma,
    codecTag: result.codecTag,
    colorTransfer: result.colorTransfer,
  })),
  softwareFallback: state?.softwareFallback ?? [],
});
