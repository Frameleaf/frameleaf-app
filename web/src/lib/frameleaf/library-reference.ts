/** Stored links are untrusted, including records written by older clients. */
export const libraryReferenceUrl = (value: string | null | undefined): string | undefined => {
  if (!value) {
    return;
  }
  try {
    const url = new URL(value);
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) {
      return url.href;
    }
  } catch {
    return;
  }
};
