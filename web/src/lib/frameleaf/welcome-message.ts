import DOMPurify, { type DOMPurify as Purifier } from 'dompurify';

/**
 * FL-426: the welcome message before sign-in (`server.loginPageMessage`) is plain text unless the
 * administrator chose web formatting (`server.loginPageMessageFormat`). Formatted text is cleaned
 * with DOMPurify to a small set of text tags before it is shown anywhere: no scripts, no event
 * handlers, no styles and nothing that loads from elsewhere (images, frames, video, fonts). Links
 * may point at web pages, an email address or a page of this server, and open in a new tab.
 */
const ALLOWED_TAGS = [
  'a',
  'b',
  'strong',
  'i',
  'em',
  'u',
  's',
  'small',
  'br',
  'p',
  'span',
  'ul',
  'ol',
  'li',
  'blockquote',
  'code',
  'h2',
  'h3',
  'h4',
  'hr',
];
const ALLOWED_ATTR = ['href', 'title'];
/** Web pages, email addresses, and pages of this server (a path, never `//elsewhere`). */
const ALLOWED_URI_REGEXP = /^(?:(?:https?|mailto):|\/(?!\/)|#)/i;

let purifier: Purifier | undefined;

const cleaner = (): Purifier => {
  if (!purifier) {
    purifier = DOMPurify(globalThis);
    purifier.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'A' && node.hasAttribute('href')) {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    });
  }
  return purifier;
};

const escapeHtml = (text: string) => text.replaceAll(/[&<>"']/g, (character) => `&#${character.codePointAt(0)};`);

/**
 * Formatted welcome text, cleaned to what the sign-in page may show. A browser DOMPurify cannot
 * work in gets the text with its tags shown, never unchecked markup.
 */
export const cleanWelcomeHtml = (html: string): string => {
  const purifier = cleaner();
  if (!purifier.isSupported) {
    return escapeHtml(html);
  }
  return purifier.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOWED_URI_REGEXP,
    // a link's `target` and `rel` come from the hook above, never from the message
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    RETURN_TRUSTED_TYPE: false,
  });
};
