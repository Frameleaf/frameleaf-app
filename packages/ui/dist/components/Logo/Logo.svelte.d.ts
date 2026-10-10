import type { LogoVariants, Size } from '../../types.js';
type Props = {
    size?: Size | 'landing';
    variant?: LogoVariants;
    class?: string;
};
declare const Logo: import("svelte").Component<Props, {}, "">;
type Logo = ReturnType<typeof Logo>;
export default Logo;
