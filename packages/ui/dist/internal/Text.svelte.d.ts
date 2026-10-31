import type { FontWeight, HeadingColor, HeadingTag, Size, TextVariant } from '../types.js';
import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';
type Props = {
    /**
     * The HTML element type.
     */
    tag?: HeadingTag | 'span';
    fontWeight?: FontWeight;
    variant?: TextVariant;
    color?: HeadingColor;
    size?: Size;
    class?: string;
    children?: Snippet;
} & HTMLAttributes<HTMLElement>;
declare const Text: import("svelte").Component<Props, {}, "">;
type Text = ReturnType<typeof Text>;
export default Text;
