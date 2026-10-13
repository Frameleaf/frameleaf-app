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
