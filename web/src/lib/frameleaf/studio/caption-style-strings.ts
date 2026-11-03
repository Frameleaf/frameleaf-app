/**
 * The Caption style card's words (FL-640), translated by the host.
 *
 * The card lives in the engine (patch 0168), whose locale files carry only its English. As for the
 * transcript panel (FL-562), the host sends its own translation of each in `context.strings`, and
 * the adapter writes it over the engine key (`studio/adapters/web/src/host-engine-strings.ts`).
 */
export const CAPTION_STYLE_ENGINE_STRINGS = {
  captionBig: { host: 'frameleaf_studio_caption_style_big', engine: 'wordCaptions.big' },
  captionBigNote: { host: 'frameleaf_studio_caption_style_big_note', engine: 'wordCaptions.bigNote' },
  captionBottom: { host: 'frameleaf_studio_caption_style_bottom', engine: 'wordCaptions.bottom' },
  captionColourBlue: { host: 'frameleaf_studio_caption_style_colour_blue', engine: 'wordCaptions.colour.blue' },
  captionColourCoral: { host: 'frameleaf_studio_caption_style_colour_coral', engine: 'wordCaptions.colour.coral' },
  captionColourGreen: { host: 'frameleaf_studio_caption_style_colour_green', engine: 'wordCaptions.colour.green' },
  captionColourWhite: { host: 'frameleaf_studio_caption_style_colour_white', engine: 'wordCaptions.colour.white' },
  captionColourYellow: { host: 'frameleaf_studio_caption_style_colour_yellow', engine: 'wordCaptions.colour.yellow' },
  captionHighlight: { host: 'frameleaf_studio_caption_style_highlight', engine: 'wordCaptions.highlight' },
  captionHighlightColour: {
    host: 'frameleaf_studio_caption_style_highlight_colour',
    engine: 'wordCaptions.highlightColour',
  },
  captionHighlightNote: { host: 'frameleaf_studio_caption_style_highlight_note', engine: 'wordCaptions.highlightNote' },
  captionLarge: { host: 'frameleaf_studio_caption_style_large', engine: 'wordCaptions.large' },
  captionLines: { host: 'frameleaf_studio_caption_style_lines', engine: 'wordCaptions.lines' },
  captionLinesNote: { host: 'frameleaf_studio_caption_style_lines_note', engine: 'wordCaptions.linesNote' },
  captionMedium: { host: 'frameleaf_studio_caption_style_medium', engine: 'wordCaptions.medium' },
  captionMiddle: { host: 'frameleaf_studio_caption_style_middle', engine: 'wordCaptions.middle' },
  captionNoWordTimes: { host: 'frameleaf_studio_caption_style_no_word_times', engine: 'wordCaptions.noWordTimes' },
  captionNote: { host: 'frameleaf_studio_caption_style_note', engine: 'wordCaptions.note' },
  captionOriginal: { host: 'frameleaf_studio_caption_style_original', engine: 'wordCaptions.original' },
  captionPosition: { host: 'frameleaf_studio_caption_style_position', engine: 'wordCaptions.position' },
  captionPreviewShape: { host: 'frameleaf_studio_caption_style_preview_shape', engine: 'wordCaptions.previewShape' },
  captionSize: { host: 'frameleaf_studio_caption_style_size', engine: 'wordCaptions.size' },
  captionSmall: { host: 'frameleaf_studio_caption_style_small', engine: 'wordCaptions.small' },
  captionStyle: { host: 'frameleaf_studio_caption_style_style', engine: 'wordCaptions.style' },
  captionTitle: { host: 'frameleaf_studio_caption_style_title', engine: 'wordCaptions.title' },
  captionTop: { host: 'frameleaf_studio_caption_style_top', engine: 'wordCaptions.top' },
  captionVertical: { host: 'frameleaf_studio_caption_style_vertical', engine: 'wordCaptions.vertical' },
  captionWord: { host: 'frameleaf_studio_caption_style_word', engine: 'wordCaptions.word' },
  captionWordNote: { host: 'frameleaf_studio_caption_style_word_note', engine: 'wordCaptions.wordNote' },
} as const satisfies Record<string, { host: string; engine: string }>;

export type CaptionStyleEngineString = keyof typeof CAPTION_STYLE_ENGINE_STRINGS;

type CaptionStyleHostKey = (typeof CAPTION_STYLE_ENGINE_STRINGS)[CaptionStyleEngineString]['host'];

/** The host's translation of every Caption style card string. */
export function captionStyleEngineStrings(
  translate: (key: CaptionStyleHostKey) => string,
): Record<CaptionStyleEngineString, string> {
  const strings = {} as Record<CaptionStyleEngineString, string>;
  for (const [name, entry] of Object.entries(CAPTION_STYLE_ENGINE_STRINGS) as Array<
    [CaptionStyleEngineString, { host: CaptionStyleHostKey }]
  >) {
    strings[name] = translate(entry.host);
  }
  return strings;
}
