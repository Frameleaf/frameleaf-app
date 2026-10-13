import { defaults } from 'src/dtos/config.dto.js';
import { TranscodeHardwareAcceleration, TranscodeTarget, VideoCodec } from 'src/enum.js';
import { BaseConfig } from 'src/utils/media.js';
import { probeStub } from 'test/fixtures/media.stub.js';

describe('software video commands', () => {
  const video = probeStub.videoStreamH264.videoStream;
  const interfaces = { dri: ['renderD128'], mali: true };

  it.each([
    [VideoCodec.H264, 'libx264'],
    [VideoCodec.Hevc, 'libx265'],
    [VideoCodec.Vp9, 'vp9'],
    [VideoCodec.Av1, 'libsvtav1'],
  ])('selects the software encoder for %s with hardware acceleration disabled', (targetVideoCodec, encoder) => {
    const config = BaseConfig.create(
      { ...defaults.ffmpeg, targetVideoCodec, accel: TranscodeHardwareAcceleration.Disabled },
      interfaces,
    );
    const options = config.getCommand(TranscodeTarget.All, video).outputOptions;
    expect(options[options.indexOf('-c:v') + 1]).toBe(encoder);
    const hls = config.getHlsCommand(
      {
        inputPath: '/input.mp4',
        target: TranscodeTarget.All,
        packetCount: 100,
        timeBase: 600,
        totalDuration: 1000,
        segmentDuration: 5,
        initFilename: 'init.mp4',
        segmentFilename: '/segment%d.mp4',
        startSegment: 0,
        playlistFilename: '/index.m3u8',
      },
      video,
    );
    expect(hls[hls.indexOf('-c:v') + 1]).toBe(encoder);
  });

  it.each([
    [TranscodeHardwareAcceleration.Nvenc, 'h264_nvenc'],
    [TranscodeHardwareAcceleration.Qsv, 'h264_qsv'],
    [TranscodeHardwareAcceleration.Vaapi, 'h264_vaapi'],
    [TranscodeHardwareAcceleration.Rkmpp, 'h264_rkmpp'],
  ])('keeps the selected %s hardware encoder', (accel, encoder) => {
    const config = BaseConfig.create({ ...defaults.ffmpeg, targetVideoCodec: VideoCodec.H264, accel }, interfaces);
    const options = config.getCommand(TranscodeTarget.All, video).outputOptions;
    expect(options[options.indexOf('-c:v') + 1]).toBe(encoder);
  });

  it('copies video when only audio needs transcoding', () => {
    const config = BaseConfig.create(defaults.ffmpeg, interfaces);
    expect(config.getCommand(TranscodeTarget.Audio, video).outputOptions.slice(0, 2)).toEqual(['-c:v', 'copy']);
  });
});
