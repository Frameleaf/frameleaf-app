import { defaults } from 'src/dtos/config.dto.js';
import { ColorTransfer, TranscodeHardwareAcceleration, VideoCodec } from 'src/enum.js';
import { getVideoMasterConfig, validateVideoMaster } from 'src/utils/video-edit.js';
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
