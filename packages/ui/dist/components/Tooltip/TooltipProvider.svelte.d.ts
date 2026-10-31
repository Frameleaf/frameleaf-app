import type { Snippet } from 'svelte';
type Props = {
    delayDuration?: number;
    children?: Snippet;
};
declare const TooltipProvider: import("svelte").Component<Props, {}, "">;
type TooltipProvider = ReturnType<typeof TooltipProvider>;
export default TooltipProvider;
