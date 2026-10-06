import { type ActionItem, type LinkItem } from './types.js';
export declare const linkCommands: (items: LinkItem[]) => ActionItem[];
export declare const linkCommand: (item: LinkItem) => ActionItem;
export declare const CORE_PAGE_COMMANDS: ActionItem[];
export declare const PROJECT_SUPPORT_COMMANDS: ActionItem[];
export declare const MOBILE_APP_COMMANDS: ActionItem[];
export declare const OTHER_SITE_COMMANDS: ActionItem[];
export declare const SOCIAL_COMMANDS: ActionItem[];
export declare const getSettingCommands: () => ActionItem[];
export declare const getSiteProviders: () => {
    name: string | undefined;
    types: string[] | undefined;
    onSearch: (query?: string) => ActionItem[];
}[];
