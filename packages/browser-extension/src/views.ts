/**
 * FL-655: which panel the popup or options page shows once the connection changes. Settings and
 * Switch server only make sense while signed in: signing out goes back to Connect (with its header),
 * and a finished switch to another server goes back to the main view instead of the switch form.
 */
export type ExtensionView = 'main' | 'settings' | 'switch' | 'key';

export function settledView<V extends ExtensionView>(
  view: V,
  state: {
    connected: boolean;
    origin: string | null;
    switchFrom: string | null;
  },
): V | 'main' {
  if (!state.connected && (view === 'settings' || view === 'switch'))
    return 'main';
  if (view === 'switch' && state.connected && state.origin !== state.switchFrom)
    return 'main';
  return view;
}
