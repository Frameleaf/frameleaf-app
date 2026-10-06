import type { FieldContext } from '../../types.js';
import { type Snippet } from 'svelte';
type Props = FieldContext & {
    class?: string;
    children: Snippet;
};
declare const Field: import("svelte").Component<Props, {}, "">;
type Field = ReturnType<typeof Field>;
export default Field;
