/**
 * The cut-out card's words (FL-639), translated by the host.
 *
 * The card lives in the engine, whose locale files carry only its English for strings Frameleaf adds.
 * The host sends its translation of each in `context.strings`, and the adapter writes it over the
 * engine key (`host-engine-strings.ts`), as for the transcript panel (FL-562). A value the engine fills
 * in at run time travels as an i18next `{{name}}` marker.
 */
export const CUTOUT_ENGINE_STRINGS = {
  cutoutAddToSubject: { host: 'frameleaf_studio_cutout_add_to_subject', engine: 'cutout.addToSubject' },
  cutoutBackground: { host: 'frameleaf_studio_cutout_background', engine: 'cutout.background' },
  cutoutBackgroundColour: { host: 'frameleaf_studio_cutout_background_colour', engine: 'cutout.backgroundColour' },
  cutoutBackgroundPhoto: { host: 'frameleaf_studio_cutout_background_photo', engine: 'cutout.backgroundPhoto' },
  cutoutBackgroundsBlurLabel: { host: 'frameleaf_studio_cutout_backgrounds_blur_label', engine: 'cutout.backgrounds.blur.label' },
  cutoutBackgroundsBlurNote: { host: 'frameleaf_studio_cutout_backgrounds_blur_note', engine: 'cutout.backgrounds.blur.note' },
  cutoutBackgroundsColourLabel: { host: 'frameleaf_studio_cutout_backgrounds_colour_label', engine: 'cutout.backgrounds.colour.label' },
  cutoutBackgroundsColourNote: { host: 'frameleaf_studio_cutout_backgrounds_colour_note', engine: 'cutout.backgrounds.colour.note' },
  cutoutBackgroundsKeepLabel: { host: 'frameleaf_studio_cutout_backgrounds_keep_label', engine: 'cutout.backgrounds.keep.label' },
  cutoutBackgroundsKeepNote: { host: 'frameleaf_studio_cutout_backgrounds_keep_note', engine: 'cutout.backgrounds.keep.note' },
  cutoutBackgroundsPhotoLabel: { host: 'frameleaf_studio_cutout_backgrounds_photo_label', engine: 'cutout.backgrounds.photo.label' },
  cutoutBackgroundsPhotoNote: { host: 'frameleaf_studio_cutout_backgrounds_photo_note', engine: 'cutout.backgrounds.photo.note' },
  cutoutBackgroundsRemoveLabel: { host: 'frameleaf_studio_cutout_backgrounds_remove_label', engine: 'cutout.backgrounds.remove.label' },
  cutoutBackgroundsRemoveNote: { host: 'frameleaf_studio_cutout_backgrounds_remove_note', engine: 'cutout.backgrounds.remove.note' },
  cutoutFailed: { host: 'frameleaf_studio_cutout_failed', engine: 'cutout.failed', values: ['name', 'reason'] },
  cutoutFind: { host: 'frameleaf_studio_cutout_find', engine: 'cutout.find', values: ['name'] },
  cutoutFindSubject: { host: 'frameleaf_studio_cutout_find_subject', engine: 'cutout.findSubject' },
  cutoutFinding: { host: 'frameleaf_studio_cutout_finding', engine: 'cutout.finding', values: ['name'] },
  cutoutFindingSubject: { host: 'frameleaf_studio_cutout_finding_subject', engine: 'cutout.findingSubject' },
  cutoutFound: { host: 'frameleaf_studio_cutout_found', engine: 'cutout.found', values: ['name', 'clip'] },
  cutoutLocked: { host: 'frameleaf_studio_cutout_locked', engine: 'cutout.locked' },
  cutoutMainSubject: { host: 'frameleaf_studio_cutout_main_subject', engine: 'cutout.mainSubject' },
  cutoutNoPhotos: { host: 'frameleaf_studio_cutout_no_photos', engine: 'cutout.noPhotos' },
  cutoutNotKept: { host: 'frameleaf_studio_cutout_not_kept', engine: 'cutout.notKept' },
  cutoutPaintAddHint: { host: 'frameleaf_studio_cutout_paint_add_hint', engine: 'cutout.paintAddHint' },
  cutoutPaintTakeHint: { host: 'frameleaf_studio_cutout_paint_take_hint', engine: 'cutout.paintTakeHint' },
  cutoutRefining: { host: 'frameleaf_studio_cutout_refining', engine: 'cutout.refining' },
  cutoutRemove: { host: 'frameleaf_studio_cutout_remove', engine: 'cutout.remove' },
  cutoutSoftness: { host: 'frameleaf_studio_cutout_softness', engine: 'cutout.softness', values: ['value'] },
  cutoutSoftnessLabel: { host: 'frameleaf_studio_cutout_softness_label', engine: 'cutout.softnessLabel' },
  cutoutSubject: { host: 'frameleaf_studio_cutout_subject', engine: 'cutout.subject' },
  cutoutTakeAway: { host: 'frameleaf_studio_cutout_take_away', engine: 'cutout.takeAway' },
  cutoutTitle: { host: 'frameleaf_studio_cutout_title', engine: 'cutout.title' },
  cutoutWhereItRuns: { host: 'frameleaf_studio_cutout_where_it_runs', engine: 'cutout.whereItRuns' },
} as const satisfies Record<string, { host: string; engine: string; values?: readonly string[] }>;

export type CutoutEngineString = keyof typeof CUTOUT_ENGINE_STRINGS;

type CutoutHostKey = (typeof CUTOUT_ENGINE_STRINGS)[CutoutEngineString]['host'];
type Translate = (key: CutoutHostKey, options?: { values?: Record<string, string> }) => string;

/** The host's translation of every cut-out card string, with engine markers left in place. */
export function cutoutEngineStrings(translate: Translate): Record<CutoutEngineString, string> {
  const strings = {} as Record<CutoutEngineString, string>;
  for (const [name, entry] of Object.entries(CUTOUT_ENGINE_STRINGS) as Array<
    [CutoutEngineString, { host: CutoutHostKey; values?: readonly string[] }]
  >) {
    const values = Object.fromEntries((entry.values ?? []).map((value) => [value, `{{${value}}}`]));
    strings[name] = entry.values ? translate(entry.host, { values }) : translate(entry.host);
  }
  return strings;
}
