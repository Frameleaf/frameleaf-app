type Props = {
    bytes: number;
    precision?: number;
    variant?: 'short' | 'narrow';
};
declare const FormatBytes: import("svelte").Component<Props, {}, "">;
type FormatBytes = ReturnType<typeof FormatBytes>;
export default FormatBytes;
