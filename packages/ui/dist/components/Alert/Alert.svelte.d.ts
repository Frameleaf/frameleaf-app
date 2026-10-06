import type { Color, IconLike, Size } from '../../types.js';
import type { Snippet } from 'svelte';
type Props = {
    color?: Color;
    size?: Size;
    icon?: IconLike | false;
    shape?: 'round' | 'rectangle';
    title?: string;
    class?: string;
    duration?: number;
    closable?: boolean;
    controlled?: boolean;
    onClose?: () => void;
    children?: Snippet;
};
declare const Alert: import("svelte").Component<Props, {}, "">;
type Alert = ReturnType<typeof Alert>;
export default Alert;
