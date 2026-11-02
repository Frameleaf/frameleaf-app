import type { AssetFilmstripResponseDto } from '@frameleaf/sdk';

/**
 * FL-650: the seek bar's preview thumbnails. The server's filmstrip (made ahead of time by the
 * AssetWarmFilmstrip job, server/src/utils/studio-media.ts PLAYER_FILMSTRIP) is turned into the
 * WebVTT thumbnails track media-chrome reads: one cue per equal slice of the video, naming its tile.
 */
export const PLAYER_FILMSTRIP = { count: 120, height: 180 } as const;

const pad = (value: number, size = 2) => String(value).padStart(size, '0');

const vttTime = (ms: number) => {
  const total = Math.max(0, Math.round(ms));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(total % 1000, 3)}`;
};

/** `spriteUrl` must be absolute: the track is a blob URL, which relative cue URLs can't resolve against. */
export const filmstripToVtt = (filmstrip: AssetFilmstripResponseDto, spriteUrl: string) => {
  const { durationMs, frames, frameWidth, frameHeight } = filmstrip;
  const slice = frames.length > 0 ? durationMs / frames.length : 0;
  const lines = ['WEBVTT', ''];
  for (const [position, frame] of frames.entries()) {
    lines.push(
      `${vttTime(position * slice)} --> ${vttTime((position + 1) * slice)}`,
      `${spriteUrl}#xywh=${frame.x},${frame.y},${frameWidth},${frameHeight}`,
      '',
    );
  }
  return lines.join('\n');
};
