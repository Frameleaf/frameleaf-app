/**
 * FL-57: the geometry that ties a manual face decision to a face. A decision keeps the face box as
 * fractions of the detection image (0..1) and the original's checksum, so a new detection of the same
 * face (an overlapping box on the same original) can take the decision over when the face row itself
 * was replaced.
 */

/** Two boxes overlapping this much (intersection over union) are the same face, as face detection decides. */
export const FACE_ANCHOR_IOU = 0.5;

export type NormalizedBox = { x1: number; y1: number; x2: number; y2: number };

export type FaceBoundingBoxRow = {
  boundingBoxX1: number;
  boundingBoxY1: number;
  boundingBoxX2: number;
  boundingBoxY2: number;
  imageWidth: number;
  imageHeight: number;
};

/** A face row's box as fractions of its image, or null when the image size is unknown. */
export const normalizedBox = (face: FaceBoundingBoxRow): NormalizedBox | null => {
  if (!(face.imageWidth > 0 && face.imageHeight > 0)) {
    return null;
  }
  return {
    x1: face.boundingBoxX1 / face.imageWidth,
    y1: face.boundingBoxY1 / face.imageHeight,
    x2: face.boundingBoxX2 / face.imageWidth,
    y2: face.boundingBoxY2 / face.imageHeight,
  };
};

/** The box a recorded decision is anchored to, or null when it has none (a merge). */
export const anchorBox = (entry: {
  boxX1: number | null;
  boxY1: number | null;
  boxX2: number | null;
  boxY2: number | null;
}): NormalizedBox | null => {
  if (entry.boxX1 === null || entry.boxY1 === null || entry.boxX2 === null || entry.boxY2 === null) {
    return null;
  }
  return { x1: entry.boxX1, y1: entry.boxY1, x2: entry.boxX2, y2: entry.boxY2 };
};

/** Intersection over union of two boxes; 0 when either is missing or empty. */
export const boxIou = (a: NormalizedBox | null, b: NormalizedBox | null): number => {
  if (!a || !b) {
    return 0;
  }
  const width = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
  const height = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  const intersection = width * height;
  const union = (a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - intersection;
  return union > 0 ? intersection / union : 0;
};

/**
 * Whether a decision recorded against `anchored` still applies to an original whose checksum is now
 * `current`. A decision recorded without a checksum is not held against the original.
 */
export const sameChecksum = (anchored: Buffer | null, current: Buffer | null | undefined): boolean => {
  if (!anchored) {
    return true;
  }
  return !!current && Buffer.compare(anchored, current) === 0;
};

/**
 * Pairs recorded decisions with new faces: each decision goes to the new face its box overlaps most
 * (above {@link FACE_ANCHOR_IOU}), and each new face takes at most one decision, the newest first.
 */
export const matchAnchoredFaces = <
  E extends { createdAt: Date; boxX1: number | null } & Parameters<typeof anchorBox>[0],
  F extends FaceBoundingBoxRow & { id: string },
>(
  entries: E[],
  faces: F[],
): Array<{ entry: E; face: F }> => {
  const claimed = new Set<string>();
  const matches: Array<{ entry: E; face: F }> = [];
  for (const entry of [...entries].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())) {
    const anchor = anchorBox(entry);
    let best: F | undefined;
    let bestOverlap = FACE_ANCHOR_IOU;
    for (const face of faces) {
      if (claimed.has(face.id)) {
        continue;
      }
      const overlap = boxIou(anchor, normalizedBox(face));
      if (overlap > bestOverlap) {
        best = face;
        bestOverlap = overlap;
      }
    }
    if (best) {
      claimed.add(best.id);
      matches.push({ entry, face: best });
    }
  }
  return matches;
};

/** A pixel box as fractions of its image (`x`, `y`, `width`, `height`), or null when unusable. */
export const fractionBox = (
  face: FaceBoundingBoxRow,
): { x: number; y: number; width: number; height: number } | null => {
  const { boundingBoxX1: x1, boundingBoxY1: y1, boundingBoxX2: x2, boundingBoxY2: y2, imageWidth, imageHeight } = face;
  if (!(imageWidth > 0 && imageHeight > 0 && x2 > x1 && y2 > y1)) {
    return null;
  }
  return { x: x1 / imageWidth, y: y1 / imageHeight, width: (x2 - x1) / imageWidth, height: (y2 - y1) / imageHeight };
};
