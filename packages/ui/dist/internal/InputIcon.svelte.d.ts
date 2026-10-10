import type { IconOrSnippet, Size } from '../types.js';
type Props = {
    icon?: IconOrSnippet;
    size?: Size;
    disabled?: boolean;
};
declare const InputIcon: import("svelte").Component<Props, {}, "">;
type InputIcon = ReturnType<typeof InputIcon>;
export default InputIcon;
