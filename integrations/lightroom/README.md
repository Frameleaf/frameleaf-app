# Frameleaf for Lightroom Classic

A publish service that sends Lightroom Classic collections to Frameleaf albums through Frameleaf Connect (`/api/connect`, OAuth with PKCE). Install the packaged ZIP and follow the [English guide](help/en.md) or the matching guide in `help/`. The plugin UI ships in English and the ten Frameleaf languages (`TranslatedStrings_*.txt`).

When the plugin (or the Connect API it needs) changes on main, `.github/workflows/lightroom-connect.yml` publishes `frameleaf-lightroom.zip`, a versioned copy and `.sha256` checksums to the fixed `lightroom-plugin` prerelease. It does nothing until main has the Connect API. The prerelease is never marked Latest, and Manager only offers `frameleaf-v<version>` releases. The website links `https://github.com/Frameleaf/frameleaf-app/releases/download/lightroom-plugin/frameleaf-lightroom.zip`.

What it does:

- Connects with OAuth (PKCE S256) through the exact callback `lightroom://net.frameleaf.connect/oauth/callback`. It registers itself when the Library allows it; otherwise an administrator registers it and the user enters the app ID. Tokens live in the OS keychain (`LrPasswords`), never in preferences or logs.
- Each published collection maps to one album: an album chosen in the collection's settings, or one created for it on first publish.
- Renders sRGB JPEGs with title, caption, keywords and copyright embedded. Location is removed unless the user opts in; people are never sent. Keywords can also be added as Frameleaf tags.
- Uploads are resumable and idempotent: the request ID is the photo's local ID plus the SHA-256 of the rendered bytes, so a retried export reuses the server's receipt.
- Republishing an edited photo adds a new asset and keeps earlier copies. Removing photos or collections in Lightroom never removes or deletes anything in Frameleaf.

Build and test:

```sh
cd integrations/lightroom
busted spec                                   # Lua 5.1 or later with busted
scripts/package.sh /tmp/frameleaf-lightroom   # frameleaf-lightroom-<version>.zip + .sha256
```

The package version comes from the repository's `package.json`. [TESTING.md](TESTING.md) is the manual qualification script for Lightroom Classic on macOS and Windows. See [provenance](PROVENANCE.md).
