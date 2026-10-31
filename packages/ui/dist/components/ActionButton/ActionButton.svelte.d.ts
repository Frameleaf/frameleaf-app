import type { ActionItem, Color, Size, Variants } from '../../types.js';
type Props = {
    action: ActionItem & {
        data?: {
            title?: string;
        };
    };
    color?: Color;
    size?: Size;
    variant?: Variants;
    type?: 'icon' | 'button';
};
declare const ActionButton: import("svelte").Component<Props, {}, "">;
type ActionButton = ReturnType<typeof ActionButton>;
export default ActionButton;
