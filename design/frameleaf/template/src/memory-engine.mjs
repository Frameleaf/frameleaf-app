// One engine for the Memories player, Memories card previews and the
// viewer's Memories transition. Moves and the Reduce Motion rule come from media-viewer.mjs.
import { effectiveTransition, kenBurnsMove } from "./media-viewer.mjs";

export const MEMORY_PHOTO_MS = 5000;
export const MEMORY_TITLE_MS = 2600;
export const MEMORY_PREVIEW_MS = 9000;

export const memoryTransition = (reducedMotion = false) =>
  effectiveTransition("memories", reducedMotion);

export function memoryMotion(
  assetId,
  { reducedMotion = false, durationMs = MEMORY_PHOTO_MS + 1000 } = {},
) {
  if (assetId == null || memoryTransition(reducedMotion) !== "memories")
    return undefined;
  const { from, to } = kenBurnsMove(assetId);
  return {
    "--kb-from": from,
    "--kb-to": to,
    "--kb-duration": `${Math.max(0, durationMs) / 1000}s`,
  };
}

export const memoryPreviewMotion = (coverId, reducedMotion = false) =>
  memoryMotion(coverId, { reducedMotion, durationMs: MEMORY_PREVIEW_MS });

export function memorySlideClass({
  reducedMotion = false,
  video = false,
  paused = false,
} = {}) {
  const transition = memoryTransition(reducedMotion);
  return [
    transition === "memories" && !video ? "memories" : "fade",
    paused && "paused",
  ]
    .filter(Boolean)
    .join(" ");
}

export const memoryCountLabel = (count, word = "item") =>
  `${count} ${count === 1 ? word : `${word}s`}`;
const overlines = { event: "Trip", "best-of": "Highlights" };
export const memoryOverline = (memory) => overlines[memory?.kind] || "Memory";

export function memoryTitleCard(memory, count = memory?.count ?? 0) {
  return {
    overline: memoryOverline(memory),
    title: memory?.title || "Memories",
    subtitle: memory?.subtitle || "",
    count: memoryCountLabel(count),
  };
}

export function memoryLowerThird(
  item,
  { fallbackTitle = "", day = "", video = false } = {},
) {
  if (!item) return null;
  return {
    place: item.city || fallbackTitle || "",
    detail: [day, video && "Video, muted"].filter(Boolean).join(" · "),
  };
}
