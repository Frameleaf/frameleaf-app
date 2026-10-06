import { Theme, type Color, type Size, type TranslationProps, type Variants } from '../../types.js';
type Props = {
    size?: Size;
    class?: string;
    color?: Color;
    variant?: Variants;
    translations?: TranslationProps<'dark_theme'>;
    onChange?: (theme: Theme) => void;
};
declare const ThemeSwitcher: import("svelte").Component<Props, {}, "">;
type ThemeSwitcher = ReturnType<typeof ThemeSwitcher>;
export default ThemeSwitcher;
