import { BadRequestException } from '@nestjs/common';
import { AacProfile, ColorMatrix, ColorPrimaries, ColorTransfer, H264Profile } from 'src/enum.js';
import { VideoInfo, VideoPacketInfo } from 'src/types.js';
import { Rational } from 'src/utils/rational-time.js';

export type StudioReverseGeometry = { width: number; height: number; sampleAspectRatio: string | undefined };

/** An intentionally bounded first local producer. No timeline offsets, speeds or effects are baked in. */
export type StudioReverseSource = {
  width: number;
  height: number;
  frames: number;
  frameRate: Rational;
  duration: number;
  videoIndex: number;
  audioIndex: number | null;
  channels: number | null;
  sampleRate: number | null;
};

export const checkStudioReverseSource = (
  info: VideoInfo,
  packets: VideoPacketInfo | null,
  geometry: StudioReverseGeometry,
): StudioReverseSource => {
  const video = info.videoStreams[0];
  const audio = info.audioStreams[0];
  const rate = video?.frameRateRational;
  const fps = rate ? rate.num / rate.den : 0;
  const duration = info.format.duration;
  if (
    info.videoStreams.length !== 1 ||
    info.audioStreams.length > 1 ||
    !video ||
    !rate ||
    !Number.isSafeInteger(rate.num) ||
    !Number.isSafeInteger(rate.den) ||
    rate.num <= 0 ||
    rate.num > 60_000 ||
    rate.den <= 0 ||
    rate.den > 60_000 ||
    !Number.isFinite(fps) ||
    fps <= 0 ||
    fps > 60 ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    duration > 10 ||
    !Number.isSafeInteger(video.width) ||
    !Number.isSafeInteger(video.height) ||
    video.width < 2 ||
    video.height < 2 ||
    video.width > 1280 ||
    video.height > 720 ||
    video.width % 2 !== 0 ||
    video.height % 2 !== 0 ||
    !Number.isSafeInteger(geometry.width) ||
    !Number.isSafeInteger(geometry.height) ||
    geometry.width < 2 ||
    geometry.height < 2 ||
    geometry.width > 1280 ||
    geometry.height > 720 ||
    geometry.width !== video.width ||
    geometry.height !== video.height ||
    geometry.sampleAspectRatio !== '1:1' ||
    video.rotation !== 0 ||
    video.startTime !== 0 ||
    video.pixelFormat !== 'yuv420p' ||
    video.colorPrimaries !== ColorPrimaries.Bt709 ||
    video.colorTransfer !== ColorTransfer.Bt709 ||
    video.colorMatrix !== ColorMatrix.Bt709 ||
    video.colorRange !== 'tv' ||
    video.dvProfile !== null ||
    !packets ||
    packets.variableFrameRate !== false ||
    packets.startPts !== 0 ||
    !Number.isSafeInteger(packets.packetCount) ||
    packets.packetCount <= 0 ||
    packets.packetCount > 300 ||
    packets.outputFrames !== packets.packetCount ||
    Math.abs(packets.packetCount / fps - duration) > 0.002 ||
    (audio &&
      (audio.startTime !== 0 ||
        !audio.duration ||
        Math.abs(audio.duration - duration) > 0.002 ||
        !audio.channels ||
        ![1, 2].includes(audio.channels) ||
        !audio.sampleRate ||
        ![8000, 11_025, 12_000, 16_000, 22_050, 24_000, 32_000, 44_100, 48_000].includes(audio.sampleRate)))
  ) {
    throw new BadRequestException(
      'Local source reversal currently requires zero-origin, square-pixel, constant-rate BT.709 limited-range 8-bit video up to 720p, 10 seconds and 300 frames, with at most one aligned mono/stereo audio stream',
    );
  }
  return {
    width: video.width,
    height: video.height,
    frames: packets.packetCount,
    frameRate: rate,
    duration,
    videoIndex: video.index,
    audioIndex: audio?.index ?? null,
    channels: audio?.channels ?? null,
    sampleRate: audio?.sampleRate ?? null,
  };
};

/** Checked independently of the worker's progress report. A partial or differently shaped output cannot publish. */
export const checkStudioReverseOutput = (source: StudioReverseSource, output: VideoInfo): void => {
  const video = output.videoStreams[0];
  const audio = output.audioStreams[0];
  const fps = source.frameRate.num / source.frameRate.den;
  if (
    output.videoStreams.length !== 1 ||
    output.audioStreams.length !== (source.audioIndex === null ? 0 : 1) ||
    !video ||
    video.codecName !== 'ffv1' ||
    video.width !== source.width ||
    video.height !== source.height ||
    video.frameCount !== source.frames ||
    video.startTime !== 0 ||
    video.pixelFormat !== 'yuv420p' ||
    video.colorPrimaries !== ColorPrimaries.Bt709 ||
    video.colorTransfer !== ColorTransfer.Bt709 ||
    video.colorMatrix !== ColorMatrix.Bt709 ||
    video.colorRange !== 'tv' ||
    !Number.isFinite(output.format.duration) ||
    Math.abs(output.format.duration - source.duration) > 0.002 ||
    !video.frameRate ||
    Math.abs(video.frameRate - fps) > 0.001 ||
    (audio &&
      (audio.codecName !== 'pcm_f32le' ||
        audio.channels !== source.channels ||
        audio.sampleRate !== source.sampleRate ||
        audio.startTime !== 0 ||
        !audio.duration ||
        Math.abs(audio.duration - source.duration) > 0.002))
  ) {
    throw new BadRequestException('The reversed output does not match the checked source contract');
  }
};

/** MP4's edit list removes AAC encoder priming; no resampling, offset or frame dropping is admitted. */
export const checkStudioReversePreview = (
  source: StudioReverseSource,
  output: VideoInfo,
  geometry: StudioReverseGeometry,
  packets: unknown,
): void => {
  const video = output.videoStreams[0];
  const audio = output.audioStreams[0];
  const { num, den } = source.frameRate;
  const duration = (source.frames * den) / num;
  if (
    !output.format.formatName?.split(',').includes('mp4') ||
    output.videoStreams.length !== 1 ||
    output.audioStreams.length !== (source.audioIndex === null ? 0 : 1) ||
    !video ||
    video.codecName !== 'h264' ||
    video.profile !== H264Profile.Main ||
    video.level !== 32 ||
    video.width !== source.width ||
    video.height !== source.height ||
    geometry.width !== source.width ||
    geometry.height !== source.height ||
    geometry.sampleAspectRatio !== '1:1' ||
    video.frameCount !== source.frames ||
    video.startTime !== 0 ||
    video.rotation !== 0 ||
    video.timeBaseRational?.num !== 1 ||
    video.timeBaseRational.den !== num ||
    !video.frameRateRational ||
    video.frameRateRational.num * den !== num * video.frameRateRational.den ||
    video.pixelFormat !== 'yuv420p' ||
    video.colorPrimaries !== ColorPrimaries.Bt709 ||
    video.colorTransfer !== ColorTransfer.Bt709 ||
    video.colorMatrix !== ColorMatrix.Bt709 ||
    video.colorRange !== 'tv' ||
    !Number.isFinite(output.format.duration) ||
    Math.abs(output.format.duration - duration) > 0.002 ||
    !Number.isFinite(video.duration) ||
    Math.abs(video.duration! - duration) > 1e-6 ||
    !Array.isArray(packets) ||
    packets.length !== source.frames ||
    packets.some(
      (packet, index) => packet?.pts !== index * den || packet.dts !== index * den || packet.duration !== den,
    ) ||
    (audio &&
      (audio.codecName !== 'aac' ||
        audio.profile !== AacProfile.Lc ||
        audio.channels !== source.channels ||
        audio.sampleRate !== source.sampleRate ||
        audio.startTime !== 0 ||
        !audio.duration ||
        !Number.isFinite(audio.duration) ||
        Math.abs(audio.duration - duration) > 0.002))
  ) {
    throw new BadRequestException('The reverse preview does not match the checked browser media contract');
  }
};
