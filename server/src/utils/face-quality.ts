/**
 * FL-1383: what a face's box says about it as a person's main photo, with no decode and no model.
 *
 * An upright face's box is about 0.75 wide for 1 tall. The same face turned a quarter measured 1.7 to
 * 1.9 with the bundled detector (buffalo_l), so a box clearly wider than tall is a sideways face.
 * ponytail: an upside-down face keeps an upright box and cannot be told this way; storing the detector's
 * landmarks with each face would tell.
 */
export const FACE_SIDEWAYS_RATIO = 1.2;

/** A face under this share of the frame's long side is too small to stand for a person (about 85 px of a default preview). */
export const FACE_MIN_FRAME_SHARE = 0.06;

export const faceLooksSideways = ({ x1, y1, x2, y2 }: { x1: number; y1: number; x2: number; y2: number }) =>
  x2 - x1 > FACE_SIDEWAYS_RATIO * (y2 - y1);
