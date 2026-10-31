import type { Size } from '../../types.js';
import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';
type Props = {
    size?: Size;
    class?: string;
    children?: Snippet;
} & HTMLAttributes<HTMLElement>;
declare const Kbd: import("svelte").Component<Props, {}, "">;
type Kbd = ReturnType<typeof Kbd>;
export default Kbd;
