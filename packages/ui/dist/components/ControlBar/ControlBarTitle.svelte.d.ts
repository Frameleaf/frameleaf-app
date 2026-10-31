import type { Color, FontWeight, HeadingSize, HeadingTag } from '../../types.js';
import type { Snippet } from 'svelte';
type Props = {
    /**
     * The HTML element type.
     */
    tag?: HeadingTag;
    class?: string;
    size?: HeadingSize;
    color?: Color;
    fontWeight?: FontWeight;
    children: Snippet;
};
declare const ControlBarTitle: import("svelte").Component<Props, {}, "">;
type ControlBarTitle = ReturnType<typeof ControlBarTitle>;
export default ControlBarTitle;
