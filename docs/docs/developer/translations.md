# Translations

Frameleaf translations are contributed by pull request to the [Frameleaf repository](https://github.com/Frameleaf/frameleaf-app). English (`i18n/en.json`) is the source; every other language has its own file in `i18n/`, named by its language code.

## Contributing translations

1. Copy the repository to your GitHub account and create a branch for your translation.
2. Add or update the file for your language in `i18n/`, using the keys from `i18n/en.json`. The languages offered in Settings must contain every English key: `en`, `fr`, `es`, `de`, `it`, `pt`, `nl`, `pl`, `sv`, `da` and `nb_NO`. Add translations for all of these when adding a message. Other language files may be incomplete and fall back to English.
3. Open a pull request against the repository describing the language and what changed.

Keep argument names, rich-text tags and select values unchanged. Translate complete messages rather than joining translated fragments, and use the target language's plural forms. Preserve product names, URLs and code examples. Portuguese (`pt`) uses European Portuguese; `nb_NO` uses Norwegian Bokmål.

Run `pnpm --filter frameleaf-web exec vitest run src/lib/i18n.spec.ts src/lib/i18n-catalogues.spec.ts` to check language loading, completeness and message compatibility. These checks also run in the web test suite.

Server-generated account notifications use the English templates in `server/src/utils/notification-locale.ts` and the translated templates in `server/src/utils/notification-translations.json`. Add every offered language when adding a notification template, using `nb-NO` for Bokmål. These templates use simple `{argument}` replacement, not ICU. Keep their placeholders unchanged and run the server's `notification-locale.spec.ts` tests. Choosing a language in setup or Settings also saves the language for future account notifications. An account that has never chosen one takes the language the app is shown in, the first time the app opens in a language other than English. Device-specific notification preferences remain separate.

Emails the server sends use the English text in `server/src/emails/translations/en.json` and the translations in `server/src/emails/translations/locales.json`, keyed by the same language codes as notifications. They are written in the account's notification language, and in English for an account that has none yet. Like notifications, they use simple `{argument}` replacement. Add every offered language when adding an email message and run the server's `email.repository.spec.ts` tests. An administrator's own email wording, and gallery emails to a studio's clients, are sent as written.

## International message format

Plurals, numbers, dates and other locale specific message formats can be handled by using the [ICU message format](https://unicode-org.github.io/icu/userguide/format_parse/messages/). Internally, this is handled by the [intl-messageformat](https://www.npmjs.com/package/intl-messageformat) library. Their [documentation](https://formatjs.io/docs/intl-messageformat/) includes common, editable examples via a "live editor" feature, which can be useful to test and debug message formats.
