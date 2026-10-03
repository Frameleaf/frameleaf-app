# Photography rendition fonts

All three renderer families ship locally, together with their SIL Open Font License texts. The server reads these files from its `resources/fonts` directory in both source and compiled layouts; `package.json` includes `resources` in production deploy output. The browser copies live in `web/static/fonts`. No private gallery requests a font service.

- Great Vibes: copied unchanged from the approved photography prototype (`4d20771a3e`, `design/frameleaf/template/public/fonts/great-vibes.ttf`, accompanying OFL).
- Google Sans: copied unchanged from `web/src/lib/assets/fonts/GoogleSans/GoogleSans.ttf`; OFL from google/fonts `23e54b51ddffbc7713c583748e3bd86f62b1fa4a/ofl/googlesans/OFL.txt`.
- Noto Serif: `NotoSerif[wdth,wght].ttf` and OFL from google/fonts `23e54b51ddffbc7713c583748e3bd86f62b1fa4a/ofl/notoserif`.

Pango and FreeType measure and rasterize the bundled glyphs before composition. Container libvips is built with Pango development headers; the production image includes Pango/Cairo runtime libraries and points fontconfig at `fonts.conf`. Missing font files fail closed instead of silently choosing a system fallback.
