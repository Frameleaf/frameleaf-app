import type { FontWeight, NavbarVariant, Size, TextColor } from '../../types.js';
type Props = {
    title: string;
    size?: Size;
    color?: TextColor;
    fontWeight?: FontWeight;
    variant?: NavbarVariant;
    class?: string;
};
declare const NavbarGroup: import("svelte").Component<Props, {}, "">;
type NavbarGroup = ReturnType<typeof NavbarGroup>;
export default NavbarGroup;
