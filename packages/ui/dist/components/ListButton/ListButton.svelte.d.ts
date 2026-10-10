import type { ButtonProps, IconLike } from '../../types.js';
import type { Snippet } from 'svelte';
type $$ComponentProps = ButtonProps & {
    color?: never;
    selected?: boolean;
    disabled?: boolean;
    selectedIcon?: IconLike | Snippet | false;
};
declare const ListButton: import("svelte").Component<$$ComponentProps, {}, "ref">;
type ListButton = ReturnType<typeof ListButton>;
export default ListButton;
