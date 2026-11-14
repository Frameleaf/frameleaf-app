# Frameleaf for Lightroom Classic

A publish service that sends Lightroom Classic collections to Frameleaf albums through Frameleaf Connect (`/api/connect`, OAuth with PKCE). Install the packaged ZIP and follow the [English guide](help/en.md) or the matching guide in `help/`. The plugin UI ships in English and the ten Frameleaf languages (`TranslatedStrings_*.txt`).

Each Frameleaf release that includes the Connect API carries `frameleaf-lightroom.zip` (and a versioned copy with `.sha256`), attached after Deploy production by `.github/workflows/lightroom-connect.yml`; the website links `https://github.com/Frameleaf/frameleaf-app/releases/latest/download/frameleaf-lightroom.zip`.

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
