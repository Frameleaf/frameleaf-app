/**
 * One engine for the Memories player, the Memories card previews and the viewer's Memories
 * slideshow transition (FL-62), ported from the September 24 template's memory-engine.mjs.
 * The moves and the Reduce Motion rule come from `slideshow-transitions` (media-viewer.mjs in
 * the template), so all three surfaces pan, zoom and fall back to a fade the same way.
 *
 * Copy is returned as i18n keys and values; the components translate it.
 */
import type { Translations } from 'svelte-i18n';
import type { MemoryStoryKind } from '$lib/frameleaf/memory-stories';
import { effectiveTransition, kenBurnsMove, SlideshowTransition } from '$lib/frameleaf/slideshow-transitions';

/** How long a photo stays on screen in a memory (memory-engine.mjs:5). */
export const MEMORY_PHOTO_MS = 5000;
/** How long the title card shows before the first item (memory-engine.mjs:6). */
export const MEMORY_TITLE_MS = 2600;
/** One pass of a Memories card's hover preview (memory-engine.mjs:7). */
export const MEMORY_PREVIEW_MS = 9000;

/**
 * How long each photo stays on screen: the owner's Memories duration preference when it is
 * set, the engine's default otherwise (the preference also defaults to five seconds).
 */
export const memoryPhotoMs = (preferenceSeconds?: number | null): number =>
  preferenceSeconds && Number.isFinite(preferenceSeconds) && preferenceSeconds > 0
    ? preferenceSeconds * 1000
    : MEMORY_PHOTO_MS;

export const memoryTransition = (reducedMotion = false): SlideshowTransition =>
  effectiveTransition(SlideshowTransition.Memories, reducedMotion);

export type MemoryMotion = { '--kb-from': string; '--kb-to': string; '--kb-duration': string };

/**
 * The custom properties that drive the shared `fl-ken-burns` keyframes for one item, or
 * undefined under Reduce Motion (and without an item), where the photo only crossfades.
 */
export const memoryMotion = (
  assetId: string | null | undefined,
  { reducedMotion = false, durationMs = MEMORY_PHOTO_MS + 1000 }: { reducedMotion?: boolean; durationMs?: number } = {},
): MemoryMotion | undefined => {
  if (!assetId || memoryTransition(reducedMotion) !== SlideshowTransition.Memories) {
    return undefined;
  }
  const { from, to } = kenBurnsMove(assetId);
  return { '--kb-from': from, '--kb-to': to, '--kb-duration': `${Math.max(0, durationMs) / 1000}s` };
};

/** A Memories card's slow hover preview. */
export const memoryPreviewMotion = (coverId: string | null | undefined, reducedMotion = false) =>
  memoryMotion(coverId, { reducedMotion, durationMs: MEMORY_PREVIEW_MS });

/** Renders a motion record as an inline `style` value. */
export const memoryMotionStyle = (motion: MemoryMotion | undefined): string | undefined =>
  motion
    ? Object.entries(motion)
        .map(([name, value]) => `${name}: ${value}`)
        .join('; ')
    : undefined;

/** The class list for the item on stage: `memories` pans and zooms, `fade` only crossfades. */
export const memorySlideClass = ({
  reducedMotion = false,
  video = false,
  paused = false,
}: { reducedMotion?: boolean; video?: boolean; paused?: boolean } = {}): string =>
  [memoryTransition(reducedMotion) === SlideshowTransition.Memories && !video ? 'memories' : 'fade', paused && 'paused']
    .filter(Boolean)
    .join(' ');

/**
 * The overline above a memory's title, by kind (memory-engine.mjs:48-50): a trip for an event
 * story, highlights for a year in review, a birthday, a recap, and "Memory" otherwise.
 */
export const memoryOverlineKey = (kind: MemoryStoryKind | undefined): Translations => {
  switch (kind) {
    case 'event_story': {
      return 'frameleaf_memories_overline_trip';
    }
    case 'year_in_review': {
      return 'frameleaf_memories_overline_highlights';
    }
    // FL-62: the two server kinds the template has no card for keep the same one-word overline.
    case 'birthday': {
      return 'frameleaf_memories_overline_birthday';
    }
    case 'person_recap': {
      return 'frameleaf_memories_overline_recap';
    }
    default: {
      return 'frameleaf_memories_overline_memory';
    }
  }
};

export type MemoryTitleCard = { overlineKey: Translations; title: string; subtitle: string; count: number };

/** The title card that opens a memory (memory-engine.mjs:52-59). */
export const memoryTitleCard = (memory: {
  kind?: MemoryStoryKind;
  title?: string;
  subtitle?: string;
  count: number;
}): MemoryTitleCard => ({
  overlineKey: memoryOverlineKey(memory.kind),
  title: memory.title ?? '',
  subtitle: memory.subtitle ?? '',
  count: Math.max(0, memory.count),
});

export type MemoryLowerThird = { place: string; day: string; video: boolean };

/**
 * The lower third over each item: the place, over the day it was taken (memory-engine.mjs:61-69).
 * The place falls back to the memory's title when the item has no city.
 */
export const memoryLowerThird = (
  item: { city?: string | null } | null | undefined,
  { fallbackTitle = '', day = '', video = false }: { fallbackTitle?: string; day?: string; video?: boolean } = {},
): MemoryLowerThird | null => {
  if (!item) {
    return null;
  }
  return { place: item.city || fallbackTitle || '', day, video };
};
