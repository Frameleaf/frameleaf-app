import type { Color, ModalSize } from '../../types.js';
import type { Snippet } from 'svelte';
type Props = {
    title: string;
    icon?: string | boolean;
    submitText?: string;
    submitColor?: Color;
    cancelText?: string;
    cancelColor?: Color;
    disabled?: boolean;
    size?: ModalSize;
    preventDefault?: boolean;
    onClose: () => void;
    onOpenAutoFocus?: (event: Event) => void;
    onReset?: (event: Event) => void;
    onSubmit: (event: SubmitEvent) => void | Promise<void>;
    children: Snippet<[{
        formId: string;
    }]>;
};
declare const FormModal: import("svelte").Component<Props, {}, "">;
type FormModal = ReturnType<typeof FormModal>;
export default FormModal;
