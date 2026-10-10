declare const VStack: import("svelte").Component<{
    class?: string;
    children: import("svelte").Snippet;
    gap?: import("../../types.js").Gap;
    wrap?: boolean;
    fullWidth?: boolean;
    fullHeight?: boolean;
}, {}, "">;
type VStack = ReturnType<typeof VStack>;
export default VStack;
