import type { Color, IconLike, MaybeArray, TextColor } from '../types.js';
export declare const cleanClass: (...classNames: unknown[]) => string;
export declare const withPrefix: (key: string) => string;
export declare const generateId: () => string;
export declare const isIconLike: (icon: unknown) => icon is IconLike;
export declare const resolveIcon: ({ icons, color, override, fallback, }: {
    color: Color | TextColor;
    fallback: IconLike;
    override?: IconLike | false;
    icons: Partial<Record<Color | TextColor, string>>;
}) => IconLike | undefined;
export declare const asArray: <T>(items?: MaybeArray<T>) => T[];
export declare const escapeHtml: (text: string) => string;
export declare const highlightHtml: (text: string, highlights: string[]) => string;
