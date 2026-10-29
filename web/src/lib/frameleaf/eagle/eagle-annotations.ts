import { areaComments, type EagleItem } from '$lib/frameleaf/eagle/eagle-import';

/**
 * Eagle's area comments as Boards annotations (README point 46): each comment that marks an area of
 * a picture becomes a rectangle with its note, marked as coming from Eagle.
 *
 * The annotation API (FL-652) is built separately. This adapter only shapes the data: positions
 * are fractions of the picture (0 to 1) from its top-left corner, rectangles are kept inside the
 * picture, notes are cut to the annotation limit and ids are stable, so importing the same item
 * again gives the same annotations. `EAGLE_ANNOTATIONS_AVAILABLE` stays false until that API is on
 * main; while it is false the check lists area comments as not brought over.
 */
export const EAGLE_ANNOTATIONS_AVAILABLE = false;

/** The FL-652 limits: annotations per item and note length. */
export const ANNOTATION_LIMIT = 200;
export const ANNOTATION_NOTE_MAX = 280;

export interface EagleAnnotation {
  id: string;
  kind: 'rect';
  geometry: { x: number; y: number; width: number; height: number };
  note?: string;
  origin: 'eagle';
}

const clamp = (value: number) => Math.min(1, Math.max(0, value));
const safeId = (value: string) => value.replaceAll(/[^A-Za-z0-9_-]/g, '-').slice(0, 56) || 'comment';

/** The annotations for one Eagle item. Videos, and pictures without a known size, have none. */
export function eagleAnnotations(item: Pick<EagleItem, 'ext' | 'width' | 'height' | 'comments'>): EagleAnnotation[] {
  if (item.width <= 0 || item.height <= 0) {
    return [];
  }
  const seen = new Set<string>();
  return areaComments(item as EagleItem)
    .flatMap((comment) => {
      const x = clamp(comment.x / item.width);
      const y = clamp(comment.y / item.height);
      const width = Math.min(1 - x, comment.width / item.width);
      const height = Math.min(1 - y, comment.height / item.height);
      if (width <= 0 || height <= 0) {
        return [];
      }
      let id = `eagle-${safeId(comment.id)}`;
      for (let n = 2; seen.has(id); n++) {
        id = `eagle-${safeId(comment.id)}-${n}`;
      }
      seen.add(id);
      const note = comment.annotation.trim().slice(0, ANNOTATION_NOTE_MAX);
      return [
        {
          id,
          kind: 'rect' as const,
          geometry: { x, y, width, height },
          ...(note && { note }),
          origin: 'eagle' as const,
        },
      ];
    })
    .slice(0, ANNOTATION_LIMIT);
}
