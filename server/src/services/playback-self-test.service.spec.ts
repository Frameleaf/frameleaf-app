import { cloneDeep } from 'lodash-es';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VideoInfo, VideoStreamInfo } from 'src/types.js';
import { serverVersion } from 'src/constants.js';
import { type SystemConfig, defaults } from 'src/dtos/config.dto.js';
import {
  ColorMatrix,
  ColorPrimaries,
  ColorTransfer,
  DvProfile,
  DvSignalCompatibility,
  SystemMetadataKey,
  ToneMapping,
  TranscodeHardwareAcceleration,
  VideoCodec,
} from 'src/enum.js';
import { PlaybackSelfTestService } from 'src/services/playback-self-test.service.js';
import {
  type PlaybackCopyFacts,
  type PlaybackSelfTestState,
  readPlaybackSelfTestManifest,
} from 'src/utils/playback-self-test.js';
import { videoInfoStub } from 'test/fixtures/media.stub.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const manifest = readPlaybackSelfTestManifest();
const clipOf = (path: string) => manifest.cases.find((clip) => path.endsWith(clip.file))!;
const caseOfOutput = (path: string) => manifest.cases.find((clip) => path.includes(`/${clip.id}-`))!;

/** What ffprobe reads from each reference clip, from the manifest. */
const probeOf = (path: string): VideoInfo => {
  const { source } = clipOf(path);
  const hdr = source.colorTransfer !== 'bt709';
  const stream: VideoStreamInfo = {
    ...videoInfoStub.videoStreamH264.videoStreams[0],
    height: 144,
    width: 256,
    codecName: source.codecName,
    pixelFormat: source.pixelFormat,
    colorPrimaries: hdr ? ColorPrimaries.Bt2020 : ColorPrimaries.Bt709,
    colorMatrix: hdr ? ColorMatrix.Bt2020Nc : ColorMatrix.Bt709,
    colorTransfer:
      source.colorTransfer === 'smpte2084'
        ? ColorTransfer.Smpte2084
        : source.colorTransfer === 'arib-std-b67'
          ? ColorTransfer.AribStdB67
          : ColorTransfer.Bt709,
    profile: null,
    dvProfile: (source.dvProfile as DvProfile | undefined) ?? null,
    dvBlSignalCompatibilityId: (source.dvBlSignalCompatibilityId as DvSignalCompatibility | undefined) ?? null,
    dvLevel: source.dvProfile ? 1 : null,
  };
  return { ...videoInfoStub.videoStreamH264, videoStreams: [stream], audioStreams: [] };
};

/** A copy that came out right: BT.709, the right tag, and as bright as it should be. */
const goodCopy = (path: string, codec = VideoCodec.H264): PlaybackCopyFacts => {
  const clip = caseOfOutput(path);
  return {
    codecName: codec === VideoCodec.Hevc ? 'hevc' : 'h264',
    codecTag: codec === VideoCodec.Hevc ? 'hvc1' : 'avc1',
    colorPrimaries: 'bt709',
    colorTransfer: 'bt709',
    meanLuma: clip.toneMappedLuma ? 120 : clip.sourceMeanLuma,
  };
};

describe(PlaybackSelfTestService.name, () => {
  let sut: PlaybackSelfTestService;
  let mocks: ServiceMocks;
  let config: SystemConfig;
  let stored: Partial<Record<SystemMetadataKey, unknown>>;

  const useConfig = (ffmpeg: Partial<SystemConfig['ffmpeg']>) => {
    config = cloneDeep(defaults) as SystemConfig;
    Object.assign(config.ffmpeg, ffmpeg);
  };

  beforeEach(() => {
    ({ sut, mocks } = newTestService(PlaybackSelfTestService));
    stored = {};
    useConfig({});
    mocks.systemMetadata.get.mockImplementation((key) =>
      Promise.resolve((key === SystemMetadataKey.SystemConfig ? config : (stored[key] ?? null)) as never),
    );
    mocks.systemMetadata.set.mockImplementation((key, value) => {
      stored[key] = cloneDeep(value);
      return Promise.resolve();
    });
    mocks.storage.mkdtemp.mockResolvedValue('/tmp/self-test');
    vi.spyOn(sut['storageCore'], 'getVideoInterfaces').mockResolvedValue({ dri: ['renderD128'], mali: false });
    mocks.media.probe.mockImplementation((path) => Promise.resolve(probeOf(path)));
    mocks.media.transcode.mockResolvedValue();
    mocks.media.inspectPlaybackCopy.mockImplementation((path) => Promise.resolve(goodCopy(path)));
    vi.spyOn(sut, 'updateConfigExclusively').mockImplementation((change) => {
      const oldConfig = cloneDeep(config);
      change(config);
      return Promise.resolve({ oldConfig, newConfig: cloneDeep(config) });
    });
  });

  it('says there has been no check yet', async () => {
    await expect(sut.getPlaybackSelfTest()).resolves.toEqual({
      status: 'none',
      startedAt: null,
      finishedAt: null,
      accel: null,
      cases: [],
      softwareFallback: [],
    });
  });

  it('passes every kind of video on the processor, without a second conversion to compare with', async () => {
    const state = await sut.run('manual');

    expect(state.status).toBe('done');
    expect(state.cases.map((result) => [result.id, result.passed, result.hardware])).toEqual([
      ['sdr-h264', true, false],
      ['hlg-hevc', true, false],
      ['dolby-vision-8.4', true, false],
      ['hdr10-pq', true, false],
      ['hev1-hevc', true, false],
    ]);
    expect(state.softwareFallback).toEqual([]);
    expect(mocks.media.transcode).toHaveBeenCalledTimes(5);
    // a self-test runs outside the job queue and stops its own conversions
    expect(mocks.media.transcode).toHaveBeenCalledWith(
      expect.stringContaining('sdr-h264.mp4'),
      '/tmp/self-test/sdr-h264-copy.mp4',
      expect.objectContaining({ twoPass: false }),
      expect.any(AbortSignal),
    );
    expect(sut.updateConfigExclusively).not.toHaveBeenCalled();
    expect(mocks.storage.unlinkDir).toHaveBeenCalledWith('/tmp/self-test', { recursive: true, force: true });
    expect(stored[SystemMetadataKey.PlaybackSelfTest]).toEqual(
      expect.objectContaining({ status: 'done', serverVersion: serverVersion.toString(), reason: 'manual' }),
    );
  });

  it('marks a kind the graphics card makes too dark and puts it on the processor', async () => {
    useConfig({ accel: TranscodeHardwareAcceleration.Nvenc, accelDecode: true });
    // the fixture override: NVENC's HDR10 copy comes out dark
    mocks.media.inspectPlaybackCopy.mockImplementation((path) =>
      Promise.resolve(path.endsWith('hdr10-pq-copy.mp4') ? { ...goodCopy(path), meanLuma: 31 } : goodCopy(path)),
    );

    const state = await sut.run('settings');

    const hdr10 = state.cases.find((result) => result.id === 'hdr10-pq')!;
    expect(hdr10).toEqual(
      expect.objectContaining({
        passed: false,
        hardware: true,
        problems: ['too-dark', 'brightness-differs'],
        meanLuma: 31,
        referenceMeanLuma: 120,
      }),
    );
    expect(state.cases.filter((result) => !result.passed)).toHaveLength(1);
    expect(state.softwareFallback).toEqual(['hdr10-pq']);
    expect(config.ffmpeg.softwareFallback).toEqual(['hdr10-pq']);
    expect(mocks.event.emit).toHaveBeenCalledWith('ConfigUpdate', {
      oldConfig: expect.objectContaining({ ffmpeg: expect.objectContaining({ softwareFallback: [] }) }),
      newConfig: expect.objectContaining({ ffmpeg: expect.objectContaining({ softwareFallback: ['hdr10-pq'] }) }),
    });
    // each kind once on the card and once on the processor
    expect(mocks.media.transcode).toHaveBeenCalledTimes(10);
    const commands = mocks.media.transcode.mock.calls.map(([, output, command]) => [output, command]);
    const [, onCard] = commands.find(([output]) => output === '/tmp/self-test/hdr10-pq-copy.mp4')!;
    const [, onProcessor] = commands.find(([output]) => output === '/tmp/self-test/hdr10-pq-reference.mp4')!;
    expect(JSON.stringify(onCard)).toContain('nvenc');
    expect(JSON.stringify(onProcessor)).not.toContain('nvenc');
  });

  it('marks a copy tagged hev1 when the copies are HEVC', async () => {
    useConfig({ accel: TranscodeHardwareAcceleration.Qsv, targetVideoCodec: VideoCodec.Hevc });
    mocks.media.inspectPlaybackCopy.mockImplementation((path) => {
      const copy = goodCopy(path, VideoCodec.Hevc);
      return Promise.resolve(path.endsWith('hev1-hevc-copy.mp4') ? { ...copy, codecTag: 'hev1' } : copy);
    });

    const state = await sut.run('manual');

    expect(state.cases.find((result) => result.id === 'hev1-hevc')).toEqual(
      expect.objectContaining({ passed: false, problems: ['codec-tag'] }),
    );
    expect(state.softwareFallback).toEqual(['hev1-hevc']);
  });

  it('expects HDR colours kept when tone mapping is off', async () => {
    useConfig({ accel: TranscodeHardwareAcceleration.Vaapi, tonemap: ToneMapping.Disabled });
    mocks.media.inspectPlaybackCopy.mockImplementation((path) => {
      const clip = caseOfOutput(path);
      return Promise.resolve({
        ...goodCopy(path),
        colorPrimaries: clip.source.colorPrimaries,
        colorTransfer: clip.source.colorTransfer,
        meanLuma: clip.sourceMeanLuma,
      });
    });

    const state = await sut.run('manual');

    expect(state.cases.every((result) => result.passed)).toBe(true);
  });

  it('retries with software decoding before failing a kind, as playback copies do', async () => {
    useConfig({ accel: TranscodeHardwareAcceleration.Nvenc, accelDecode: true });
    mocks.media.transcode.mockImplementation((_input, output) =>
      output === '/tmp/self-test/sdr-h264-copy.mp4' ? Promise.reject(new Error('cuda failed')) : Promise.resolve(),
    );

    const state = await sut.run('manual');

    const sdr = state.cases.find((result) => result.id === 'sdr-h264')!;
    expect(sdr).toEqual(expect.objectContaining({ passed: false, problems: ['convert-failed'], meanLuma: null }));
    const attempts = mocks.media.transcode.mock.calls.filter(
      ([, output]) => output === '/tmp/self-test/sdr-h264-copy.mp4',
    );
    expect(attempts).toHaveLength(2);
    expect(attempts[0][2].inputOptions.join(' ')).toContain('-hwaccel cuda');
    expect(attempts[1][2].inputOptions.join(' ')).not.toContain('-hwaccel cuda');
    expect(state.softwareFallback).toEqual(['sdr-h264']);
  });

  it('keeps HDR on the processor when the check cannot finish', async () => {
    useConfig({ accel: TranscodeHardwareAcceleration.Nvenc, softwareFallback: ['sdr-h264'] });
    mocks.media.inspectPlaybackCopy.mockImplementation((path) =>
      path.includes('dolby-vision-8.4')
        ? Promise.reject(new Error('ffprobe exited with code 1'))
        : Promise.resolve(goodCopy(path)),
    );

    const state = await sut.run('upgrade');

    expect(state.status).toBe('failed');
    expect(state.error).toContain('ffprobe');
    // SDR and HLG came out right before it stopped; Dolby Vision and HDR10 were never shown to
    expect(state.softwareFallback).toEqual(['dolby-vision-8.4', 'hdr10-pq']);
    await expect(sut.getPlaybackSelfTest()).resolves.toEqual(
      expect.objectContaining({ status: 'failed', softwareFallback: ['dolby-vision-8.4', 'hdr10-pq'] }),
    );
  });

  it('clears the list once the card is switched off', async () => {
    useConfig({ accel: TranscodeHardwareAcceleration.Disabled, softwareFallback: ['hdr10-pq'] });

    await sut.run('settings');

    expect(config.ffmpeg.softwareFallback).toEqual([]);
  });

  it('keeps the result when the configuration comes from a file', async () => {
    useConfig({ accel: TranscodeHardwareAcceleration.Nvenc });
    mocks.media.inspectPlaybackCopy.mockImplementation((path) =>
      Promise.resolve(path.endsWith('sdr-h264-copy.mp4') ? { ...goodCopy(path), colorTransfer: null } : goodCopy(path)),
    );
    vi.mocked(sut.updateConfigExclusively).mockRejectedValue(new Error('effective_config_file_managed'));

    const state = await sut.run('manual');

    expect(state.softwareFallback).toEqual(['sdr-h264']);
    expect(stored[SystemMetadataKey.PlaybackSelfTest]).toEqual(
      expect.objectContaining({ softwareFallback: ['sdr-h264'] }),
    );
  });

  describe('when it runs', () => {
    it('answers a request at once, with the check running', async () => {
      let finish!: () => void;
      mocks.media.transcode.mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));

      const response = await sut.startPlaybackSelfTest();

      expect(response.status).toBe('running');
      expect(response.cases).toEqual([]);
      await vi.waitFor(() => expect(mocks.media.transcode).toHaveBeenCalledTimes(1));
      // a second request joins the running check
      await expect(sut.startPlaybackSelfTest()).resolves.toEqual(expect.objectContaining({ status: 'running' }));
      expect(mocks.media.transcode).toHaveBeenCalledTimes(1);

      mocks.media.transcode.mockResolvedValue();
      finish();
      await sut.settled();
      await expect(sut.getPlaybackSelfTest()).resolves.toEqual(expect.objectContaining({ status: 'done' }));
    });

    it('runs after an upgrade', async () => {
      stored[SystemMetadataKey.PlaybackSelfTest] = { serverVersion: '0.0.1', status: 'done' } as PlaybackSelfTestState;

      await sut.onBootstrap();
      await sut.settled();

      expect(stored[SystemMetadataKey.PlaybackSelfTest]).toEqual(
        expect.objectContaining({ reason: 'upgrade', status: 'done', serverVersion: serverVersion.toString() }),
      );
    });

    it('does not run again on a start of the same version', async () => {
      stored[SystemMetadataKey.PlaybackSelfTest] = { serverVersion: serverVersion.toString(), status: 'done' };

      await sut.onBootstrap();
      await sut.settled();

      expect(mocks.media.transcode).not.toHaveBeenCalled();
    });

    it('does not run on a first start without a graphics card', async () => {
      await sut.onBootstrap();
      await sut.settled();

      expect(mocks.media.transcode).not.toHaveBeenCalled();
    });

    it('runs on a first start with a graphics card', async () => {
      useConfig({ accel: TranscodeHardwareAcceleration.Qsv });

      await sut.onBootstrap();
      await sut.settled();

      expect(mocks.media.transcode).toHaveBeenCalled();
    });

    it('runs when the hardware acceleration settings change, not for other settings', async () => {
      const before = cloneDeep(defaults) as SystemConfig;

      await sut.onConfigUpdate({ oldConfig: before, newConfig: { ...before, ffmpeg: { ...before.ffmpeg, crf: 30 } } });
      await sut.settled();
      expect(mocks.media.transcode).not.toHaveBeenCalled();

      // its own change of the list is not a reason to run again
      await sut.onConfigUpdate({
        oldConfig: before,
        newConfig: { ...before, ffmpeg: { ...before.ffmpeg, softwareFallback: ['hdr10-pq'] } },
      });
      await sut.settled();
      expect(mocks.media.transcode).not.toHaveBeenCalled();

      await sut.onConfigUpdate({
        oldConfig: before,
        newConfig: { ...before, ffmpeg: { ...before.ffmpeg, accel: TranscodeHardwareAcceleration.Nvenc } },
      });
      await sut.settled();
      expect(mocks.media.transcode).toHaveBeenCalled();
      expect(stored[SystemMetadataKey.PlaybackSelfTest]).toEqual(expect.objectContaining({ reason: 'settings' }));
    });

    it('says a check cut short by a restart failed', async () => {
      stored[SystemMetadataKey.PlaybackSelfTest] = {
        status: 'running',
        startedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      } as PlaybackSelfTestState;

      await expect(sut.getPlaybackSelfTest()).resolves.toEqual(expect.objectContaining({ status: 'failed' }));
    });
  });
});
