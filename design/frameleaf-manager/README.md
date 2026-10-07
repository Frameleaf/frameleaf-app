# Frameleaf Manager prototype

Standalone interactive design reference for Manager setup, import, database backup,
recovery and mobile onboarding. All operations use fictional browser state.

From the repository root, serve it with:

```sh
python3 -m http.server 4173 --bind 127.0.0.1 --directory design/frameleaf-manager
```

Open http://127.0.0.1:4173/ or http://127.0.0.1:4173/?preview=mobile.
The HTML, JavaScript, CSS and assets are directly served source; no build or
package installation is required.

Run the existing prototype checks with:

```sh
node --test design/frameleaf-manager/tests/*.test.mjs
```

See [prototype behavior](PROTOTYPE-NOTES.md) and [brand provenance](BRAND-SOURCE.md).
