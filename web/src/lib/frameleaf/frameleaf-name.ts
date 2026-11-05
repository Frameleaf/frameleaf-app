/** The quick rules Frameleaf Cloud checks too (FL-1197): a–z, 0–9 and hyphens, 3 to 40, no hyphen at either end. */
export const nameRule = (name: string) =>
  name.length < 3
    ? 'too_short'
    : name.length > 40
      ? 'too_long'
      : /[^a-z0-9-]/.test(name)
        ? 'characters'
        : name.startsWith('-') || name.endsWith('-')
          ? 'hyphen_at_edge'
          : null;

/** What people type, made into a name: lower case, spaces to hyphens, nothing else. */
export const tidyName = (value: string) =>
  value
    .toLowerCase()
    .trim()
    .replaceAll(/\s+/g, '-')
    .replaceAll(/[^a-z0-9-]/g, '');
