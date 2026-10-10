import { twMerge } from 'tailwind-merge';
export const cleanClass = (...classNames) => {
    return twMerge(classNames
        .filter((className) => {
        if (!className || typeof className === 'boolean') {
            return false;
        }
        return typeof className === 'string';
    })
        .join(' '));
};
export const withPrefix = (key) => `immich-ui-${key}`;
let _count = 0;
export const generateId = () => `ui-id-${_count++}`;
export const isIconLike = (icon) => {
    return typeof icon === 'string' || !!(icon && typeof icon === 'object' && 'path' in icon);
};
export const resolveIcon = ({ icons, color, override, fallback, }) => {
    if (override) {
        return override;
    }
    if (override === false) {
        return;
    }
    return icons[color] ?? fallback;
};
export const asArray = (items) => (Array.isArray(items) ? items : items ? [items] : []);
export const escapeHtml = (text) => {
    return text
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
};
const escapeRegExp = (value) => value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw `\$&`);
export const highlightHtml = (text, highlights) => {
    const escaped = escapeHtml(text);
    // Longest first so a shorter match that is a prefix of a longer one (e.g.
    // "back" vs "backup") doesn't win the regex alternation and mark only part.
    const terms = highlights
        .filter(Boolean)
        .toSorted((a, b) => b.length - a.length)
        .map((term) => escapeRegExp(term));
    if (terms.length === 0) {
        return escaped;
    }
    return escaped.replaceAll(new RegExp(`(${terms.join('|')})`, 'gi'), '<mark>$1</mark>');
};
