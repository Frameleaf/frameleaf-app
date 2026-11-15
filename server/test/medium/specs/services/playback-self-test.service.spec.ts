import { Kysely } from 'kysely';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SystemConfig } from 'src/dtos/config.dto.js';
import { SystemMetadataKey, ToneMapping, TranscodeHardwareAcceleration, VideoCodec } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { DB } from 'src/schema/index.js';
import { PlaybackSelfTestService } from 'src/services/playback-self-test.service.js';
import { PLAYBACK_SELF_TEST_CASES } from 'src/utils/playback-self-test.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

/**
 * FL-977 with the real ffmpeg and ffprobe of the medium runner (the server image's): each reference clip
 * goes through the same command builder a playback copy does, and the copy is read back for real.
 */
describe('FL-977 playback self-test with real ffmpeg', { concurrent: false }, () => {
  let db: Kysely<DB>;
  let previousConfig: SystemConfig;
  let setup: ReturnType<typeof newMediumService<typeof PlaybackSelfTestService>>;

  const useFfmpeg = async (ffmpeg: Partial<SystemConfig['ffmpeg']>) => {
    const config = structuredClone(previousConfig);
    Object.assign(config.ffmpeg, { threads: 1, softwareFallback: [] }, ffmpeg);
    await setup.sut.updateConfig(config);
  };

  beforeAll(async () => {
    console.info('FL-977 native tools', {
      ffmpeg: execFileSync('ffmpeg', ['-version']).toString().split('\n', 1)[0],
    });
    db = await getKyselyDB();
  });

  beforeEach(async () => {
    setup = newMediumService(PlaybackSelfTestService, {
      database: db,
      real: [ConfigRepository, DatabaseRepository, MediaRepository, StorageRepository, SystemMetadataRepository],
      mock: [EventRepository, LoggingRepository],
    });
    previousConfig = await setup.sut.getConfig({ withCache: false });
  });

  afterEach(async () => {
    if (previousConfig) {
      await setup.sut.updateConfig(previousConfig);
    }
    await setup.ctx.get(SystemMetadataRepository).delete(SystemMetadataKey.PlaybackSelfTest);
  });

  it('passes every kind of video converted on the processor, within its own time limit', async () => {
    await useFfmpeg({
      accel: TranscodeHardwareAcceleration.Disabled,
      tonemap: ToneMapping.Hable,
      targetVideoCodec: VideoCodec.H264,
    });

    const started = Date.now();
    const state = await setup.sut.run('manual');
    const measured = state.cases.map(({ id, passed, problems, meanLuma, codecTag, colorTransfer }) => ({
      id,
      passed,
      problems,
      meanLuma,
      codecTag,
      colorTransfer,
    }));
    console.info('FL-977 software self-test', JSON.stringify(measured));

    expect(Date.now() - started).toBeLessThan(60_000);
    expect(state.status, state.error ?? '').toBe('done');
    expect(measured.map((result) => result.id)).toEqual([...PLAYBACK_SELF_TEST_CASES]);
    expect(
      measured.filter((result) => !result.passed),
      JSON.stringify(measured),
    ).toEqual([]);
    expect(state.softwareFallback).toEqual([]);
  });

  it('passes HEVC copies tagged hvc1, the hev1 clip included', async () => {
    await useFfmpeg({
      accel: TranscodeHardwareAcceleration.Disabled,
      tonemap: ToneMapping.Hable,
      targetVideoCodec: VideoCodec.Hevc,
    });

    const state = await setup.sut.run('manual');

    expect(state.cases.map((result) => result.codecTag)).toEqual(['hvc1', 'hvc1', 'hvc1', 'hvc1', 'hvc1']);
    expect(
      state.cases.filter((result) => !result.passed),
      JSON.stringify(state.cases),
    ).toEqual([]);
  });

  it('puts every kind on the processor when the configured card is not there', async () => {
    // the medium runner has no NVIDIA card, so every conversion on it fails
    await useFfmpeg({ accel: TranscodeHardwareAcceleration.Nvenc, accelDecode: true });

    const state = await setup.sut.run('manual');

    expect(state.cases.map((result) => result.problems)).toEqual(
      PLAYBACK_SELF_TEST_CASES.map(() => ['convert-failed']),
    );
    expect(state.softwareFallback).toEqual([...PLAYBACK_SELF_TEST_CASES]);
    const { ffmpeg } = await setup.sut.getConfig({ withCache: false });
    expect(ffmpeg.softwareFallback).toEqual([...PLAYBACK_SELF_TEST_CASES]);
    await expect(setup.ctx.get(SystemMetadataRepository).get(SystemMetadataKey.PlaybackSelfTest)).resolves.toEqual(
      expect.objectContaining({ status: 'done', softwareFallback: [...PLAYBACK_SELF_TEST_CASES] }),
    );
  });
});
