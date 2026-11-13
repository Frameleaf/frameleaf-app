# Frameleaf for WordPress

Install the generated ZIP, then follow the [English guide](help/en.md) or the matching guide in `help/`. The package includes all eleven Frameleaf languages using WordPress gettext catalogues. WordPress selects the plugin language from the user's/site's locale; this does not translate WordPress itself.

Build a deterministic installable archive outside the checkout:

```sh
php integrations/wordpress/tests/security.php
python3 integrations/wordpress/scripts/package.py --output /tmp/frameleaf-connect.zip
```

The adapter has no runtime package dependencies and uses WordPress's HTTP, database, media and localization APIs. It is independently implemented under GPL-2.0-or-later; see [provenance](PROVENANCE.md).

For development, use a disposable WordPress database and installation. Never point qualification scripts at an existing site. [Native qualification instructions](tests/README.md) cover HTTPS fixtures, real PHP worker concurrency, media failure cleanup and Plugin Check. Marketplace submission, live Library qualification and distribution remain separate release activities.
