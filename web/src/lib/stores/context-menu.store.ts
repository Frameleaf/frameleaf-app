import { getContext, setContext } from 'svelte';
import { writable } from 'svelte/store';

const contextKey = Symbol('context-menu');

export const createContextMenu = (onOptionClick: () => void) =>
  setContext(contextKey, { selectedId: writable<string | undefined>(undefined), onOptionClick });

export const getContextMenu = () => getContext<ReturnType<typeof createContextMenu> | undefined>(contextKey);
