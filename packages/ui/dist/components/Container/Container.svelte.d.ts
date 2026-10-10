import type { Size } from '../../types.js';
import type { Snippet } from 'svelte';
type Props = {
    size?: Size | 'full';
    class?: string;
    center?: boolean;
    children?: Snippet;
};
declare const Container: import("svelte").Component<Props, {}, "">;
type Container = ReturnType<typeof Container>;
export default Container;
