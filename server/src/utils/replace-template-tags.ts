/**
 * Fills `{tag}` placeholders from `variables`. A tag whose value is undefined is left as written; an
 * empty value removes it (FL-190: `{baseUrl}` when the server has no public address).
 */
export const replaceTemplateTags = (template: string, variables: Record<string, string | undefined>) => {
  return template.replaceAll(/{(.*?)}/g, (_, key) => {
    return variables[key] ?? `{${key}}`;
  });
};
