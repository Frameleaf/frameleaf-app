import type { ToastCustom, ToastItem, ToastOptions, ToastPanelProps, ToastShow } from '../types.js';
export declare const isCustomToast: (item: ToastItem) => item is ToastCustom;
declare class ToastManager {
    #private;
    show(item: ToastShow, options?: ToastOptions): void;
    custom(item: ToastCustom, options?: ToastOptions): void;
    setOptions(options: Omit<ToastPanelProps, 'items'>): void;
    open(item: ToastItem, options?: ToastOptions): void;
    mount(): Promise<void>;
    unmount(): Promise<void>;
    primary(item?: string | ToastShow, options?: ToastOptions): void;
    success(item?: string | ToastShow, options?: ToastOptions): void;
    info(item?: string | ToastShow, options?: ToastOptions): void;
    warning(item?: string | ToastShow, options?: ToastOptions): void;
    danger(item?: string | ToastShow, options?: ToastOptions): void;
    private remove;
}
export declare const toastManager: ToastManager;
export {};
