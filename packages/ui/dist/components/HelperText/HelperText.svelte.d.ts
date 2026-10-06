import type { ChildData, TextColor } from '../../types.js';
type Props = {
    color?: TextColor;
} & ChildData;
declare const HelperText: import("svelte").Component<Props, {}, "">;
type HelperText = ReturnType<typeof HelperText>;
export default HelperText;
