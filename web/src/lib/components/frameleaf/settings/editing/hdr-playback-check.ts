import { PlaybackSelfTestCase, PlaybackSelfTestStatus, type PlaybackSelfTestResponseDto } from '@frameleaf/sdk';

/** The HDR kinds of video the playback self-test checks. */
export const HDR_CASES: ReadonlySet<PlaybackSelfTestCase> = new Set([
  PlaybackSelfTestCase.HlgHevc,
  PlaybackSelfTestCase.DolbyVision84,
  PlaybackSelfTestCase.Hdr10Pq,
]);

export type HdrCheckState = 'hardware' | 'software' | 'running' | 'failed' | 'none';

/** What the latest playback self-test says about HDR videos, as the prototype's `HdrCheck` states. */
export const hdrCheckState = (result: PlaybackSelfTestResponseDto | undefined): HdrCheckState => {
  switch (result?.status) {
    case PlaybackSelfTestStatus.Running: {
      return 'running';
    }
    case PlaybackSelfTestStatus.Failed: {
      return 'failed';
    }
    case PlaybackSelfTestStatus.Done: {
      return result.softwareFallback.some((kind) => HDR_CASES.has(kind)) ? 'software' : 'hardware';
    }
    default: {
      return 'none';
    }
  }
};
