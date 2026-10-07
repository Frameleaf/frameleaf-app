# Design work

- Read the authorized private design requirements before using the approved `frameleaf/template` UI reference. Recent written user decisions take precedence over historical screenshots.
- `frameleaf/template` is a self-contained React design reference. Production web remains Svelte; Frameleaf is building its own native iOS and Android apps (the inherited Flutter app has been removed). Port behavior through real services; do not mount the demo or treat sample state as production authority.
- Preserve the original SVG files and hashes in `frameleaf/brand-kit`. Create separately named derivatives when needed; do not redraw the supplied brand or silently overwrite originals.
- Keep the dark-first, restrained three-pane workspace, equal-quality light mode, photographic people imagery, contextual inspectors and compact controls. Avoid decorative gradients/glows outside brand artwork.
- Follow the September 24 Apple-style language in `frameleaf/template/src/apple-style.css` and `frameleaf/tokens.json`:
  - the Apple system font (SF Pro) with bundled Inter as the fallback
  - continuous corners
  - frosted materials with solid fallbacks under Increase Contrast and Reduce Transparency
  - spring motion that becomes crossfades under Reduce Motion, checked in JavaScript as well as CSS
  - squircle people photos
  - the reserved indigo sparkle for AI-produced content.

  Add new styling to that layer or to the owning component's CSS, never as one-off overrides.
- Prototype restoration, jobs, accounts, security and analytics use fictional local data. A working demo is not backend, media-quality, privacy, native or Freecut parity evidence.
- Keep prototypes and visual previews local, excluded from Git and published artifacts. Production source and tests must not depend on these local files. Preserve the local template as an agent reference and reconcile deliberate updates with `source-manifest.json`.
- Do not commit dependencies, build outputs, hosting bindings, credentials, cache directories or personal library media. The existing generated sample media is safe to retain as demonstration content.
