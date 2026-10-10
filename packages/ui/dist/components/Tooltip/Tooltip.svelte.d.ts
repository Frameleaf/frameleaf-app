import type { Tooltip as BitsTooltip } from 'bits-ui';
import type { Snippet } from 'svelte';
type Props = BitsTooltip.RootProps & {
    text?: string | null;
    child: Snippet<[{
        props: Record<string, unknown>;
    }]>;
};
declare const Tooltip: import("svelte").Component<Props, {}, "open">;
type Tooltip = ReturnType<typeof Tooltip>;
export default Tooltip;
