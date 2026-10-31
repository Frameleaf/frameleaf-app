import type { Color, Size } from '../../types.js';
interface Props {
    size?: Size;
    color?: Color;
    class?: string;
}
declare const LoadingSpinner: import("svelte").Component<Props, {}, "">;
type LoadingSpinner = ReturnType<typeof LoadingSpinner>;
export default LoadingSpinner;
