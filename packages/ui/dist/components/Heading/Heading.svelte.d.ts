import type { FontWeight, HeadingColor, HeadingSize, HeadingTag, TextVariant } from '../../types.js';
import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';
type Props = {
    /**
     * The HTML element type.
     */
    tag?: HeadingTag;
    size?: HeadingSize;
    color?: HeadingColor;
    fontWeight?: FontWeight;
    variant?: TextVariant;
    class?: string;
    children: Snippet;
} & HTMLAttributes<HTMLElement>;
declare const Heading: import("svelte").Component<Props, {}, "">;
type Heading = ReturnType<typeof Heading>;
export default Heading;
