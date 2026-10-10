import type { Color } from '../../types.js';
import { type Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';
type Props = HTMLAttributes<HTMLDivElement> & {
    ref?: HTMLElement | null;
    color?: Color;
    shape?: 'round' | 'rectangle';
    expanded?: boolean;
    expandable?: boolean;
    children: Snippet;
};
declare const Card: import("svelte").Component<Props, {}, "ref" | "expanded">;
type Card = ReturnType<typeof Card>;
export default Card;
