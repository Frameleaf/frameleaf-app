import TableRow from '../Table/TableRow.svelte';
import type { Snippet } from 'svelte';
type Props = {
    children: Snippet;
};
declare const TableRow: import("svelte").Component<Props, {}, "">;
type TableRow = ReturnType<typeof TableRow>;
export default TableRow;
