# Translations

Frameleaf translations are contributed by pull request to the [Frameleaf repository](https://github.com/Frameleaf/frameleaf-app). English (`i18n/en.json`) is the source; every other language has its own file in `i18n/`, named by its language code.

## Contributing translations

1. Copy the repository to your GitHub account and create a branch for your translation.
2. Add or update the file for your language in `i18n/`, using the keys from `i18n/en.json`. Keys missing from your file fall back to English.
3. Open a pull request against the repository describing the language and what changed.

## International message format

Plurals, numbers, dates and other locale specific message formats can be handled by using the [ICU message format](https://unicode-org.github.io/icu/userguide/format_parse/messages/). Internally, this is handled by the [intl-messageformat](https://www.npmjs.com/package/intl-messageformat) library. Their [documentation](https://formatjs.io/docs/intl-messageformat/) includes common, editable examples via a "live editor" feature, which can be useful to test and debug message formats.
