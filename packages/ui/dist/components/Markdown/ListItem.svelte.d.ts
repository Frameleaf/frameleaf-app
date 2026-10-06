import type { Snippet } from 'svelte';
type Props = {
    checked?: boolean;
    task?: boolean;
    children: Snippet;
};
declare const ListItem: import("svelte").Component<Props, {}, "">;
type ListItem = ReturnType<typeof ListItem>;
export default ListItem;
