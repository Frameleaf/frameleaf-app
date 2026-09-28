/**
 * FL-83 (PG-10, owner decision 2026-09-27): the merge banner reads as the prototype's
 * `pl-suggestion` line, "{A} and {B} · {reason}." (`People.jsx:820-823`). The prototype's reasons
 * come from `mergeSuggestions` in `people-data.mjs:430-480`: "Both are named {first name}" when
 * both people carry the same first name, otherwise the evidence the pair was found on. The server
 * finds pairs by face-embedding distance, so that evidence is "Their faces look alike".
 */
const firstWord = (name: string | undefined) => (name ?? '').trim().split(/\s+/, 1)[0] ?? '';

/** The first name both people share (as written on the first), or undefined when they differ or one is unnamed. */
export const sharedFirstName = (first: string | undefined, second: string | undefined): string | undefined => {
  const a = firstWord(first);
  const b = firstWord(second);
  return a && b && a.toLocaleLowerCase() === b.toLocaleLowerCase() ? a : undefined;
};
