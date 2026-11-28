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
} as const satisfies Record<string, { host: string; engine: string }>;

export type DialogString = keyof typeof DIALOG_STRINGS;

type DialogHostKey = (typeof DIALOG_STRINGS)[DialogString]['host'];

/** The host's translation of every dialog string. */
export function dialogStrings(translate: (key: DialogHostKey) => string): Record<DialogString, string> {
  return Object.fromEntries(
    Object.entries(DIALOG_STRINGS).map(([name, entry]) => [name, translate(entry.host)]),
  ) as Record<DialogString, string>;
}
