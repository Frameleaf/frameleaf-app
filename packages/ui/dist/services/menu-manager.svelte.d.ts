import type { ContextMenuBaseProps } from '../types.js';
declare class MenuManager {
    show(props: ContextMenuBaseProps): Promise<void>;
}
export declare const menuManager: MenuManager;
export {};
