import TableHeading from '../Table/TableHeading.svelte';
import type { Snippet } from 'svelte';
type Props = {
    children?: Snippet;
};
declare const TableHeading: import("svelte").Component<Props, {}, "">;
type TableHeading = ReturnType<typeof TableHeading>;
export default TableHeading;
