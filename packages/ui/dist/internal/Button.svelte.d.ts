import type { ButtonProps } from '../types.js';
type InternalButtonProps = ButtonProps & {
    /**
    when true, button width to height ratio is 1:1
    */
    icon?: boolean;
};
declare const Button: import("svelte").Component<InternalButtonProps, {}, "ref">;
type Button = ReturnType<typeof Button>;
export default Button;
