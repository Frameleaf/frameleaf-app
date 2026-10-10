import { type TranslationProps } from '../../types.js';
import { type LanguageType } from 'svelte-highlight/languages';
type Props = {
    code: string;
    language?: LanguageType<string>;
    lineNumbers?: boolean;
    lightTheme?: string;
    darkTheme?: string;
    copy?: boolean;
    translations?: TranslationProps<'code_copy' | 'code_copied'>;
};
declare const CodeBlock: import("svelte").Component<Props, {}, "">;
type CodeBlock = ReturnType<typeof CodeBlock>;
export default CodeBlock;
