import { escape } from 'lodash-es';

/**
 * Fills HTML `{tag}` placeholders with escaped variables. An undefined or missing tag stays as written; an
 * empty value removes it (FL-190: `{baseUrl}` when the server has no public address).
 */
export const replaceTemplateTags = (template: string, variables: Record<string, string | undefined>) => {
  return template.replaceAll(/{(.*?)}/g, (tag, key) => {
    const value = Object.hasOwn(variables, key) ? variables[key] : undefined;
    return value === undefined ? tag : escape(value);
  });
};
