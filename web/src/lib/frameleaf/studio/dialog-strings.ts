/**
 * The words of the editor's Keyboard shortcuts and Editor settings dialogs (FL-1822): the titles,
 * the shortcut editor's hint, Show and Hide keyboard, Reset all shortcuts, and the settings labels
 * in sentence case. Translated by the host, as for the bin strings (`bin-strings.ts`): the engine
 * speaks fewer languages than the host, so the host sends its translation in `context.strings` and
 * the adapter writes it over the engine key.
 */
export const DIALOG_STRINGS = {
  dialogShortcutsTitle: { host: 'frameleaf_studio_dialog_shortcuts_title', engine: 'projects.settings.hotkeys.title' },
  dialogShortcutsHint: { host: 'frameleaf_studio_dialog_shortcuts_hint', engine: 'projects.settings.hotkeys.subtitle' },
  dialogShortcutsSelected: {
    host: 'frameleaf_studio_dialog_shortcuts_selected',
    engine: 'projects.settings.hotkeys.selectedCommand',
  },
  // The hint names Record, so the button must read the same word in every language.
  dialogShortcutsRecord: {
    host: 'frameleaf_studio_dialog_shortcuts_record',
    engine: 'projects.settings.hotkeys.record',
  },
  dialogShortcutsResetAll: {
    host: 'frameleaf_studio_dialog_shortcuts_reset_all',
    engine: 'projects.settings.hotkeys.resetAll',
  },
  dialogShortcutsShowKeyboard: {
    host: 'frameleaf_studio_dialog_shortcuts_show_keyboard',
    engine: 'projects.settings.hotkeys.showKeyboard',
  },
  dialogShortcutsHideKeyboard: {
    host: 'frameleaf_studio_dialog_shortcuts_hide_keyboard',
    engine: 'projects.settings.hotkeys.hideKeyboard',
  },
  dialogShortcutsSourceMonitor: {
    host: 'frameleaf_studio_dialog_shortcuts_source_monitor',
    engine: 'projects.settings.hotkeys.sections.sourceMonitor.title',
  },
  dialogSettingsTitle: { host: 'frameleaf_studio_dialog_settings_title', engine: 'settings.title' },
  dialogSettingsUndoHistory: {
    host: 'frameleaf_studio_dialog_settings_undo_history',
    engine: 'settings.general.undoHistoryDepth',
  },
  dialogSettingsShowWaveforms: {
    host: 'frameleaf_studio_dialog_settings_show_waveforms',
    engine: 'settings.timeline.showWaveforms',
  },
  dialogSettingsShowFilmstrips: {
    host: 'frameleaf_studio_dialog_settings_show_filmstrips',
    engine: 'settings.timeline.showFilmstrips',
  },
  dialogSettingsMakeFilmstrips: {
    host: 'frameleaf_studio_dialog_settings_make_filmstrips',
    engine: 'settings.timeline.enableFilmstripExtraction',
  },
  dialogSettingsMakeProxies: {
    host: 'frameleaf_studio_dialog_settings_make_proxies',
    engine: 'settings.storage.generateMissingProxies',
  },
  dialogSettingsClearProjectCache: {
    host: 'frameleaf_studio_dialog_settings_clear_project_cache',
    engine: 'settings.storage.clearProjectCache',
  },
  dialogSettingsRemakeThumbnails: {
    host: 'frameleaf_studio_dialog_settings_remake_thumbnails',
    engine: 'settings.storage.regenerateThumbnails',
  },
  dialogSettingsDeleteProxies: {
    host: 'frameleaf_studio_dialog_settings_delete_proxies',
    engine: 'settings.storage.deleteProxies',
  },
  dialogSettingsClearCache: {
    host: 'frameleaf_studio_dialog_settings_clear_cache',
    engine: 'settings.storage.clearCache',
  },
  dialogShortcutsChanged: {
    host: 'frameleaf_studio_dialog_shortcuts_changed',
    engine: 'projects.settings.hotkeys.custom',
  },
  dialogShortcutsChangedFilter: {
    host: 'frameleaf_studio_dialog_shortcuts_changed',
    engine: 'projects.settings.hotkeys.filters.custom',
  },
  dialogShortcutsChangedCountOne: {
    host: 'frameleaf_studio_dialog_shortcuts_changed_count_one',
    engine: 'projects.settings.hotkeys.customCount_one',
    values: ['count'],
  },
  dialogShortcutsChangedCountOther: {
    host: 'frameleaf_studio_dialog_shortcuts_changed_count_other',
    engine: 'projects.settings.hotkeys.customCount_other',
    values: ['count'],
  },
  dialogSettingsApplies: { host: 'frameleaf_studio_dialog_settings_applies', engine: 'settings.appliesToDevice' },
  dialogSettingsSnapDefault: {
    host: 'frameleaf_studio_dialog_settings_snap_default',
    engine: 'settings.timeline.snapByDefault',
  },
  dialogSettingsPhotoLength: {
    host: 'frameleaf_studio_dialog_settings_photo_length',
    engine: 'settings.timeline.defaultPhotoLength',
  },
  dialogSettingsTransitionLength: {
    host: 'frameleaf_studio_dialog_settings_transition_length',
    engine: 'settings.timeline.defaultTransitionLength',
  },
  dialogSettingsTransitionOwn: {
    host: 'frameleaf_studio_dialog_settings_transition_own',
    engine: 'settings.timeline.transitionOwnLength',
  },
  dialogSettingsSecondsOne: {
    host: 'frameleaf_studio_dialog_settings_seconds_one',
    engine: 'settings.timeline.lengthSeconds_one',
    values: ['seconds'],
  },
  dialogSettingsSecondsOther: {
    host: 'frameleaf_studio_dialog_settings_seconds_other',
    engine: 'settings.timeline.lengthSeconds_other',
    values: ['seconds'],
  },
} as const satisfies Record<string, { host: string; engine: string; values?: readonly string[] }>;

export type DialogString = keyof typeof DIALOG_STRINGS;

type DialogHostKey = (typeof DIALOG_STRINGS)[DialogString]['host'];
type Translate = (key: DialogHostKey, options?: { values?: Record<string, string> }) => string;

/** The host's translation of every dialog string, with engine `{{name}}` markers left in place. */
export function dialogStrings(translate: Translate): Record<DialogString, string> {
  const strings = {} as Record<DialogString, string>;
  for (const [name, entry] of Object.entries(DIALOG_STRINGS) as Array<
    [DialogString, { host: DialogHostKey; values?: readonly string[] }]
  >) {
    const values = Object.fromEntries((entry.values ?? []).map((value) => [value, `{{${value}}}`]));
    strings[name] = entry.values ? translate(entry.host, { values }) : translate(entry.host);
  }
  return strings;
}
