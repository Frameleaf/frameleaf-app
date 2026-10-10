import type { Color } from '../../types.js';
import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';
type Props = {
    class?: string;
    children?: Snippet;
    center?: boolean;
    color?: Color;
} & HTMLAttributes<HTMLTableRowElement>;
declare const TableRow: import("svelte").Component<Props, {}, "">;
type TableRow = ReturnType<typeof TableRow>;
export default TableRow;
