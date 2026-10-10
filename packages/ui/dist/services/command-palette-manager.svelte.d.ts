import type { ActionItem, MaybePromise, TranslationProps } from '../types.js';
import { type IFuseOptions } from 'fuse.js';
export type CommandPaletteTranslations = TranslationProps<'search_placeholder' | 'search_no_results' | 'command_palette_prompt_default' | 'command_palette_to_select' | 'command_palette_to_close' | 'command_palette_to_navigate' | 'command_palette_to_show_all'>;
export type ActionProvider = {
    name?: string;
    types?: string[];
    onSearch: (query?: string) => MaybePromise<ActionItem[]>;
};
export type ActionDefaultProviderOptions = Omit<ActionProvider, 'onSearch'> & {
    actions: ActionItem[];
    options?: IFuseOptions<ActionItem>;
};
export declare const defaultProvider: ({ name, types, actions, options }: ActionDefaultProviderOptions) => {
    name: string | undefined;
    types: string[] | undefined;
    onSearch: (query?: string) => ActionItem[];
};
declare class CommandPaletteManager {
    #private;
    get isEnabled(): boolean;
    get results(): {
        provider: ActionProvider;
        items: Array<ActionItem & {
            id: string;
        }>;
    }[];
    get selectedItem(): {
        title: string;
        tags?: Array<string | import("../types.js").ActionItemTag>;
        description?: string;
        text?: string | string[];
        highlights?: string[];
        icon?: import("../types.js").IconLike;
        iconClass?: string;
        color?: import("../types.js").Color;
        onAction: import("../types.js").ActionItemHandler;
        shortcuts?: import("../types.js").MaybeArray<import("../actions/shortcut.js").Shortcut>;
        shortcutOptions?: {
            ignoreInputFields?: boolean;
            preventDefault?: boolean;
        };
    } & import("../types.js").IfLike & {
        id: string;
    };
    isSelected(item: {
        id: string;
    }): boolean;
    enable(): void;
    setTranslations(translations?: CommandPaletteTranslations): void;
    queryUpdate(query: string): void;
    open(initialQuery?: string): void;
    navigateUp(): void;
    navigateDown(): void;
    loadAllItems(): void;
    addProvider(provider: ActionProvider): () => void;
}
export declare const commandPaletteManager: CommandPaletteManager;
export {};
