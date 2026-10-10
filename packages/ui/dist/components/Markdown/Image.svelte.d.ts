import type { Snippet } from 'svelte';
type Props = {
    src: string;
    alt?: string;
    caption?: Snippet;
    title?: string;
    class?: string;
};
declare const Image: import("svelte").Component<Props, {}, "">;
type Image = ReturnType<typeof Image>;
export default Image;
