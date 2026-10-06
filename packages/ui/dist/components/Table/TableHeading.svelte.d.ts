import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';
type Props = {
    class?: string;
    children?: Snippet;
} & HTMLAttributes<HTMLTableCellElement>;
declare const TableHeading: import("svelte").Component<Props, {}, "">;
type TableHeading = ReturnType<typeof TableHeading>;
export default TableHeading;
