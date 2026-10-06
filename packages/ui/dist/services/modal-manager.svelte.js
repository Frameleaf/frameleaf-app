import ConfirmModal from '../components/ConfirmModal/ConfirmModal.svelte';
import { mount, unmount } from 'svelte';
class ModalManager {
    show(Component, ...props) {
        return this.open(Component, ...props).onClose;
    }
    open(Component, ...props) {
        let modal = {};
        let onClose;
        const deferred = new Promise((resolve) => {
            onClose = async (...args) => {
                await unmount(modal);
                resolve(args[0]);
            };
            modal = mount(Component, {
                target: document.body,
                props: {
                    ...(props?.[0] ?? {}),
                    onClose,
                },
            });
        });
        return {
            onClose: deferred,
            close: (...args) => onClose(...args),
        };
    }
    showDialog(options) {
        return this.show(ConfirmModal, options);
    }
}
export const modalManager = new ModalManager();
