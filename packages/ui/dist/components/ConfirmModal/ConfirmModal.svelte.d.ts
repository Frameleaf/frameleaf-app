import type { Color, ModalSize } from '../../types.js';
import type { Snippet } from 'svelte';
interface Props {
    title?: string;
    icon?: string | boolean;
    prompt?: string | Snippet;
    confirmText?: string;
    confirmColor?: Color;
    disabled?: boolean;
    size?: ModalSize;
    onClose: (confirmed: boolean) => void;
}
declare const ConfirmModal: import("svelte").Component<Props, {}, "">;
type ConfirmModal = ReturnType<typeof ConfirmModal>;
export default ConfirmModal;
