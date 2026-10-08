/**
 * Whether what was typed is the phrase a destructive action asks for (design review finding 74).
 * One rule for every dialog: spaces around it and capitals do not matter, and an empty phrase never
 * matches.
 */
export const matchesTyped = (phrase: string, typed: string): boolean => {
  const wanted = phrase.trim().toLocaleLowerCase();
  return wanted !== '' && typed.trim().toLocaleLowerCase() === wanted;
};
