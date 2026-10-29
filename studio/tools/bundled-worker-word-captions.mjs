// FL-640: the caption look of a shaped (vertical or square) export.
//
// Pure functions, no I/O. `reframeGraph` (FL-563) calls this on its derived copy of the graph
// before it moves titles and captions into the shape's safe area. For every caption segment and
// every clip that shows captions from its transcript:
//
// - a look the person chose in Studio's Caption style card keeps its style and colour, and its
//   size and position are worked out again for the shaped frame;
// - with no chosen look, a Vertical 9:16 export uses Highlight, Large, Middle (owner decision
//   2026-10-29). A square export keeps today's captions.
//
// The engine draws the words (patch 0168, `src/shared/typography/word-captions.ts`); the
// numbers below are the same as its own and a test holds them together. The project is not changed.

export const VERTICAL_WORD_CAPTION_LOOK = Object.freeze({
  style: 'highlight',
  highlightColor: '#f2cc60',
  size: 'large',
  position: 'middle',
});

/** Font size as a fraction of the frame's short side. */
export const WORD_CAPTION_SIZE_RATIO = Object.freeze({ small: 0.04, medium: 0.05, large: 0.07 });
/** Box centre offset from the frame centre, as a fraction of the frame height. */
export const WORD_CAPTION_POSITION_RATIO = Object.freeze({ bottom: 0.3, middle: 0, top: -0.3 });

const STYLES = new Set(['lines', 'highlight', 'word', 'big']);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);

/** True for a look the engine can draw (the shape `WordCaptionLook`). */
export const isWordCaptionLook = (look) =>
  !!look &&
  typeof look === 'object' &&
  STYLES.has(look.style) &&
  typeof look.highlightColor === 'string' &&
  Object.hasOwn(WORD_CAPTION_SIZE_RATIO, look.size) &&
  Object.hasOwn(WORD_CAPTION_POSITION_RATIO, look.position);

/** Font size and vertical offset of a look on a frame of this size. */
export const wordCaptionPlacement = (look, width, height) => ({
  fontSize: Math.max(8, Math.round(Math.max(1, Math.min(width, height)) * WORD_CAPTION_SIZE_RATIO[look.size])),
  y: Math.round(height * WORD_CAPTION_POSITION_RATIO[look.position]),
});

/** The look a shaped export uses for captions that carry `chosen`, or null to leave them as they are. */
export const shapedCaptionLook = (chosen, shape) => {
  if (isWordCaptionLook(chosen)) return chosen;
  return shape === 'vertical' ? VERTICAL_WORD_CAPTION_LOOK : null;
};

/** Apply a look to one caption style block (a caption segment, or a clip's transcript caption style). */
const applyLook = (style, look, frame, safe, width) => {
  const placement = wordCaptionPlacement(look, frame.width, frame.height);
  style.fontSize = placement.fontSize;
  const transform = style.transform ?? {};
  // A missing or non-positive size is not an automatic size: use the default caption box.
  const positive = (value) => finite(value) && value > 0;
  const height = positive(transform.height) ? transform.height : Math.round(frame.height * 0.16);
  const boxWidth = positive(transform.width) ? Math.min(transform.width, width) : width;
  // Keep the whole box inside the safe area, as the reframe does for titles (clip captions skip it).
  const top = frame.height * safe.top - frame.height / 2 + height / 2;
  const bottom = frame.height / 2 - frame.height * safe.bottom - height / 2;
  const centreX = frame.width * ((safe.left - safe.right) / 2);
  const slackX = (width - boxWidth) / 2;
  const x = finite(transform.x) ? transform.x : 0;
  style.transform = {
    rotation: 0,
    opacity: 1,
    ...transform,
    height,
    width: boxWidth,
    x: Math.min(centreX + slackX, Math.max(centreX - slackX, x)),
    y: bottom < top ? (top + bottom) / 2 : Math.min(bottom, Math.max(top, placement.y)),
  };
};

/**
 * Give every caption in `items` its shaped look, in place. `frame` is the shaped canvas and `safe`
 * its safe area as fractions (`SAFE_AREA` of the reframe module).
 */
export const applyShapedCaptionLooks = (items, frame, shape, safe) => {
  const width = Math.round(frame.width * (1 - safe.left - safe.right));
  let changed = 0;
  for (const item of items) {
    if (item.type === 'subtitle') {
      const look = shapedCaptionLook(item.wordLook, shape);
      if (!look) continue;
      item.wordLook = { ...look };
      applyLook(item, look, frame, safe, width);
      changed += 1;
      continue;
    }
    if (item.type !== 'video' && item.type !== 'audio') continue;
    const captions = item.transcriptCaptions;
    if (!captions || captions.type !== 'transcript' || captions.enabled !== true) continue;
    const look = shapedCaptionLook(captions.wordLook, shape);
    if (!look) continue;
    const style = { ...(captions.style ?? {}) };
    applyLook(style, look, frame, safe, width);
    item.transcriptCaptions = { ...captions, wordLook: { ...look }, style };
    changed += 1;
  }
  return changed;
};
