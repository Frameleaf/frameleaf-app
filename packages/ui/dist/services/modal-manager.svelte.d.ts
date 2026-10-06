import ConfirmModal from '../components/ConfirmModal/ConfirmModal.svelte';
import { type Component, type ComponentProps } from 'svelte';
type OnCloseData<T> = T extends {
    onClose: (data: infer R) => void;
} ? unknown extends R ? void : R : T extends {
    onClose: (data?: infer R) => void;
} ? R | undefined : never;
type ExtendsEmptyObject<T> = keyof T extends never ? never : T;
type StripParamIfOptional<T> = T extends void ? [] : [T];
type OptionalParamIfEmpty<T> = ExtendsEmptyObject<T> extends never ? [] | [Record<string, never> | undefined] : [T];
declare class ModalManager {
    show<T extends object>(Component: Component<T>, ...props: OptionalParamIfEmpty<Omit<T, 'onClose'>>): Promise<OnCloseData<T>>;
    open<T extends object, K = OnCloseData<T>>(Component: Component<T>, ...props: OptionalParamIfEmpty<Omit<T, 'onClose'>>): {
        onClose: Promise<K>;
        close: (...args: StripParamIfOptional<K>) => Promise<void>;
    };
    showDialog(options: Omit<ComponentProps<typeof ConfirmModal>, 'onClose'>): Promise<boolean>;
}
export declare const modalManager: ModalManager;
export {};
