import type { HeadingSize, HeadingTag } from '../../types.js';
import type { Snippet } from 'svelte';
type Props = {
    /**
     * The HTML element type.
     */
    tag?: HeadingTag;
    class?: string;
    size?: HeadingSize;
    children: Snippet;
};
declare const CardTitle: import("svelte").Component<Props, {}, "">;
type CardTitle = ReturnType<typeof CardTitle>;
export default CardTitle;
