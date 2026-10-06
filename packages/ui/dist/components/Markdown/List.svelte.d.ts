import type { Snippet } from 'svelte';
type Props = {
    ordered?: boolean;
    children: Snippet;
};
declare const List: import("svelte").Component<Props, {}, "">;
type List = ReturnType<typeof List>;
export default List;
