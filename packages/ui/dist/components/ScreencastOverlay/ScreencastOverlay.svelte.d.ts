import { type Snippet } from 'svelte';
type Props = {
    ref?: HTMLDivElement;
    child?: Snippet<[event: KeyboardEvent]>;
    class?: string;
};
declare const ScreencastOverlay: import("svelte").Component<Props, {}, "ref">;
type ScreencastOverlay = ReturnType<typeof ScreencastOverlay>;
export default ScreencastOverlay;
