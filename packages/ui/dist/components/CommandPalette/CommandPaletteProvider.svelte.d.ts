import { type ActionProvider } from '../../services/command-palette-manager.svelte.js';
type Props = {
    providers: ActionProvider[];
};
declare const CommandPaletteProvider: import("svelte").Component<Props, {}, "">;
type CommandPaletteProvider = ReturnType<typeof CommandPaletteProvider>;
export default CommandPaletteProvider;
