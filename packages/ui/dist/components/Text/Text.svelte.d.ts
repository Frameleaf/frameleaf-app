import Text from '../../internal/Text.svelte';
import type { FontWeight, Size, TextColor, TextVariant } from '../../types.js';
import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';
type Props = {
    size?: Size;
    color?: TextColor;
    fontWeight?: FontWeight;
    variant?: TextVariant;
    inline?: boolean;
    class?: string;
    children?: Snippet;
} & HTMLAttributes<HTMLElement>;
declare const Text: import("svelte").Component<Props, {}, "">;
type Text = ReturnType<typeof Text>;
export default Text;
