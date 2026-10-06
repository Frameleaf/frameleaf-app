import TableBody from '../Table/TableBody.svelte';
import type { Snippet } from 'svelte';
type Props = {
    children?: Snippet;
};
declare const TableBody: import("svelte").Component<Props, {}, "">;
type TableBody = ReturnType<typeof TableBody>;
export default TableBody;
