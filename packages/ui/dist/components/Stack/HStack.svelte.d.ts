declare const HStack: import("svelte").Component<{
    class?: string;
    children: import("svelte").Snippet;
    gap?: import("../../types.js").Gap;
    wrap?: boolean;
    fullWidth?: boolean;
    fullHeight?: boolean;
}, {}, "">;
type HStack = ReturnType<typeof HStack>;
export default HStack;
