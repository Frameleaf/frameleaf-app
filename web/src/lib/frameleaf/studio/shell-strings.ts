/**
 * The words of the editor's own shell (FL-1822): the tab bar that replaces the engine's header, its
 * More menu, and the screens shown when the editor or one of its panels stops. Translated by the host.
 *
 * The engine speaks fewer languages than the host, and its locale files carry only its English for
 * strings Frameleaf adds. The host sends its translation of each in `context.strings`, and the adapter
 * writes it over the engine key (`host-engine-strings.ts`), as for the transcript panel (FL-562).
 */
export const SHELL_STRINGS = {
  shellWorkspaces: { host: 'frameleaf_studio_shell_workspaces', engine: 'toolbar.workspaces.label' },
  shellWorkspaceEdit: { host: 'frameleaf_studio_shell_workspace_edit', engine: 'toolbar.workspaces.edit' },
  shellWorkspaceColor: { host: 'frameleaf_studio_shell_workspace_color', engine: 'toolbar.workspaces.color' },
  shellWorkspaceMotion: { host: 'frameleaf_studio_shell_workspace_motion', engine: 'toolbar.workspaces.motion' },
  shellMore: { host: 'frameleaf_studio_shell_more', engine: 'toolbar.more' },
  shellShortcuts: { host: 'frameleaf_studio_shell_shortcuts', engine: 'toolbar.keyboardShortcutsItem' },
  shellSettings: { host: 'frameleaf_studio_shell_settings', engine: 'toolbar.editorSettingsItem' },
  shellErrorTitle: { host: 'frameleaf_studio_shell_error_title', engine: 'app.routeError.title' },
  shellErrorDescription: { host: 'frameleaf_studio_shell_error_description', engine: 'app.routeError.description' },
  shellErrorTryAgain: { host: 'frameleaf_studio_shell_error_try_again', engine: 'app.errorBoundary.tryAgain' },
  shellErrorReload: { host: 'frameleaf_studio_shell_error_reload', engine: 'app.errorBoundary.reloadPage' },
  shellErrorSupportHint: { host: 'frameleaf_studio_shell_error_support_hint', engine: 'app.routeError.supportHint' },
  shellErrorCopyDetails: { host: 'frameleaf_studio_shell_error_copy_details', engine: 'app.routeError.copyDetails' },
  shellErrorCopied: { host: 'frameleaf_studio_shell_error_copied', engine: 'app.routeError.detailsCopied' },
  shellErrorCopyFailed: { host: 'frameleaf_studio_shell_error_copy_failed', engine: 'app.routeError.copyFailed' },
  shellErrorUnexpected: {
    host: 'frameleaf_studio_shell_error_unexpected',
    engine: 'app.errorBoundary.unexpectedError',
  },
  // The editor's crash screens: the whole editor, or one panel of it.
  shellErrorApp: { host: 'frameleaf_studio_shell_error_title', engine: 'app.errorBoundary.appError' },
  shellErrorFeature: { host: 'frameleaf_studio_shell_error_part', engine: 'app.errorBoundary.featureError' },
  shellErrorComponent: { host: 'frameleaf_studio_shell_error_part', engine: 'app.errorBoundary.componentError' },
} as const satisfies Record<string, { host: string; engine: string }>;

export type ShellString = keyof typeof SHELL_STRINGS;

type ShellHostKey = (typeof SHELL_STRINGS)[ShellString]['host'];

/** The host's translation of every shell string. */
export function shellStrings(translate: (key: ShellHostKey) => string): Record<ShellString, string> {
  const strings = {} as Record<ShellString, string>;
  for (const [name, entry] of Object.entries(SHELL_STRINGS) as Array<[ShellString, { host: ShellHostKey }]>) {
    strings[name] = translate(entry.host);
  }
  return strings;
}
