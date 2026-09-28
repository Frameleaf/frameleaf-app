import { BadRequestException } from '@nestjs/common';
import { ColorMatrix, ColorPrimaries, ColorTransfer } from 'src/enum.js';
import { VideoInfo, VideoPacketInfo } from 'src/types.js';
import { Rational } from 'src/utils/rational-time.js';

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

export const checkStudioReverseSource = (info: VideoInfo, packets: VideoPacketInfo | null): StudioReverseSource => {
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
        audio.channels > 2 ||
        !audio.sampleRate ||
        audio.sampleRate > 48000))
  ) {
    throw new BadRequestException(
      'Local source reversal currently requires zero-origin, constant-rate BT.709 limited-range 8-bit video up to 720p, 10 seconds and 300 frames, with at most one aligned mono/stereo audio stream',
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
