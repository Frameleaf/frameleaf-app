import ContextMenu from '../components/ContextMenu/ContextMenu.svelte';
import { modalManager } from './modal-manager.svelte.js';
class MenuManager {
    show(props) {
        return modalManager.show(ContextMenu, {
            ...props,
        });
    }
}
export const menuManager = new MenuManager();
