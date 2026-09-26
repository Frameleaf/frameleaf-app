# Translations

Frameleaf translations are managed through pull requests to the `i18n/en.json` file in the [Frameleaf repository](https://github.com/Frameleaf/frameleaf-app).

## Contributing translations

To contribute a new translation or update an existing one:

1. Fork the [Frameleaf repository](https://github.com/Frameleaf/frameleaf-app)
2. Create a new branch for your translation
3. Edit the translation file in `i18n/en.json` (or create a new language file if needed)
4. Submit a pull request with your changes

## International message format

Plurals, numbers, dates and other locale specific message formats can be handled by using the [ICU message format](https://unicode-org.github.io/icu/userguide/format_parse/messages/). Internally, this is handled by the [intl-messageformat](https://www.npmjs.com/package/intl-messageformat) library. Their [documentation](https://formatjs.io/docs/intl-messageformat/) includes common, editable examples via a "live editor" feature, which can be useful to test and debug message formats.
