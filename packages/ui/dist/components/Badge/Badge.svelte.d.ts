import type { Color, Shape, Size, TranslationProps } from '../../types.js';
import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';
type Props = {
    size?: Size;
    color?: Color;
    shape?: Shape;
    class?: string;
    translations?: TranslationProps<'close'>;
    onClose?: () => void;
    close?: Snippet;
    children?: Snippet;
} & Omit<HTMLAttributes<HTMLSpanElement>, 'color'>;
declare const Badge: import("svelte").Component<Props, {}, "">;
type Badge = ReturnType<typeof Badge>;
export default Badge;
