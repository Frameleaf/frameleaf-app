import Text from '../Text/Text.svelte';
import type { Snippet } from 'svelte';
type Props = {
    children: Snippet;
};
declare const Text: import("svelte").Component<Props, {}, "">;
type Text = ReturnType<typeof Text>;
export default Text;
