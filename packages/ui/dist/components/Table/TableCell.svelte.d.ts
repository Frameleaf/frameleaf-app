import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';
type Props = {
    class?: string;
    children?: Snippet;
} & HTMLAttributes<HTMLTableCellElement>;
declare const TableCell: import("svelte").Component<Props, {}, "">;
type TableCell = ReturnType<typeof TableCell>;
export default TableCell;
