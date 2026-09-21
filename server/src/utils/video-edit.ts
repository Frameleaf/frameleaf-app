import { ConfigFFmpegDto } from 'src/dtos/config.dto.js';
import { AssetEditAction, AssetEditActionItem } from 'src/dtos/editing.dto.js';
import {
  ColorMatrix,
  ColorPrimaries,
  ColorTransfer,
  ToneMapping,
  TranscodeHardwareAcceleration,
  VideoCodec,
} from 'src/enum.js';
import { TranscodeCommand, VideoInfo, VideoStreamInfo } from 'src/types.js';

/** Qualified container rotation only; all other recipes retain the baked-master policy. */
export const getVideoRotationCopyPlan = (
  edits: AssetEditActionItem[],
  original: VideoInfo,
): { command: TranscodeCommand; rotation: number } | undefined => {
  const edit = edits[0];
  const source = original.videoStreams[0];
  const audio = original.audioStreams[0];
  if (
    edits.length !== 1 ||
    edit.action !== AssetEditAction.Rotate ||
    ![90, 180, 270].includes(edit.parameters.angle) ||
    original.videoStreams.length !== 1 ||
    original.audioStreams.length > 1 ||
    !original.format.formatName?.split(',').some((name) => name === 'mov' || name === 'mp4') ||
    source.codecName !== 'h264' ||
    source.pixelFormat !== 'yuv420p' ||
    (source.dvProfile !== null && source.dvProfile !== undefined) ||
    ![ColorTransfer.Unknown, ColorTransfer.Bt709].includes(source.colorTransfer) ||
    ![ColorPrimaries.Unknown, ColorPrimaries.Bt709].includes(source.colorPrimaries) ||
    ![ColorMatrix.Unknown, ColorMatrix.Bt709].includes(source.colorMatrix) ||
    source.hasDisplayMatrix !== false ||
    source.rotation !== 0 ||
    (audio && audio.codecName !== 'aac')
  )
    return;

  // The editor rotates clockwise; FFmpeg display matrices describe counter-clockwise rotation.
  const rotation = ((source.rotation - edit.parameters.angle + 540) % 360) - 180;
  return {
    rotation,
    command: {
      inputOptions: ['-noautorotate', `-display_rotation:${source.index}`, String(rotation)],
      outputOptions: [
        '-map',
        `0:${source.index}`,
        ...(audio ? ['-map', `0:${audio.index}`] : []),
        '-c',
        'copy',
        '-map_metadata',
        '-1',
        '-movflags',
        '+faststart',
      ],
      twoPass: false,
      progress: { frameCount: source.frameCount, percentInterval: 5 },
    },
  };
};

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
  expectedRotation = 0,
) => {
  const quarterTurn = output && Math.abs(output.rotation) === 90;
  if (
    !output ||
    (quarterTurn ? output.height : output.width) !== dimensions.width ||
    (quarterTurn ? output.width : output.height) !== dimensions.height ||
    (output.rotation - expectedRotation) % 360 !== 0
  ) {
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
