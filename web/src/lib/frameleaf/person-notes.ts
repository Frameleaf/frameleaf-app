/** FL-941: a person's private note is plain text; this is its limit, and how its web links are found. */
export const PERSON_NOTES_MAX = 2000;

export type NotePart = { text: string; href?: string };

/**
 * The address without the sentence's punctuation after it. A closing bracket stays when the address
 * opened it ("…/John_Smith_(explorer)") and goes when the sentence did ("(see https://a.test/x)").
 */
const trimLink = (link: string): string => {
  let url = link;
  for (;;) {
    const last = url.at(-1) ?? '';
    const unmatched = last === ')' && url.split(')').length > url.split('(').length;
    if (last === '' || (!'.,;:!?]'.includes(last) && !unmatched)) {
      return url;
    }
    url = url.slice(0, -1);
  }
};

/** Splits a note into text and web links, so links can be shown as links (the prototype's `noteParts`). */
export function noteParts(note: string | null | undefined): NotePart[] {
  const parts: NotePart[] = [];
  const text = note ?? '';
  let at = 0;
  for (const match of text.matchAll(/\bhttps?:\/\/[^\s<>"]+/g)) {
    const url = trimLink(match[0]);
    if (match.index > at) {
      parts.push({ text: text.slice(at, match.index) });
    }
    parts.push({ text: url, href: url });
    at = match.index + url.length;
  }
  if (at < text.length) {
    parts.push({ text: text.slice(at) });
  }
  return parts;
}
