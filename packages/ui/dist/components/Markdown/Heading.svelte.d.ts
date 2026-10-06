import Heading from '../Heading/Heading.svelte';
import type { Snippet } from 'svelte';
type Props = {
    id?: string;
    level?: number;
    children: Snippet;
};
declare const Heading: import("svelte").Component<Props, {}, "">;
type Heading = ReturnType<typeof Heading>;
export default Heading;
