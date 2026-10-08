/*
MIT License

Copyright (c) 2025 FreeCut

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

*/
// Canonical subtitle/track primitives extracted without changing legacy expressions.
// Strict validation is confined to prepareSidecarPlan, before projection/filtering.
export function resolveEffectiveTrackStates(tracks) {
  const groupsById = new Map(
    tracks.filter((track) => track.isGroup).map((track) => [track.id, track]),
  );

  return tracks
    .filter((track) => !track.isGroup)
    .map((track) => {
      const parentGroup = track.parentTrackId
        ? groupsById.get(track.parentTrackId)
        : undefined;
      if (!parentGroup) {
        return track;
      }

      return {
        ...track,
        locked: track.locked || parentGroup.locked,
        muted: track.muted || parentGroup.muted,
        visible: track.visible !== false && parentGroup.visible !== false,
        solo: track.solo || parentGroup.solo,
      };
    });
}

export function isTranscriptSubtitleItem(item) {
  return (
    (item.type === "subtitle" &&
      (item.source.type === "transcript" ||
        item.source.type === "subtitle-import" ||
        item.source.type === "embedded-subtitles")) ||
    (item.type === "text" &&
      item.textRole === "caption" &&
      (item.captionSource?.type === "subtitle-import" ||
        item.captionSource?.type === "embedded-subtitles"))
  );
}

export function buildTranscriptSubtitleCues(composition) {
  const fps = composition.fps;
  const durationSeconds =
    composition.durationInFrames !== undefined
      ? composition.durationInFrames / fps
      : Infinity;

  const cues = [];

  for (const track of composition.tracks) {
    if (track.visible === false) continue;

    for (const item of track.items ?? []) {
      if (!isTranscriptSubtitleItem(item)) continue;

      const itemStartSeconds = item.from / fps;
      const itemEndSeconds = (item.from + item.durationInFrames) / fps;

      const itemCues =
        item.type === "text"
          ? [
              {
                id: item.id,
                startSeconds: 0,
                endSeconds: item.durationInFrames / fps,
                text: item.text,
              },
            ]
          : item.cues;
      for (const cue of itemCues) {
        const startSeconds = Math.max(0, itemStartSeconds + cue.startSeconds);
        const endSeconds = Math.min(
          durationSeconds,
          itemEndSeconds,
          itemStartSeconds + cue.endSeconds,
        );

        if (endSeconds <= startSeconds || cue.text.trim().length === 0)
          continue;

        cues.push({
          id: cue.id,
          startSeconds,
          endSeconds,
          text: cue.text,
        });
      }
    }
  }

  // Items can be processed track-by-track in any order, but subtitle consumers
  // expect cues sorted chronologically. Sort by start time, breaking ties by
  // end time so deterministically-overlapping cues don't reorder.
  cues.sort(
    (a, b) => a.startSeconds - b.startSeconds || a.endSeconds - b.endSeconds,
  );
  return cues;
}

export function serializeSrt(cues) {
  return normalizeCuesForExport(cues)
    .map((cue, index) =>
      [
        String(index + 1),
        `${formatSrtTimestamp(cue.startSeconds)} --> ${formatSrtTimestamp(cue.endSeconds)}`,
        cue.text,
      ].join("\n"),
    )
    .join("\n\n");
}

export function serializeVtt(cues) {
  const body = normalizeCuesForExport(cues)
    .map(
      (cue) =>
        `${formatVttTimestamp(cue.startSeconds)} --> ${formatVttTimestamp(cue.endSeconds)}\n${cue.text}`,
    )
    .join("\n\n");
  return `WEBVTT\n\n${body}`;
}

function formatSrtTimestamp(seconds) {
  return formatTimestamp(seconds, ",");
}

function formatVttTimestamp(seconds) {
  return formatTimestamp(seconds, ".");
}

function formatTimestamp(seconds, separator) {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const s = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const m = totalMinutes % 60;
  const h = Math.floor(totalMinutes / 60);
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}${separator}${String(ms).padStart(3, "0")}`;
}

function normalizeCuesForExport(cues) {
  return cues
    .filter(
      (cue) => cue.text.trim().length > 0 && cue.endSeconds > cue.startSeconds,
    )
    .map((cue) => ({ ...cue, text: cue.text.trim() }))
    .sort((a, b) => a.startSeconds - b.startSeconds);
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

export function trimSubtitleCues(
  cues,
  trimStartSeconds,
  trimmedDurationSeconds,
) {
  return cues
    .map((cue) => ({
      ...cue,
      startSeconds: Math.max(0, cue.startSeconds - trimStartSeconds),
      endSeconds: Math.min(
        trimmedDurationSeconds,
        cue.endSeconds - trimStartSeconds,
      ),
    }))
    .filter(
      (cue) => cue.text.trim().length > 0 && cue.endSeconds > cue.startSeconds,
    );
}
export class SidecarRefusal extends Error {
  constructor(message) {
    super(message);
    this.name = "SidecarRefusal";
  }
}
const refuse = (message) => {
  throw new SidecarRefusal(message);
};
const integer = (n) => Number.isSafeInteger(n);
function cadenceOf(fps, exact) {
  if (!Number.isFinite(fps) || fps <= 0)
    refuse("Sidecar cadence is not supported");
  if (exact !== undefined) {
    if (
      !integer(exact?.num) ||
      !integer(exact?.den) ||
      exact.num <= 0 ||
      exact.den <= 0 ||
      Math.abs(exact.num / exact.den - fps) >= 1e-9
    )
      refuse("Sidecar cadence is not supported");
    return { ...exact };
  }
  if (integer(fps)) return { num: fps, den: 1 };
  for (const num of [24000, 30000, 48000, 60000, 120000])
    if (
      Math.abs(fps - num / 1001) < 1e-9 ||
      fps === Math.round((num / 1001) * 1000) / 1000
    )
      return { num, den: 1001 };
  refuse("Sidecar cadence is not supported");
}
/** Strict Sidecar boundary. Legacy consumers above deliberately retain their behavior. */
export function prepareSidecarPlan({
  tracks,
  items,
  fps,
  frameRate,
  inPoint = null,
  outPoint = null,
}) {
  const cadence = cadenceOf(fps, frameRate);
  // The legacy cadence contract recognizes rounded spellings. Sidecar projection
  // must use the same exact float it seals; refuse unresolved rounded state.
  if (fps !== cadence.num / cadence.den)
    refuse("Sidecar cadence requires an exact resolved frame rate");
  if (!Array.isArray(tracks) || !Array.isArray(items))
    refuse("Sidecar timeline is malformed");
  const hasRange =
    inPoint !== null &&
    inPoint !== undefined &&
    outPoint !== null &&
    outPoint !== undefined;
  if (
    (inPoint == null) !== (outPoint == null) ||
    (hasRange &&
      (!integer(inPoint) ||
        !integer(outPoint) ||
        inPoint < 0 ||
        outPoint <= inPoint))
  )
    refuse("Sidecar range is malformed");
  const origin = hasRange ? inPoint : 0;
  for (const item of items) {
    if (
      !item ||
      !integer(item.from) ||
      !integer(item.durationInFrames) ||
      item.durationInFrames <= 0 ||
      !integer(item.from + item.durationInFrames)
    )
      refuse("Sidecar authored item timing is malformed");
    if (item.type === "subtitle") {
      if (
        !item.source ||
        !isTranscriptSubtitleItem(item) ||
        !Array.isArray(item.cues)
      )
        refuse("Sidecar caption source is unsupported");
      for (const cue of item.cues)
        if (
          !cue ||
          !Number.isFinite(cue.startSeconds) ||
          !Number.isFinite(cue.endSeconds) ||
          cue.endSeconds <= cue.startSeconds ||
          typeof cue.text !== "string" ||
          !Number.isSafeInteger(Math.round(cue.startSeconds * 1000)) ||
          !Number.isSafeInteger(Math.round(cue.endSeconds * 1000))
        )
          refuse("Sidecar authored cue is malformed or unsafe");
    } else if (item.type === "text" && item.textRole === "caption") {
      if (!isTranscriptSubtitleItem(item) || typeof item.text !== "string")
        refuse("Sidecar caption source is unsupported");
    }
  }
  // Malformed authored data is checked before legitimate out-of-range/touching exclusion.
  const eligible = items.filter(
    (item) =>
      !hasRange ||
      (item.from + item.durationInFrames > inPoint && item.from < outPoint),
  );
  for (const item of eligible)
    if (
      item.type === "composition" ||
      item.transcriptCaptions?.enabled ||
      item.isReversed === true
    )
      refuse(
        "Sidecar compound, reverse or virtual caption state is unsupported",
      );
  if (tracks.some((t) => t.id === "__virtual-transcript-captions__"))
    refuse("Sidecar virtual caption state is unsupported");
  const durationInFrames = hasRange
    ? outPoint - inPoint
    : Math.max(
        items.length > 0
          ? Math.max(...items.map((i) => i.from + i.durationInFrames))
          : fps * 10,
        fps,
      );
  if (!integer(durationInFrames) || !integer(origin + durationInFrames))
    refuse("Sidecar output extent is not representable as whole frames");
  const projected = eligible.map((item) => {
    if (!hasRange) return item;
    const trimStart = Math.max(0, inPoint - item.from),
      trimEnd = Math.max(0, item.from + item.durationInFrames - outPoint);
    const durationInFrames = item.durationInFrames - trimStart - trimEnd;
    const next = {
      ...item,
      from: Math.max(0, item.from - inPoint),
      durationInFrames,
    };
    if (item.type === "subtitle" && (trimStart > 0 || trimEnd > 0))
      next.cues = trimSubtitleCues(
        item.cues,
        trimStart / fps,
        durationInFrames / fps,
      );
    return next;
  });
  const lanes = resolveEffectiveTrackStates(tracks)
    .map((track) => ({
      ...track,
      items: projected.filter((item) => item.trackId === track.id),
    }))
    .sort((a, b) => b.order - a.order);
  const cues = buildTranscriptSubtitleCues({
    tracks: lanes,
    fps,
    durationInFrames,
  });
  for (const cue of cues)
    if (
      !Number.isSafeInteger(Math.round(cue.startSeconds * 1000)) ||
      !Number.isSafeInteger(Math.round(cue.endSeconds * 1000)) ||
      Math.round(cue.endSeconds * 1000) <= Math.round(cue.startSeconds * 1000)
    )
      refuse("Sidecar cue duration is not representable in SRT milliseconds");
  const content = serializeSrt(cues);
  return {
    version: 1,
    required: true,
    cadence,
    inPoint: origin,
    outPoint: origin + durationInFrames,
    cueCount: cues.length,
    zeroCue: cues.length === 0,
    content,
    byteLength: new TextEncoder().encode(content).byteLength,
    cues,
  };
}
