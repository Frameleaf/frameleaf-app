import { readFileSync } from 'node:fs';

export const messages = JSON.parse(readFileSync(new URL('./messages.json', import.meta.url), 'utf8'));

export function localeMessages(locale = new Intl.DateTimeFormat().resolvedOptions().locale) {
  const language = locale.split(/[-_]/, 1)[0].toLowerCase();
  return messages[language === 'no' ? 'nb' : language] ?? messages.en;
}

export function message(key, status) {
  return localeMessages()[key].replace('{status}', status ?? '');
}
