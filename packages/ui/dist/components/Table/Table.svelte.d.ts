import type { TableContext } from '../../types.js';
import { type Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';
type Props = {
    class?: string;
    ref?: HTMLTableElement | null;
    rounded?: boolean;
    shape?: 'semi-round' | 'rectangle';
    border?: boolean;
    children?: Snippet;
} & TableContext & Omit<HTMLAttributes<HTMLTableElement>, 'color' | 'size'>;
declare const Table: import("svelte").Component<Props, {}, "ref">;
type Table = ReturnType<typeof Table>;
export default Table;
