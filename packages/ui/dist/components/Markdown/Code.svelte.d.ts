import Code from '../Code/Code.svelte';
type Props = {
    code: string;
    multiline?: boolean;
    lang?: string;
};
declare const Code: import("svelte").Component<Props, {}, "">;
type Code = ReturnType<typeof Code>;
export default Code;
