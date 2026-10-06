import TableCell from '../Table/TableCell.svelte';
import type { Snippet } from 'svelte';
type Props = {
    children?: Snippet;
};
declare const TableCell: import("svelte").Component<Props, {}, "">;
type TableCell = ReturnType<typeof TableCell>;
export default TableCell;
