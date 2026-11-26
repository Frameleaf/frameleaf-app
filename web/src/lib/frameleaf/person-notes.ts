/** FL-941: a person's private note is plain text; this is its limit, and how its web links are found. */
export const PERSON_NOTES_MAX = 2000;

export type NotePart = { text: string; href?: string };

/** Splits a note into text and web links, so links can be shown as links (the prototype's `noteParts`). */
export function noteParts(note: string | null | undefined): NotePart[] {
  const parts: NotePart[] = [];
  const text = note ?? '';
  let at = 0;
  for (const match of text.matchAll(/\bhttps?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]]/g)) {
    if (match.index > at) {
      parts.push({ text: text.slice(at, match.index) });
    }
    parts.push({ text: match[0], href: match[0] });
    at = match.index + match[0].length;
  }
  if (at < text.length) {
    parts.push({ text: text.slice(at) });
  }
  return parts;
}
