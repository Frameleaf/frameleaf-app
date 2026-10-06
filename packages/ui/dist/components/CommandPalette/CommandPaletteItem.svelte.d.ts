import type { ActionItem } from '../../types.js';
type Props = {
    item: ActionItem;
    selected: boolean;
    onSelect: () => void;
};
declare const CommandPaletteItem: import("svelte").Component<Props, {}, "">;
type CommandPaletteItem = ReturnType<typeof CommandPaletteItem>;
export default CommandPaletteItem;
