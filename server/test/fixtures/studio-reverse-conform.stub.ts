import { ColorMatrix, ColorPrimaries, ColorTransfer, H264Profile } from 'src/enum.js';
import { VideoInfo, VideoPacketInfo } from 'src/types.js';

export const reverseVideoInfo = (): VideoInfo => ({
  format: { duration: 1, bitrate: 1000 },
  audioStreams: [],
  videoStreams: [
    {
      index: 0,
      width: 32,
      height: 32,
      codecName: 'ffv1',
      profile: null,
      level: null,
      frameCount: 3,
      frameRate: 3,
      frameRateRational: { num: 3, den: 1 },
      timeBase: 1000,
      startTime: 0,
      duration: 1,
      rotation: 0,
      bitrate: 1000,
      pixelFormat: 'yuv420p',
      colorPrimaries: ColorPrimaries.Bt709,
      colorMatrix: ColorMatrix.Bt709,
      colorTransfer: ColorTransfer.Bt709,
      colorRange: 'tv',
      dvProfile: null,
      dvLevel: null,
      dvBlSignalCompatibilityId: null,
    },
  ],
});
export const reversePackets = (): VideoPacketInfo => ({
  totalDuration: 1000,
  packetCount: 3,
  outputFrames: 3,
  keyframePts: [0],
  keyframeAccDuration: [1000],
  keyframeOwnDuration: [333],
  startPts: 0,
  variableFrameRate: false,
});

export const reverseClipGraph = (assetId = '0195e2a0-0000-7000-8000-000000000011') => ({
  metadata: { fps: 3, frameRate: { num: 3, den: 1 } },
  timeline: {
    items: [
      {
        id: 'clip-a',
        type: 'video',
        mediaId: assetId,
        trackId: 'video-1',
        from: 20,
        durationInFrames: 1,
        sourceStart: 0,
        sourceEnd: 1,
        sourceDuration: 3,
        sourceFps: 3,
        speed: 1,
        isReversed: true,
        effects: [{ id: 'grade-a', amount: 0.5 }],
        transform: { x: 12, scale: 0.75 },
      },
    ],
  },
  extensions: { preserve: ['unknown', null] },
});

export const reversePreviewInfo = (): VideoInfo => {
  const info = reverseVideoInfo();
  info.format.formatName = 'mov,mp4,m4a,3gp,3g2,mj2';
  Object.assign(info.videoStreams[0], {
    codecName: 'h264',
    profile: H264Profile.Main,
    level: 32,
    timeBase: 3,
    timeBaseRational: { num: 1, den: 3 },
  });
  return info;
};

export const reversePreviewPackets = () =>
  Array.from({ length: 3 }, (_, index) => ({ pts: index, dts: index, duration: 1 }));
