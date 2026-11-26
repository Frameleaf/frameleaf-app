import { get } from 'svelte/store';
import { websocketStore } from '$lib/stores/websocket';

/** FL-1800: a tab nobody is looking at asks the server nothing; it asks again when it is shown. */
export const isTabHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

/** While the server's socket is connected it says when work starts, so an idle view need not ask. */
export const isPushConnected = () => get(websocketStore.connected);
