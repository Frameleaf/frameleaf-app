import { twMerge } from 'tailwind-merge';

export const cleanClass = (...classNames) => {
  let classes = '';
  for (const name of classNames) {
    if (typeof name !== 'string' || name === '') continue;
    classes += `${classes ? ' ' : ''}${name}`;
  }
  return twMerge(classes);
};

export const withPrefix = (key) => `frameleaf-ui-${key}`;
let nextId = 0;
export const generateId = () => `ui-id-${nextId++}`;
export const isIconLike = (icon) =>
  typeof icon === 'string' || (icon !== null && typeof icon === 'object' && 'path' in icon);
export const resolveIcon = ({ icons, color, override, fallback }) =>
  override === false ? undefined : override || (icons[color] ?? fallback);
export const asArray = (items) => (Array.isArray(items) ? items : items ? [items] : []);

const HTML_CHARACTERS = /[&<>"']/g;
const HTML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeCharacter = (character) => HTML_ENTITIES[character];
export const escapeHtml = (text) => text.replace(HTML_CHARACTERS, escapeCharacter);
const REGEXP_CHARACTERS = /[.*+?^${}()|[\]\\]/g;
const escapeRegExp = (value) => value.replace(REGEXP_CHARACTERS, '\\$&');

export const highlightHtml = (text, highlights) => {
  const terms = highlights
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
    .map(escapeRegExp);
  if (terms.length === 0) return escapeHtml(text);
  const matches = new RegExp(terms.join('|'), 'gi');
  let html = '';
  let offset = 0;
  for (const match of text.matchAll(matches)) {
    html += escapeHtml(text.slice(offset, match.index)) + '<mark>' + escapeHtml(match[0]) + '</mark>';
    offset = match.index + match[0].length;
  }
  return html + escapeHtml(text.slice(offset));
};
