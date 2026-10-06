import type { Color } from '../../types.js';
import { Switch, type WithoutChildrenOrChild } from 'bits-ui';
type Props = {
    checked?: boolean;
    color?: Color;
    disabled?: boolean;
    class?: string;
} & WithoutChildrenOrChild<Switch.RootProps>;
declare const Switch: import("svelte").Component<Props, {}, "checked" | "ref">;
type Switch = ReturnType<typeof Switch>;
export default Switch;
