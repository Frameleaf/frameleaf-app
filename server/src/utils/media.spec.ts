import { defaults } from 'src/dtos/config.dto.js';
import { ColorTransfer, TranscodeHardwareAcceleration, TranscodeTarget, VideoCodec } from 'src/enum.js';
import { BaseConfig, ThumbnailConfig } from 'src/utils/media.js';
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

describe('Log video commands (FL-1285)', () => {
  const interfaces = { dri: ['renderD128'], mali: true };
  const lutPath = '/tmp/frameleaf-color-luts/frameleaf-log-v1-s-log3-s-gamut3-cine-tv-33.cube';
  const ordinary = { ...probeStub.videoStreamH264.videoStream!, height: 2160, width: 3840, pixelFormat: 'yuv420p10le' };
  const log = {
    ...ordinary,
    colorTransfer: ColorTransfer.Unknown,
    logConversion: {
      label: 'S-Log3 / S-Gamut3.Cine',
      lutPath,
      inputMatrix: 'bt709' as const,
      inputRange: 'tv' as const,
    },
  };
  const hdr = probeStub.videoStreamHDR.videoStream!;
  const filters = (options: string[]) => options[options.indexOf('-vf') + 1];
  const logChain = (range: 'tv' | 'pc', pixelFormat = 'yuv420p') =>
    `format=gbrp16le,lut3d=file=${lutPath}:interp=tetrahedral,scale=out_color_matrix=bt709:out_range=${range},` +
    `format=${pixelFormat},setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=${range}`;

  it('scales, applies the LUT and tags BT.709 for a Log clip', () => {
    const config = BaseConfig.create({ ...defaults.ffmpeg, targetResolution: '720' }, interfaces);
    expect(filters(config.getCommand(TranscodeTarget.Video, log).outputOptions)).toBe(
      `scale=-2:720:in_color_matrix=bt709:in_range=tv,${logChain('tv')}`,
    );
  });

  it('decodes with the matrix and range the LUT was made for', () => {
    const config = BaseConfig.create({ ...defaults.ffmpeg, targetResolution: 'original' }, interfaces);
    const apple = {
      ...log,
      logConversion: { ...log.logConversion, inputMatrix: 'bt2020' as const, inputRange: 'pc' as const },
    };
    expect(filters(config.getCommand(TranscodeTarget.Video, apple).outputOptions)).toBe(
      `scale=in_color_matrix=bt2020:in_range=pc,${logChain('tv')}`,
    );
  });

  it('keeps HDR on the tone-mapping path', () => {
    const config = BaseConfig.create(defaults.ffmpeg, interfaces);
    const vf = filters(config.getCommand(TranscodeTarget.Video, hdr).outputOptions);
    expect(vf).toContain('tonemapx=');
    expect(vf).not.toContain('lut3d');
  });

  it('never applies a Log LUT to a PQ or HLG stream', () => {
    const config = BaseConfig.create(defaults.ffmpeg, interfaces);
    const mislabelled = { ...hdr, logConversion: log.logConversion };
    const vf = filters(config.getCommand(TranscodeTarget.Video, mislabelled).outputOptions);
    expect(vf).toContain('tonemapx=');
    expect(vf).not.toContain('lut3d');
  });

  it('leaves an ordinary clip alone', () => {
    const config = BaseConfig.create({ ...defaults.ffmpeg, targetResolution: '720' }, interfaces);
    expect(filters(config.getCommand(TranscodeTarget.Video, ordinary).outputOptions)).toBe(
      'scale=-2:720,format=yuv420p',
    );
  });

  it('writes full-range stills for thumbnails', () => {
    const command = ThumbnailConfig.create({ ...defaults.ffmpeg, targetResolution: '720' }, 0).getCommand(
      TranscodeTarget.Video,
      log,
      undefined,
      probeStub.videoStreamH264.format,
    );
    expect(filters(command.outputOptions)).toContain(
      `,scale=-2:720:flags=lanczos+accurate_rnd+full_chroma_int:out_range=pc:in_color_matrix=bt709:in_range=tv,${logChain('pc')}`,
    );
  });

  it.each([
    [TranscodeHardwareAcceleration.Nvenc, 'hwupload_cuda,scale_cuda=-2:720:format=nv12'],
    [TranscodeHardwareAcceleration.Qsv, 'hwupload=extra_hw_frames=64,scale_qsv=-1:720:mode=hq:format=nv12'],
    [
      TranscodeHardwareAcceleration.Vaapi,
      'hwupload=extra_hw_frames=64,scale_vaapi=-2:720:mode=hq:out_range=pc:format=nv12',
    ],
  ])('converts on the CPU before uploading for %s encoding with software decoding', (accel, upload) => {
    const config = BaseConfig.create(
      { ...defaults.ffmpeg, accel, accelDecode: false, targetVideoCodec: VideoCodec.H264, targetResolution: '720' },
      interfaces,
    );
    expect(filters(config.getCommand(TranscodeTarget.Video, log).outputOptions)).toBe(
      `scale=in_color_matrix=bt709:in_range=tv,${logChain('tv', 'nv12')},${upload}`,
    );
  });

  it('converts on the CPU for RKMPP encoding with software decoding', () => {
    const config = BaseConfig.create(
      {
        ...defaults.ffmpeg,
        accel: TranscodeHardwareAcceleration.Rkmpp,
        accelDecode: false,
        targetVideoCodec: VideoCodec.H264,
        targetResolution: '720',
      },
      interfaces,
    );
    expect(filters(config.getCommand(TranscodeTarget.Video, log).outputOptions)).toBe(
      `scale=-2:720:in_color_matrix=bt709:in_range=tv,${logChain('tv')}`,
    );
  });

  it('refuses a LUT path that would need escaping in the filter graph', () => {
    const config = BaseConfig.create(defaults.ffmpeg, interfaces);
    const unsafe = { ...log, logConversion: { ...log.logConversion, lutPath: "/tmp/a:b,c'.cube" } };
    expect(() => config.getCommand(TranscodeTarget.Video, unsafe)).toThrow('Unsupported characters in LUT path');
  });
});
