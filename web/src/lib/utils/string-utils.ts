const NON_ASCII = /[\u{80}-\u{10FFFF}]/u;

export const removeAccents = (str: string) => {
  if (typeof str === 'string' && !NON_ASCII.test(str)) {
    return str;
  }
  return str.normalize('NFD').replaceAll(/[\u{300}-\u{36F}]/gu, '');
};

export const normalizeSearchString = (str: string) => {
  return removeAccents(str.toLocaleLowerCase().trim());
};

let searchGraphemes: Intl.Segmenter | undefined;
let searchGraphemeLocale: string | undefined;

export const splitSearchMatch = (value: string, query: string, language?: string): [string, string, string] => {
  const search = normalizeSearchString(query);
  if (!search) {
    return [value, '', ''];
  }
  const match = removeAccents(value.toLocaleLowerCase()).indexOf(search);
  if (match === -1) {
    return [value, '', ''];
  }
  if (!NON_ASCII.test(value)) {
    return [value.slice(0, match), value.slice(match, match + search.length), value.slice(match + search.length)];
  }

  // Normalized offsets can expand syllables or remove accents; slice only at original grapheme boundaries.
  let offset = 0;
  let start = -1;
  if (!searchGraphemes || searchGraphemeLocale !== language) {
    searchGraphemes = new Intl.Segmenter(language, { granularity: 'grapheme' });
    searchGraphemeLocale = language;
  }
  for (const { segment, index } of searchGraphemes.segment(value)) {
    offset += removeAccents(segment.toLocaleLowerCase()).length;
    if (start === -1 && offset > match) {
      start = index;
    }
    if (start !== -1 && offset >= match + search.length) {
      const end = index + segment.length;
      return [value.slice(0, start), value.slice(start, end), value.slice(end)];
    }
  }
  return [value, '', ''];
};
