import Alert from '../Alert/Alert.svelte';
import type { IconLike, MarkdownAlertVariant } from '../../types.js';
import type { Snippet } from 'svelte';
type Props = {
    variant?: MarkdownAlertVariant;
    title?: string;
    icon?: IconLike;
    children: Snippet;
};
declare const Alert: import("svelte").Component<Props, {}, "">;
type Alert = ReturnType<typeof Alert>;
export default Alert;
