import { ConfigFFmpegDto } from 'src/dtos/config.dto.js';
import { ColorTransfer, ToneMapping, TranscodeHardwareAcceleration, VideoCodec } from 'src/enum.js';
import { VideoStreamInfo } from 'src/types.js';

/** Edited masters have their own quality policy; playback settings only supply the thread budget. */
export const getVideoMasterConfig = (config: ConfigFFmpegDto, source: VideoStreamInfo): ConfigFFmpegDto => {
  if (source.dvProfile !== null && source.dvProfile !== undefined) {
    throw new Error('Baked Dolby Vision editing is not qualified');
  }
  if (!/^yuv(420|422|444)p(?:(10|12)le)?$/.test(source.pixelFormat)) {
    throw new Error(`Edited-master pixel format is not qualified: ${source.pixelFormat}`);
  }
  const highPrecision = /(?:10|12)le$/.test(source.pixelFormat);
  const hdr = [ColorTransfer.Smpte2084, ColorTransfer.AribStdB67].includes(source.colorTransfer);
  return {
    ...config,
    targetResolution: 'original',
    targetVideoCodec: highPrecision || hdr || source.codecName === 'hevc' ? VideoCodec.Hevc : VideoCodec.H264,
    crf: 18,
    preset: 'medium',
    maxBitrate: '0',
    twoPass: false,
    tonemap: ToneMapping.Disabled,
    accel: TranscodeHardwareAcceleration.Disabled,
    accelDecode: false,
  };
};

export const validateVideoMaster = (
  source: VideoStreamInfo,
  output: VideoStreamInfo | undefined,
  dimensions: { width: number; height: number },
) => {
  if (!output || output.width !== dimensions.width || output.height !== dimensions.height || output.rotation !== 0) {
    throw new Error('Edited-master display dimensions do not match the recipe');
  }
  if (output.pixelFormat !== source.pixelFormat) {
    throw new Error('Edited-master pixel format does not preserve source precision');
  }
  if (
    output.colorPrimaries !== source.colorPrimaries ||
    output.colorMatrix !== source.colorMatrix ||
    output.colorTransfer !== source.colorTransfer
  ) {
    throw new Error('Edited-master color intent does not match the source');
  }
};
