import type { Color, Shape, Size } from '../../types.js';
import { Checkbox as CheckboxPrimitive, type WithoutChildrenOrChild } from 'bits-ui';
type CheckboxProps = WithoutChildrenOrChild<CheckboxPrimitive.RootProps> & {
    color?: Color;
    shape?: Shape;
    size?: Size;
};
declare const Checkbox: import("svelte").Component<CheckboxProps, {}, "checked" | "ref">;
type Checkbox = ReturnType<typeof Checkbox>;
export default Checkbox;
