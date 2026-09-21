import { defaults } from 'src/dtos/config.dto.js';
import { AssetEditAction } from 'src/dtos/editing.dto.js';
import { ColorTransfer, TranscodeHardwareAcceleration, VideoCodec } from 'src/enum.js';
import { getVideoMasterConfig, getVideoRotationCopyPlan, validateVideoMaster } from 'src/utils/video-edit.js';
import { probeStub } from 'test/fixtures/media.stub.js';

const source = probeStub.videoStreamH264.videoStream;

describe('edited-master policy', () => {
  it('preserves high-precision HDR intent without playback limits', () => {
    const hdr = {
      ...source,
      width: 3840,
      height: 2160,
      pixelFormat: 'yuv420p10le',
      colorTransfer: ColorTransfer.Smpte2084,
    };
    const config = getVideoMasterConfig(
      { ...defaults.ffmpeg, crf: 50, maxBitrate: '10k', targetResolution: '480', targetVideoCodec: VideoCodec.H264 },
      hdr,
    );
    expect(config).toMatchObject({
      crf: 18,
      maxBitrate: '0',
      targetResolution: 'original',
      targetVideoCodec: VideoCodec.Hevc,
      accel: TranscodeHardwareAcceleration.Disabled,
    });
    expect(() => validateVideoMaster(hdr, hdr, { width: 3840, height: 2160 })).not.toThrow();
    expect(() => validateVideoMaster(hdr, { ...hdr, pixelFormat: 'yuv420p' }, hdr)).toThrow('precision');
    expect(() => validateVideoMaster(hdr, { ...hdr, colorTransfer: ColorTransfer.Bt709 }, hdr)).toThrow('color intent');
  });
  it('rejects unqualified Dolby and pixel formats', () => {
    expect(() => getVideoMasterConfig(defaults.ffmpeg, { ...source, dvProfile: 8 })).toThrow('Dolby');
    expect(() => getVideoMasterConfig(defaults.ffmpeg, { ...source, pixelFormat: 'gbrpf32le' })).toThrow(
      'pixel format',
    );
  });
});

describe('metadata rotation admission', () => {
  const original = {
    videoStreams: [{ ...source, rotation: 0, hasDisplayMatrix: false }],
    audioStreams: [],
    format: { ...probeStub.videoStreamH264.format, formatName: 'mov,mp4,m4a,3gp,3g2,mj2' },
  };
  const edits = [{ action: AssetEditAction.Rotate, parameters: { angle: 90 } }] as const;

  it.each([
    [90, -90],
    [180, -180],
    [270, 90],
  ])('copies packets for clockwise %i degrees', (angle, rotation) => {
    const plan = getVideoRotationCopyPlan([{ action: AssetEditAction.Rotate, parameters: { angle } }], original);
    expect(plan?.rotation).toBe(rotation);
    expect(plan?.command).toMatchObject({
      inputOptions: ['-noautorotate', `-display_rotation:${source.index}`, String(rotation)],
      outputOptions: expect.arrayContaining(['-c', 'copy']),
      twoPass: false,
    });
  });

  it.each([
    { codecName: 'hevc' },
    { pixelFormat: 'yuv420p10le' },
    { dvProfile: 8 },
    { colorTransfer: ColorTransfer.Smpte2084 },
    { colorTransfer: ColorTransfer.AribStdB67 },
    { rotation: 90 },
    { hasDisplayMatrix: true },
    { hasDisplayMatrix: undefined },
  ])('retains the existing baked/fail-closed policy for %j', (changes) => {
    expect(
      getVideoRotationCopyPlan([...edits], {
        ...original,
        videoStreams: [{ ...original.videoStreams[0], ...changes }],
      }),
    ).toBeUndefined();
  });

  it('does not copy mixed recipes, incompatible audio, multiple tracks or unknown containers', () => {
    expect(
      getVideoRotationCopyPlan(
        [...edits, { action: AssetEditAction.Crop, parameters: { x: 0, y: 0, width: 100, height: 100 } }],
        original,
      ),
    ).toBeUndefined();
    expect(
      getVideoRotationCopyPlan([...edits], { ...original, format: { ...original.format, formatName: 'matroska' } }),
    ).toBeUndefined();
    const audio = { index: 1, codecName: 'aac', profile: null, bitrate: 128_000 };
    expect(
      getVideoRotationCopyPlan([...edits], { ...original, audioStreams: [{ ...audio, codecName: 'opus' }] }),
    ).toBeUndefined();
    expect(getVideoRotationCopyPlan([...edits], { ...original, audioStreams: [audio, audio] })).toBeUndefined();
    expect(
      getVideoRotationCopyPlan([...edits], {
        ...original,
        videoStreams: [...original.videoStreams, ...original.videoStreams],
      }),
    ).toBeUndefined();
    expect(getVideoRotationCopyPlan([...edits], { ...original, audioStreams: [audio] })?.command.outputOptions).toEqual(
      expect.arrayContaining(['-map', '0:1']),
    );
  });

  it('validates orientation, display raster and color without relaxing baked validation', () => {
    const rotated = { ...source, width: 3840, height: 2160, rotation: -90 };
    const dimensions = { width: 2160, height: 3840 };
    expect(() => validateVideoMaster(source, rotated, dimensions, -90)).not.toThrow();
    expect(() => validateVideoMaster(source, { ...rotated, rotation: 90 }, dimensions, -90)).toThrow('dimensions');
    expect(() => validateVideoMaster(source, rotated, dimensions)).toThrow('dimensions');
    expect(() => validateVideoMaster(source, { ...rotated, width: 1920 }, dimensions, -90)).toThrow('dimensions');
  });
});
