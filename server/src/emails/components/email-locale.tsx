import * as React from 'react';
import english from 'src/emails/translations/en.json' with { type: 'json' };
import translations from 'src/emails/translations/locales.json' with { type: 'json' };

export type EmailMessageKey = keyof typeof english;
const catalogs: Record<string, Partial<Record<EmailMessageKey, string>>> = translations;

export const emailLocale = (locale = 'en') => {
  try {
    const canonical = Intl.getCanonicalLocales(locale)[0];
    return Object.hasOwn(catalogs, canonical) ? canonical : 'en';
  } catch {
    return 'en';
  }
};

export const EmailLocaleContext = React.createContext('en');
const message = (locale: string, key: EmailMessageKey) => catalogs[emailLocale(locale)]?.[key] ?? english[key];

/** Values stay literal; React escapes text and rich placeholders when rendering the email. */
export const emailText = (locale: string, key: EmailMessageKey, values: Record<string, string | number> = {}) =>
  message(locale, key).replaceAll(/\{(\w+)\}/g, (token, name: string) => String(values[name] ?? token));

export const useEmailText = () => {
  const locale = React.useContext(EmailLocaleContext);
  return (key: EmailMessageKey, values?: Record<string, string | number>) => emailText(locale, key, values);
};

export const EmailMessage = ({ id, values }: { id: EmailMessageKey; values: Record<string, React.ReactNode> }) => {
  const locale = React.useContext(EmailLocaleContext);
  return message(locale, id)
    .split(/(\{\w+\})/g)
    .map((part, index) => (
      <React.Fragment key={index}>{part.startsWith('{') ? (values[part.slice(1, -1)] ?? part) : part}</React.Fragment>
    ));
};
