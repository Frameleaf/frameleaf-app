import type { ModalSize } from '../../types.js';
import { type Snippet } from 'svelte';
type Props = {
    title?: string;
    icon?: string | boolean;
    size?: ModalSize;
    class?: string;
    closeOnEsc?: boolean;
    closeOnBackdropClick?: boolean;
    focusOnOpen?: boolean;
    children: Snippet;
    onClose?: () => void;
    onEscapeKeydown?: (event: KeyboardEvent) => void;
    onOpenAutoFocus?: (event: Event) => void;
};
declare const Modal: import("svelte").Component<Props, {}, "">;
type Modal = ReturnType<typeof Modal>;
export default Modal;
