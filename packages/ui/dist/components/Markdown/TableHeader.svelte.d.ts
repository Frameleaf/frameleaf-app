import TableHeader from '../Table/TableHeader.svelte';
import type { Snippet } from 'svelte';
type Props = {
    children?: Snippet;
};
declare const TableHeader: import("svelte").Component<Props, {}, "">;
type TableHeader = ReturnType<typeof TableHeader>;
export default TableHeader;
