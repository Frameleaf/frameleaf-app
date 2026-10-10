import { type CommandPaletteTranslations } from '../services/command-palette-manager.svelte.js';
import type { ActionItem } from '../types.js';
type Props = {
    onClose: (action?: ActionItem) => void;
    translations?: CommandPaletteTranslations;
    initialQuery?: string;
};
declare const CommandPaletteModal: import("svelte").Component<Props, {}, "">;
type CommandPaletteModal = ReturnType<typeof CommandPaletteModal>;
export default CommandPaletteModal;
