import Link from '../Link/Link.svelte';
import type { Snippet } from 'svelte';
type Props = {
    href: string;
    title?: string;
    children?: Snippet;
};
declare const Link: import("svelte").Component<Props, {}, "">;
type Link = ReturnType<typeof Link>;
export default Link;
