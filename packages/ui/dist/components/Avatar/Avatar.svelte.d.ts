import type { Size } from '../../types.js';
type Props = {
    size?: Size;
    color?: 'primary' | 'pink' | 'red' | 'yellow' | 'blue' | 'green' | 'purple' | 'orange' | 'gray' | 'amber';
    name: string;
    class?: string;
};
declare const Avatar: import("svelte").Component<Props, {}, "">;
type Avatar = ReturnType<typeof Avatar>;
export default Avatar;
