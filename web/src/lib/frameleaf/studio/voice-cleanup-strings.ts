/**
 * The "Clean up voice" card's words (FL-637), translated by the host.
 *
 * The card lives in the engine, whose locale files carry only its English for strings Frameleaf adds.
 * The host sends its own translation of each in `context.strings`, and the adapter writes it over the
 * engine key (`host-engine-strings.ts`), as for the transcript panel (FL-562). A value the engine
 * fills in at run time travels as an i18next `{{name}}` marker.
 */
export const VOICE_CLEANUP_ENGINE_STRINGS = {
  voiceCleanupTitle: { host: 'frameleaf_studio_voice_cleanup_title', engine: 'editor.audioSection.voiceCleanup.title' },
  voiceCleanupClip: { host: 'frameleaf_studio_voice_cleanup_clip', engine: 'editor.audioSection.voiceCleanup.clip' },
  voiceCleanupCleanedClip: {
    host: 'frameleaf_studio_voice_cleanup_cleaned_clip',
    engine: 'editor.audioSection.voiceCleanup.cleanedClip',
    values: ['name'],
  },
  voiceCleanupFound: { host: 'frameleaf_studio_voice_cleanup_found', engine: 'editor.audioSection.voiceCleanup.found' },
  voiceCleanupChecking: {
    host: 'frameleaf_studio_voice_cleanup_checking',
    engine: 'editor.audioSection.voiceCleanup.checking',
  },
  voiceCleanupNoiseWind: {
    host: 'frameleaf_studio_voice_cleanup_noise_wind',
    engine: 'editor.audioSection.voiceCleanup.noise.wind',
  },
  voiceCleanupNoiseHum: {
    host: 'frameleaf_studio_voice_cleanup_noise_hum',
    engine: 'editor.audioSection.voiceCleanup.noise.hum',
  },
  voiceCleanupNoiseBackground: {
    host: 'frameleaf_studio_voice_cleanup_noise_background',
    engine: 'editor.audioSection.voiceCleanup.noise.background',
  },
  voiceCleanupNoiseEcho: {
    host: 'frameleaf_studio_voice_cleanup_noise_echo',
    engine: 'editor.audioSection.voiceCleanup.noise.echo',
  },
  voiceCleanupStrengthLabel: {
    host: 'frameleaf_studio_voice_cleanup_strength_label',
    engine: 'editor.audioSection.voiceCleanup.strengthLabel',
  },
  voiceCleanupStrengthLight: {
    host: 'frameleaf_studio_voice_cleanup_strength_light',
    engine: 'editor.audioSection.voiceCleanup.strength.light',
  },
  voiceCleanupStrengthStandard: {
    host: 'frameleaf_studio_voice_cleanup_strength_standard',
    engine: 'editor.audioSection.voiceCleanup.strength.standard',
  },
  voiceCleanupStrengthStrong: {
    host: 'frameleaf_studio_voice_cleanup_strength_strong',
    engine: 'editor.audioSection.voiceCleanup.strength.strong',
  },
  voiceCleanupStrengthNoteLight: {
    host: 'frameleaf_studio_voice_cleanup_strength_note_light',
    engine: 'editor.audioSection.voiceCleanup.strengthNote.light',
  },
  voiceCleanupStrengthNoteStandard: {
    host: 'frameleaf_studio_voice_cleanup_strength_note_standard',
    engine: 'editor.audioSection.voiceCleanup.strengthNote.standard',
  },
  voiceCleanupStrengthNoteStrong: {
    host: 'frameleaf_studio_voice_cleanup_strength_note_strong',
    engine: 'editor.audioSection.voiceCleanup.strengthNote.strong',
  },
  voiceCleanupListen: {
    host: 'frameleaf_studio_voice_cleanup_listen',
    engine: 'editor.audioSection.voiceCleanup.listen',
  },
  voiceCleanupBefore: {
    host: 'frameleaf_studio_voice_cleanup_before',
    engine: 'editor.audioSection.voiceCleanup.before',
  },
  voiceCleanupAfter: { host: 'frameleaf_studio_voice_cleanup_after', engine: 'editor.audioSection.voiceCleanup.after' },
  voiceCleanupPlay: { host: 'frameleaf_studio_voice_cleanup_play', engine: 'editor.audioSection.voiceCleanup.play' },
  voiceCleanupStop: { host: 'frameleaf_studio_voice_cleanup_stop', engine: 'editor.audioSection.voiceCleanup.stop' },
  voiceCleanupAfterNotYet: {
    host: 'frameleaf_studio_voice_cleanup_after_not_yet',
    engine: 'editor.audioSection.voiceCleanup.afterNotYet',
  },
  voiceCleanupListenFailed: {
    host: 'frameleaf_studio_voice_cleanup_listen_failed',
    engine: 'editor.audioSection.voiceCleanup.listenFailed',
  },
  voiceCleanupAction: {
    host: 'frameleaf_studio_voice_cleanup_action',
    engine: 'editor.audioSection.voiceCleanup.action',
  },
  voiceCleanupProgress: {
    host: 'frameleaf_studio_voice_cleanup_progress',
    engine: 'editor.audioSection.voiceCleanup.progress',
    values: ['percent'],
  },
  voiceCleanupDone: {
    host: 'frameleaf_studio_voice_cleanup_done',
    engine: 'editor.audioSection.voiceCleanup.done',
    values: ['strength'],
  },
  voiceCleanupUseOriginal: {
    host: 'frameleaf_studio_voice_cleanup_use_original',
    engine: 'editor.audioSection.voiceCleanup.useOriginal',
  },
  voiceCleanupAgain: { host: 'frameleaf_studio_voice_cleanup_again', engine: 'editor.audioSection.voiceCleanup.again' },
  voiceCleanupCleaned: {
    host: 'frameleaf_studio_voice_cleanup_cleaned',
    engine: 'editor.audioSection.voiceCleanup.cleaned',
    values: ['name'],
  },
  voiceCleanupFailed: {
    host: 'frameleaf_studio_voice_cleanup_failed',
    engine: 'editor.audioSection.voiceCleanup.failed',
    values: ['reason'],
  },
  voiceCleanupAnalysisFailed: {
    host: 'frameleaf_studio_voice_cleanup_analysis_failed',
    engine: 'editor.audioSection.voiceCleanup.analysisFailed',
    values: ['reason'],
  },
  voiceCleanupLocked: {
    host: 'frameleaf_studio_voice_cleanup_locked',
    engine: 'editor.audioSection.voiceCleanup.locked',
  },
  voiceCleanupClipGone: {
    host: 'frameleaf_studio_voice_cleanup_clip_gone',
    engine: 'editor.audioSection.voiceCleanup.clipGone',
  },
  voiceCleanupWhere: { host: 'frameleaf_studio_voice_cleanup_where', engine: 'editor.audioSection.voiceCleanup.where' },
} as const satisfies Record<string, { host: string; engine: string; values?: readonly string[] }>;

export type VoiceCleanupEngineString = keyof typeof VOICE_CLEANUP_ENGINE_STRINGS;

type VoiceCleanupHostKey = (typeof VOICE_CLEANUP_ENGINE_STRINGS)[VoiceCleanupEngineString]['host'];
type Translate = (key: VoiceCleanupHostKey, options?: { values?: Record<string, string> }) => string;

/** The host's translation of every card string, with engine markers left in place. */
export function voiceCleanupEngineStrings(translate: Translate): Record<VoiceCleanupEngineString, string> {
  const strings = {} as Record<VoiceCleanupEngineString, string>;
  for (const [name, entry] of Object.entries(VOICE_CLEANUP_ENGINE_STRINGS) as Array<
    [VoiceCleanupEngineString, { host: VoiceCleanupHostKey; values?: readonly string[] }]
  >) {
    const values = Object.fromEntries((entry.values ?? []).map((value) => [value, `{{${value}}}`]));
    strings[name] = entry.values ? translate(entry.host, { values }) : translate(entry.host);
  }
  return strings;
}
