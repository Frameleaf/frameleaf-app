import { type Snippet } from 'svelte';
type Props = {
    class?: string;
    children: Snippet;
    open?: boolean;
    border?: boolean;
};
declare const AppShellSidebar: import("svelte").Component<Props, {}, "open">;
type AppShellSidebar = ReturnType<typeof AppShellSidebar>;
export default AppShellSidebar;
