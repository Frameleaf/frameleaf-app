import type { Size, TextColor } from '../../types.js';
import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';
type Props = {
    color?: TextColor;
    size?: Size;
    variant?: 'filled' | 'ghost' | 'outline';
    class?: string;
    children: Snippet;
} & HTMLAttributes<HTMLElement>;
declare const Code: import("svelte").Component<Props, {}, "">;
type Code = ReturnType<typeof Code>;
export default Code;
