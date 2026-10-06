import type { Color, Shape, Size } from '../types.js';
import { Meter } from 'bits-ui';
import type { ComponentProps, Snippet } from 'svelte';
export type Props = ComponentProps<typeof Meter.Root> & {
    value?: number;
    max?: number;
    min?: number;
    border?: boolean;
    class?: string;
    color?: Color;
    containerClass?: string;
    label?: string;
    size?: Size;
    shape?: Shape;
    stop?: boolean;
    type?: 'meter' | 'progress';
    animate?: boolean;
    valueLabel?: string;
    thresholds?: {
        from: number;
        className: string;
    }[];
    ref?: HTMLElement | null;
    children?: Snippet;
};
declare const ProgressBar: import("svelte").Component<Props, {}, "">;
type ProgressBar = ReturnType<typeof ProgressBar>;
export default ProgressBar;
