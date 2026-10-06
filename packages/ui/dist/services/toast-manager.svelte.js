import ToastPanel from '../components/Toast/ToastPanel.svelte';
import { t } from './translation.svelte.js';
import { generateId } from '../utilities/internal.js';
import { mount, unmount } from 'svelte';
export const isCustomToast = (item) => !!item.component;
const expand = (item) => typeof item === 'string' ? { description: item } : (item ?? {});
class ToastManager {
    #ref;
    #props = $state({ items: [] });
    show(item, options) {
        return this.open(item, options);
    }
    custom(item, options) {
        return this.open(item, options);
    }
    setOptions(options) {
        Object.assign(this.#props, options);
    }
    open(item, options) {
        const { timeout = 3000, closable = true, id = generateId() } = options || {};
        const toast = item;
        toast.id = id;
        if (closable) {
            const onClose = () => this.remove(toast);
            if (isCustomToast(item)) {
                item.props.onClose = onClose;
            }
            else {
                item.onClose = onClose;
            }
        }
        this.#props.items.push(toast);
        void this.mount();
        if (timeout) {
            setTimeout(() => this.remove(toast), timeout);
        }
    }
    async mount() {
        if (!this.#ref) {
            this.#ref = await mount(ToastPanel, {
                target: document.body,
                props: this.#props,
            });
        }
    }
    async unmount() {
        if (this.#ref) {
            await unmount(this.#ref);
        }
    }
    primary(item, options) {
        this.show({ title: t('toast_success_title'), color: 'primary', ...expand(item) }, options);
    }
    success(item, options) {
        this.show({ title: t('toast_success_title'), color: 'success', ...expand(item) }, options);
    }
    info(item, options) {
        this.show({ title: t('toast_info_title'), color: 'info', ...expand(item) }, options);
    }
    warning(item, options) {
        this.show({ title: t('toast_warning_title'), color: 'warning', ...expand(item) }, options);
    }
    danger(item, options) {
        this.show({ title: t('toast_danger_title'), color: 'danger', ...expand(item) }, options);
    }
    remove(target) {
        this.#props.items = this.#props.items.filter((item) => item.id !== target.id);
    }
}
export const toastManager = new ToastManager();
