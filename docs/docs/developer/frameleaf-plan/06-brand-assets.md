# Frameleaf production brand assets

The user supplied `frameleaf-vector-assets.zip` for use in the application. Its seven SVGs are the authoritative Frameleaf artwork for production integration. Use them instead of recreating the mark or treating the earlier generated PNG as the release master. This import preserves the original artwork; applying it across applications remains part of the implementation backlog.

This reviewed FL-25 slice is a preservation contract. It does not claim production integration, native qualification or release readiness. The deterministic [`brand-asset-inventory.json`](../../../../design/frameleaf/brand-kit/brand-asset-inventory.json) distinguishes immutable supplied sources, approved design references, historical raster references and still-empty implementation/qualification evidence. Validate it with `python3 scripts/frameleaf-brand-assets.py --repository . --check` and its adversarial tests before changing this contract.

The source files live in [`design/frameleaf/brand-kit`](https://github.com/Frameleaf/frameleaf-app/tree/2fbab9c61f948edf392fad88167a51180fa9d8db/design/frameleaf/brand-kit). The [manifest](../../../../design/frameleaf/brand-kit/manifest.json) records the archive identity, original member paths, exact file sizes and SHA-256 hashes, SVG dimensions, colors, references and intended placements. The supplied [README](../../../../design/frameleaf/brand-kit/README.txt) is preserved unchanged as provenance.

## Provenance and preservation

| Property                 | Recorded value                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| Source archive           | `frameleaf-vector-assets.zip`, supplied by the user                                               |
| Archive size             | 81,800 bytes                                                                                      |
| Archive SHA-256          | `95d705a5756096cd07a7a8c02f455c510e7d48b49435ef1bf07b3501b179603c`                                |
| Imported files           | Seven SVGs and one README; eight regular files                                                    |
| Import date              | September 19, 2026                                                                                |
| Path mapping             | Remove only the common `frameleaf-vector-assets/` prefix; preserve each filename and file's bytes |
| Original transformations | None: no reformatting, optimization, recoloring, redrawing or text replacement                    |

Before writing files, the import checked ZIP paths, modes, expanded size, duplicate names and destination collisions. The archive contains no traversal paths, symlinks or executable files. Each imported file was compared byte-for-byte with its ZIP member. No instructions or scripts from the archive were executed.

Do not run SVG formatters or optimizers over the original kit. Put any required platform exports or approved variants under separately named derivative paths, with source hash, export dimensions, background/mask changes, renderer/tool version and output hash. The existing `design/frameleaf/mark.png` and `mobile/assets/frameleaf-mark.png` remain historical inputs until the integration task replaces their consumers; their presence does not override this kit.

Do not globally replace `immich` while integrating visual branding. Compatibility-sensitive Dart package imports, SDK package names, ML modules, API and database identities, callbacks and released migration semantics retain their existing identities unless a separately reviewed migration changes them. The inventory keeps representative compatibility sentinels so a broad mechanical rebrand fails closed.

## Artwork inventory and placement

The dimensions below are the SVG view boxes, not fixed display sizes. Preserve aspect ratios and enough clear space to retain the frame, leaf and dot.

| Supplied file                                                                                               | View box    | Artwork and intended use                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`frameleaf-symbol.svg`](../../../../design/frameleaf/brand-kit/frameleaf-symbol.svg)                       | 256 × 256   | Transparent green/teal/cyan frame-and-leaf symbol. Primary compact identity for application navigation, mobile headers and favicon source. Inspect it at small sizes and against both themes.                                   |
| [`frameleaf-logo-dark.svg`](../../../../design/frameleaf/brand-kit/frameleaf-logo-dark.svg)                 | 1080 × 264  | Transparent horizontal symbol and wordmark. The “Frame” lettering is near-white; “leaf” uses a green gradient. Use on dark shell, sign-in, public-share, About and documentation headers. “Dark” names the intended background. |
| [`frameleaf-logo-dark-tagline.svg`](../../../../design/frameleaf/brand-kit/frameleaf-logo-dark-tagline.svg) | 1080 × 264  | Horizontal dark-background logo with outlined “YOUR MEMORIES GROW FURTHER” tagline. Use at sufficiently large sizes in onboarding, About or marketing; use the simpler logo when the tagline would be illegible.                |
| [`frameleaf-app-icon.svg`](../../../../design/frameleaf/brand-kit/frameleaf-app-icon.svg)                   | 1024 × 1024 | White symbol on a rounded green-to-teal/cyan gradient tile, with transparent corners. Source for app, PWA, store and launcher exports. Generate each platform's required background, safe-area and mask treatment separately.   |
| [`frameleaf-symbol-white.svg`](../../../../design/frameleaf/brand-kit/frameleaf-symbol-white.svg)           | 256 × 256   | Transparent white monochrome symbol. Suitable for dark/colored surfaces and a source for platform monochrome/mask derivatives. Do not assume the exported white file automatically inherits a host page's CSS color.            |
| [`frameleaf-logo-white.svg`](../../../../design/frameleaf/brand-kit/frameleaf-logo-white.svg)               | 1080 × 264  | Transparent white monochrome horizontal symbol and wordmark. Use where a single-color identity is required on a contrasting dark/colored background.                                                                            |
| [`frameleaf-dark-styleboard.svg`](../../../../design/frameleaf/brand-kit/frameleaf-dark-styleboard.svg)     | 1448 × 1086 | Full brand reference with logo, tagline, app tile, monochrome/favicons, palette and supporting outlined artwork. Keep as reference/documentation; it is not a screen layout or a runtime application background.                |

The styleboard, tagline logo and app tile were rasterized locally for visual inspection while leaving their originals untouched. The previews confirm the frame/leaf/dot construction, horizontal wordmark, tagline and rounded app tile. This is artwork inspection, not browser, Flutter renderer or app-store qualification.

## Colors, themes and typography

The supplied README and styleboard declare these base colors:

| Name            | Value                 | Integration role                                                                      |
| --------------- | --------------------- | ------------------------------------------------------------------------------------- |
| Leaf Green      | `#22C55E`             | Primary brand accent; already present in the existing Frameleaf token foundation      |
| Teal            | `#0EA5A0`             | Secondary brand accent                                                                |
| Sky Blue        | `#3B82F6`             | Supporting accent                                                                     |
| Light Gray      | `#E5E7EB`             | Light neutral on dark surfaces                                                        |
| Canvas gradient | `#111D26` → `#091219` | Brand presentation background; evaluate separately from operational UI surface tokens |

The actual SVG gradients also use brighter green/cyan stops, including `#86F345`, `#00C4D6`, `#88F54A` and `#00ACC9`. Preserve those paths and gradients as supplied. The base palette is not a direction to flatten every stop to `#22C55E`. Exact per-file color values are recorded in the manifest.

The existing [`design/frameleaf/tokens.json`](../../../../design/frameleaf/tokens.json), web tokens and Flutter tokens remain the starting point for accessible application surfaces. The luminous styleboard does not require gradients or glow behind every panel. Keep functional focus/selection/error contrast and photography-first layout intact.

There is **no supplied dark-ink wordmark for a light background**. The dark-background logo and both white variants lose their white lettering on a white canvas. For light-mode integration, use the gradient symbol where contrast is adequate, or place an original wordmark on a deliberate dark brand surface. If a full dark-ink wordmark is required, create a separately tracked approved derivative; do not silently recolor or overwrite the authoritative source.

All supplied lettering, including supporting styleboard copy, is outlined into vector paths. The SVGs have no live text elements, font references or bundled font files. That removes a runtime font dependency for the artwork; it does not identify or license a UI font. Keep the UI typography decision and its license record separate. User authorization establishes the kit's intended application use; this archive does not establish a trademark registration or a separate font/artwork licensing certificate.

## SVG integration audit

All seven SVGs parse as SVG XML and contain shapes, paths, groups, gradients and local `use` references. The audit found:

- No scripts, event-handler attributes, `foreignObject`, embedded raster images, animation elements, external resources, DTDs or entity declarations.
- No unresolved local fragment references or duplicate IDs within an individual file.
- Only internal fragment references such as `#frame-path` and `url(#frame-gradient)`; `xlink:href` is used for local `use` elements.
- An accessible root title/description on each SVG. The files reuse IDs such as `title`, `desc` and shared shape/gradient names across files.

Prefer referencing original artwork as static image resources where appropriate. If a component inlines multiple SVGs, namespace all IDs and their references in a derived component to prevent cross-instance collisions; do not alter the archived originals. Provide the correct accessible name at the application boundary, or hide decorative duplication when adjacent text already names Frameleaf.

Test the actual Flutter SVG/vector or raster-export path for gradients and `use` support. Record any platform conversion in the derivative manifest. Favicon/PWA and Android/iOS exports need visual checks at their real display sizes, with light/dark backgrounds, masks and extension/widget contexts. The supplied app tile already has rounded corners; avoid accidentally applying a second incompatible mask or treating transparent corners as a complete platform-specific store export.

## Backlog integration and completion evidence

The active [canonical backlog](backlog.json) now makes this kit explicit:

- **REL-101 — Native identities and signed artifacts:** derive launcher, adaptive, monochrome and store assets from the supplied kit; verify masks, transparency, safe areas and every app/extension target. Identity/signing values remain independent owner inputs.
- **REL-102 — Authentication and transition:** use the supplied symbol/wordmark on sign-in, setup and migration surfaces while preserving both apps' callback and protocol identities.
- **REL-103 — Complete branding:** replace earlier generated marks through recorded derivatives across web/PWA/native, notifications/widgets, public/auth/share, documentation, installation and distribution surfaces; verify theme contrast and keep the upstream-project attribution and required notices separate.

The foundation design-system and shell tasks consume the same kit. Future agents must record which supplied file each consumer uses, the original/derivative hash, visible size/background, accessible label and verification evidence. Completion requires implemented surfaces and generated platform assets, not just copying the ZIP into the repository. This import changes no app code, prototype screens, callbacks, application IDs, signing or publishing destinations.

Before shipping, verify original hashes still match the manifest, review every generated raster/mask against its source, test actual browser/native rendering and installed icons, and update the branding parity ledger. Publish the documentation mirror from this source page and retain repository paths for the original SVGs; the import itself does not upload assets or write to external services.
