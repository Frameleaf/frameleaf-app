/** Whether `name` contains what was typed, ignoring case and surrounding spaces. Empty never matches. */
export const nameMatchesFind = (name: string, query: string): boolean => {
  const needle = query.trim().toLowerCase();
  return needle !== '' && name.toLowerCase().includes(needle);
};
