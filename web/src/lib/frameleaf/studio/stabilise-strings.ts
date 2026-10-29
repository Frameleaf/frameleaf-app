/**
 * The Stabilise card's words (FL-638), translated by the host.
 *
 * The card lives in the engine, whose locale files carry only its English for strings Frameleaf adds.
 * The host sends its own translation of each in `context.strings`, and the adapter writes it over the
 * engine key (`host-engine-strings.ts`), as for the transcript panel (FL-562). A value the engine
 * fills in at run time travels as an i18next `{{name}}` marker.
 */
export const STABILISE_ENGINE_STRINGS = {
  stabiliseTitle: { host: 'frameleaf_studio_stabilise_title', engine: 'editor.stabilise.title' },
  stabiliseOriginal: { host: 'frameleaf_studio_stabilise_original', engine: 'editor.stabilise.original' },
  stabiliseStabilisedCrop: {
    host: 'frameleaf_studio_stabilise_stabilised_crop',
    engine: 'editor.stabilise.stabilisedCrop',
    values: ['crop'],
  },
  stabiliseSmoothness: { host: 'frameleaf_studio_stabilise_smoothness', engine: 'editor.stabilise.smoothness' },
  stabiliseLevelGentle: { host: 'frameleaf_studio_stabilise_level_gentle', engine: 'editor.stabilise.level.gentle' },
  stabiliseLevelSmooth: { host: 'frameleaf_studio_stabilise_level_smooth', engine: 'editor.stabilise.level.smooth' },
  stabiliseLevelLocked: { host: 'frameleaf_studio_stabilise_level_locked', engine: 'editor.stabilise.level.locked' },
  stabiliseNoteGentle: { host: 'frameleaf_studio_stabilise_note_gentle', engine: 'editor.stabilise.note.gentle' },
  stabiliseNoteSmooth: { host: 'frameleaf_studio_stabilise_note_smooth', engine: 'editor.stabilise.note.smooth' },
  stabiliseNoteLocked: { host: 'frameleaf_studio_stabilise_note_locked', engine: 'editor.stabilise.note.locked' },
  stabiliseCropNote: { host: 'frameleaf_studio_stabilise_crop_note', engine: 'editor.stabilise.cropNote' },
  stabiliseAnalysing: { host: 'frameleaf_studio_stabilise_analysing', engine: 'editor.stabilise.analysing' },
  stabiliseStart: { host: 'frameleaf_studio_stabilise_start', engine: 'editor.stabilise.start' },
  stabiliseDone: {
    host: 'frameleaf_studio_stabilise_done',
    engine: 'editor.stabilise.done',
    values: ['level', 'crop'],
  },
  stabiliseTurnOff: { host: 'frameleaf_studio_stabilise_turn_off', engine: 'editor.stabilise.turnOff' },
  stabiliseApplied: {
    host: 'frameleaf_studio_stabilise_applied',
    engine: 'editor.stabilise.applied',
    values: ['name'],
  },
  stabiliseFailed: { host: 'frameleaf_studio_stabilise_failed', engine: 'editor.stabilise.failed' },
  stabiliseFailedReason: {
    host: 'frameleaf_studio_stabilise_failed_reason',
    engine: 'editor.stabilise.failedReason',
    values: ['reason'],
  },
  stabiliseHdr: { host: 'frameleaf_studio_stabilise_hdr', engine: 'editor.stabilise.hdr' },
  stabiliseNotAppliedLocked: {
    host: 'frameleaf_studio_stabilise_not_applied_locked',
    engine: 'editor.stabilise.notApplied.locked',
  },
  stabiliseNotAppliedRemoved: {
    host: 'frameleaf_studio_stabilise_not_applied_removed',
    engine: 'editor.stabilise.notApplied.removed',
  },
  stabiliseNotAppliedOther: {
    host: 'frameleaf_studio_stabilise_not_applied_other',
    engine: 'editor.stabilise.notApplied.other',
  },
  stabiliseWhereItRuns: { host: 'frameleaf_studio_stabilise_where_it_runs', engine: 'editor.stabilise.whereItRuns' },
} as const satisfies Record<string, { host: string; engine: string; values?: readonly string[] }>;

export type StabiliseEngineString = keyof typeof STABILISE_ENGINE_STRINGS;

type StabiliseHostKey = (typeof STABILISE_ENGINE_STRINGS)[StabiliseEngineString]['host'];
type Translate = (key: StabiliseHostKey, options?: { values?: Record<string, string> }) => string;

/** The host's translation of every Stabilise card string, with engine markers left in place. */
export function stabiliseEngineStrings(translate: Translate): Record<StabiliseEngineString, string> {
  const strings = {} as Record<StabiliseEngineString, string>;
  for (const [name, entry] of Object.entries(STABILISE_ENGINE_STRINGS) as Array<
    [StabiliseEngineString, { host: StabiliseHostKey; values?: readonly string[] }]
  >) {
    const values = Object.fromEntries((entry.values ?? []).map((value) => [value, `{{${value}}}`]));
    strings[name] = entry.values ? translate(entry.host, { values }) : translate(entry.host);
  }
  return strings;
}
