import ProgressBar, { type Props as InternalProps } from '../../internal/ProgressBar.svelte';
type Props = Omit<InternalProps, 'type'> & {
    progress?: number;
};
declare const ProgressBar: import("svelte").Component<Props, {}, "">;
type ProgressBar = ReturnType<typeof ProgressBar>;
export default ProgressBar;
