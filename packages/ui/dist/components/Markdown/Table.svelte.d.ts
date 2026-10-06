import Table from '../Table/Table.svelte';
import type { Snippet } from 'svelte';
type Props = {
    children?: Snippet;
};
declare const Table: import("svelte").Component<Props, {}, "">;
type Table = ReturnType<typeof Table>;
export default Table;
