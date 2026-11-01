/**
 * The transcript panel's words (FL-562), translated by the host.
 *
 * The panel lives in the engine, whose locale files carry only its English for strings Frameleaf
 * adds. The host sends its own translation of each in `context.strings`, and the adapter writes it
 * over the engine key (`host-engine-strings.ts`), as for FL-450. A value the engine fills in at
 * run time travels as an i18next `{{name}}` marker, which the host passes through its own
 * formatter as a literal.
 */
export const TRANSCRIPT_ENGINE_STRINGS = {
  transcriptEmpty: { host: 'frameleaf_studio_transcript_empty', engine: 'transcript.edit.empty' },
  transcriptRemoveSilences: {
    host: 'frameleaf_studio_transcript_remove_silences',
    engine: 'transcript.edit.removeSilences',
  },
  transcriptRemoveFillers: {
    host: 'frameleaf_studio_transcript_remove_fillers',
    engine: 'transcript.edit.removeFillers',
  },
  transcriptHint: { host: 'frameleaf_studio_transcript_hint', engine: 'transcript.edit.hint' },
  transcriptSelected: {
    host: 'frameleaf_studio_transcript_selected',
    engine: 'transcript.edit.selected',
    values: ['count', 'seconds'],
  },
  transcriptClear: { host: 'frameleaf_studio_transcript_clear', engine: 'transcript.edit.clear' },
  transcriptCut: { host: 'frameleaf_studio_transcript_cut', engine: 'transcript.edit.cut' },
  transcriptUndo: { host: 'frameleaf_studio_transcript_undo', engine: 'transcript.edit.undo' },
  transcriptCutToast: {
    host: 'frameleaf_studio_transcript_cut_toast',
    engine: 'transcript.edit.cutToast',
    values: ['seconds'],
  },
  transcriptRestored: {
    host: 'frameleaf_studio_transcript_restored',
    engine: 'transcript.edit.restored',
    values: ['seconds'],
  },
  transcriptRestoreFailed: {
    host: 'frameleaf_studio_transcript_restore_failed',
    engine: 'transcript.edit.restoreFailed',
  },
  transcriptRestoreHint: {
    host: 'frameleaf_studio_transcript_restore_hint',
    engine: 'transcript.edit.restoreHint',
  },
  transcriptWordTime: {
    host: 'frameleaf_studio_transcript_word_time',
    engine: 'transcript.edit.wordTime',
    values: ['time'],
  },
  transcriptCorrectWord: {
    host: 'frameleaf_studio_transcript_correct_word',
    engine: 'transcript.edit.correctWord',
  },
  transcriptCorrected: { host: 'frameleaf_studio_transcript_corrected', engine: 'transcript.edit.corrected' },
  transcriptSaveFailed: { host: 'frameleaf_studio_transcript_save_failed', engine: 'transcript.edit.saveFailed' },
  transcriptSilence: {
    host: 'frameleaf_studio_transcript_silence',
    engine: 'transcript.edit.silence',
    values: ['seconds'],
  },
  transcriptSilenceRemoved: {
    host: 'frameleaf_studio_transcript_silence_removed',
    engine: 'transcript.edit.silenceRemoved',
  },
  transcriptShorterBy: {
    host: 'frameleaf_studio_transcript_shorter_by',
    engine: 'transcript.edit.shorterBy',
    values: ['seconds'],
  },
  transcriptCutLabel: { host: 'frameleaf_studio_transcript_cut_label', engine: 'transcript.edit.cutLabel' },
  transcriptNote: { host: 'frameleaf_studio_transcript_note', engine: 'transcript.edit.note' },
  transcriptSpeakerNumber: {
    host: 'frameleaf_studio_transcript_speaker_number',
    engine: 'transcript.edit.speakerNumber',
    values: ['number'],
  },
  transcriptSpeakerMenu: {
    host: 'frameleaf_studio_transcript_speaker_menu',
    engine: 'transcript.edit.speakerMenu',
    values: ['name'],
  },
  transcriptNewSpeaker: { host: 'frameleaf_studio_transcript_new_speaker', engine: 'transcript.edit.newSpeaker' },
  transcriptRenameSpeaker: {
    host: 'frameleaf_studio_transcript_rename_speaker',
    engine: 'transcript.edit.renameSpeaker',
  },
} as const satisfies Record<string, { host: string; engine: string; values?: readonly string[] }>;

export type TranscriptEngineString = keyof typeof TRANSCRIPT_ENGINE_STRINGS;

type TranscriptHostKey = (typeof TRANSCRIPT_ENGINE_STRINGS)[TranscriptEngineString]['host'];
type Translate = (key: TranscriptHostKey, options?: { values?: Record<string, string> }) => string;

/** The host's translation of every transcript panel string, with engine markers left in place. */
export function transcriptEngineStrings(translate: Translate): Record<TranscriptEngineString, string> {
  const strings = {} as Record<TranscriptEngineString, string>;
  for (const [name, entry] of Object.entries(TRANSCRIPT_ENGINE_STRINGS) as Array<
    [TranscriptEngineString, { host: TranscriptHostKey; values?: readonly string[] }]
  >) {
    const values = Object.fromEntries((entry.values ?? []).map((value) => [value, `{{${value}}}`]));
    strings[name] = entry.values ? translate(entry.host, { values }) : translate(entry.host);
  }
  return strings;
}
