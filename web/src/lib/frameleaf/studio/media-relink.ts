/** Relink source readers on a copy; content-addressed caches belonging to the old source stay intact. */
export interface RelinkSource {
  id: string;
  mimeType: string;
  duration: number;
  fps: number;
  width: number;
  height: number;
  audioCodec?: string;
}

export function relinkMediaGraph(graph: unknown, mediaId: string, source: RelinkSource): unknown {
  const next = structuredClone(graph) as { timeline?: Record<string, unknown> };
  if (!next?.timeline) {
    throw new Error('The project has no timeline to relink');
  }
  const owners = [next.timeline, ...((next.timeline.compositions as Record<string, unknown>[] | undefined) ?? [])];
  for (const owner of owners) {
    const fps = Number(owner.fps ?? (next as unknown as { metadata?: { fps?: number } }).metadata?.fps);
    for (const item of (owner.items as Record<string, unknown>[] | undefined) ?? []) {
      if (item.mediaId !== mediaId) {
        continue;
      }
      const type = item.type;
      const compatible =
        type === 'lottie'
          ? source.mimeType === 'application/lottie+json'
          : type === 'image'
            ? source.mimeType.startsWith('image/')
            : type === 'video'
              ? source.mimeType.startsWith('video/')
              : type === 'audio' &&
                (source.mimeType.startsWith('audio/') || (source.mimeType.startsWith('video/') && !!source.audioCodec));
      if (!compatible) {
        throw new Error('The replacement does not contain the media this clip needs');
      }
      if (
        type !== 'audio' &&
        (!Number.isFinite(source.width) || source.width <= 0 || !Number.isFinite(source.height) || source.height <= 0)
      ) {
        throw new Error('The replacement source dimensions could not be read');
      }
      if (type === 'lottie') {
        const rate = Number(item.frameRate);
        const frames = source.duration * source.fps;
        const start = Number(item.segmentStart ?? 0);
        const end = Number(item.segmentEnd ?? Number(item.totalFrames) - 1);
        if (!(source.fps > 0 && Number.isFinite(frames) && frames > 0) || rate !== source.fps) {
          throw new Error('Choose a replacement with the same animation frame rate to preserve the cuts');
        }
        if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || end >= frames) {
          throw new Error('The replacement is too short for an existing animation segment');
        }
        item.frameRate = source.fps;
        item.totalFrames = Math.round(frames);
      } else if (type === 'audio' || type === 'video') {
        const sourceFps = Number(item.sourceFps ?? (source.fps || fps));
        if (
          !Number.isFinite(source.duration) ||
          source.duration <= 0 ||
          !Number.isFinite(sourceFps) ||
          sourceFps <= 0
        ) {
          throw new Error('The replacement source duration could not be read');
        }
        if (source.fps > 0 && Math.abs(sourceFps - source.fps) > 1e-6) {
          throw new Error('Choose a replacement with the same source frame rate to preserve the cuts');
        }
        const start = Number(item.sourceStart ?? item.trimStart ?? item.offset ?? 0);
        const end = Number(
          item.sourceEnd ??
            item.sourceDuration ??
            start + ((Number(item.durationInFrames) * sourceFps) / fps) * Math.abs(Number(item.speed ?? 1)),
        );
        if (
          !Number.isFinite(start) ||
          !Number.isFinite(end) ||
          start < 0 ||
          end < start ||
          end > source.duration * sourceFps + 1e-6
        ) {
          throw new Error('The replacement is too short for an existing source range');
        }
        item.sourceDuration = Math.round(source.duration * sourceFps);
        item.sourceFps = sourceFps;
      }
      item.mediaId = source.id;
      item.sourceWidth = source.width;
      item.sourceHeight = source.height;
      for (const key of Object.keys(item)) {
        if (
          key.startsWith('reverseConform') ||
          ['src', 'audioSrc', 'thumbnailUrl', 'waveformData', 'transcriptCaptions'].includes(key)
        ) {
          delete item[key];
        }
      }
    }
  }
  return next;
}
