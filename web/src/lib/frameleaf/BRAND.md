# Frameleaf brand system

The reference for anyone building Frameleaf: the web app first, and the same decisions for the
website and the native apps. It says what the brand is, why each value is what it is, and how to use
it. The files it points to are the source of truth, and `tokens.spec.ts` fails if they drift.

| What | Where |
| --- | --- |
| Token source (version 3) | `web/src/lib/frameleaf/brand-tokens.json` |
| The same document for design | `design/frameleaf/tokens.json` (a byte-for-byte copy, bound by `scripts/frameleaf-brand-assets.py`) |
| Tokens as CSS custom properties | `web/src/lib/frameleaf/tokens.css` |
| Numeric scales for script | `web/src/lib/frameleaf/tokens.ts` |
| Baseline, utility classes, keyframes | `web/src/lib/frameleaf/base.css` |
| Motion helpers | `web/src/lib/frameleaf/motion.ts` |
| Legacy kit and Tailwind mapping | `web/src/app.css`, `web/src/lib/frameleaf/kit-bridge.ts` |
| Components | `web/src/lib/components/frameleaf/` |
| Logo artwork (never edited) | `design/frameleaf/brand-kit/` |

To change a token: edit `brand-tokens.json`, mirror it in `tokens.css` (and `tokens.ts`, `app.css`
where the spec asks), copy the JSON over `design/frameleaf/tokens.json`, then run
`python3 scripts/frameleaf-brand-assets.py --print > design/frameleaf/brand-kit/brand-asset-inventory.json`
and `python3 scripts/frameleaf-brand-assets.py --check`.

## 1. The brand idea

**The frame keeps it. The leaf keeps it alive.**

The logo is a rounded frame with a leaf growing out of its lower corner toward a small sun. That is
the product: a safe, permanent place for a family's photographs (the frame) that is alive with
them, finding people, places and moments and bringing them back (the leaf). Everything in the
system follows from those two halves.

| The frame | The leaf |
| --- | --- |
| Ink surfaces, hairlines, quiet chrome | One green, used for the one thing to do next |
| Neutral behind every photograph | Leaf Light, the gradient, when Frameleaf itself speaks |
| Corners on the logo's own ratio | Unfurl, the one move that is ours |
| Plain, exact words | Warm, reassuring words |

**Personality.** Calm, exact, warm, confident. Frameleaf sounds like a good archivist who is also a
friend: it knows where everything is, says so plainly, and never makes you feel you did something
wrong.

**What it is not.** Not a social feed (no noise, no badges begging for attention). Not a developer
tool (no system words). Not a toy (no bounce for its own sake, no confetti).

### Principles

1. **Photos first.** The photograph is the only thing on screen allowed to be colourful by
   default. Chrome is quiet and compact; one saturated colour, one primary action per surface.
2. **Dark first, light equal.** Every colour is a role with a value per theme. Never write a
   colour that only works in one.
3. **Restraint with one signature.** No decorative gradients, glows or shadows. The brand shows up
   in exactly three places that are ours: Ink, Leaf Light, Unfurl. Because they are rare they are
   recognised.
4. **Honest states.** Loading looks like what is coming, an error says what happened and offers a
   way on, an empty screen offers the action that fills it.
5. **Accessible by construction.** Contrast, focus, touch size and Reduce Motion are handled in the
   tokens and primitives, so using them is the easy path.

## 2. The ten decisions

Each decision names what it came from and where it departs. Inputs were the brand kit
(`design/frameleaf/brand-kit`), the live site (frameleaf.app), the September prototype and the
current app. None was treated as the authority.

### Decision 1. Surfaces: the Ink family

**Decision.** One hue for every neutral, the brand kit's canvas blue (OKLCH hue 242), with the
amount of colour graded by role:

| Zone | Surfaces | Chroma cap | Why |
| --- | --- | --- | --- |
| Stage | `canvas`, behind grids of photographs | 0.012 | A tinted surround shifts how a photograph's colour is seen. The stage carries just enough ink to belong to the brand and no more |
| Chrome | `panel`, `raised`, `border` | 0.022 | Rails, bars, cards and dialogs are where the product may look like Frameleaf rather than like any dark app |
| Viewer | `viewer-*` | 0.006 | A photograph opened full size is judged against neutral dark, in both themes |

Depth: the dark canvas is `#0d1115`, as deep as the site's ink, so photographs sit forward. Each
surface steps at least 1.08:1 in luminance from the one it sits on (dark: canvas, panel, raised,
border; light: white panels on the canvas, wells into the panel).

| Role | Dark | Light |
| --- | --- | --- |
| canvas | `#0d1115` | `#f3f6f8` |
| panel | `#141c21` | `#ffffff` |
| raised | `#1f2830` | `#eaeef2` |
| border | `#303b43` | `#d4dadf` |
| border-strong | `#64727d` | `#64727d` |
| text | `#e5e7eb` | `#0e1b24` |
| muted | `#9aa6b0` | `#505e6a` |

**Inputs.** The kit's canvas (`#111D26` to `#091219`) gave the hue and the depth. The site uses that
ink at full strength (chroma 0.020 to 0.025) on every surface; the app used a nearly grey charcoal
(0.008 to 0.016) at a slightly different hue. **Departure from both:** the site's ink is too
coloured to sit behind a customer's photographs, and the app's charcoal was not recognisably ours.
Grading the ink by zone gets both. The dark `muted` is the site's own `#9aa6b0`, and light `text`
moves to the ink (`#0e1b24`) from a softer grey-green. `tokens.spec.ts` enforces the caps, the hue
and the steps.

### Decision 2. The accent: Leaf Green

**Decision.** One accent. Dark `#22c55e`, light `#157b40`. It is the kit's declared Leaf Green and
the colour at the centre of the logo's leaf.

| Token | Dark | Light |
| --- | --- | --- |
| `--fl-accent` | `#22c55e` | `#157b40` |
| on wide-gamut screens | `color(display-p3 0.2 0.82 0.38)` | `color(display-p3 0.08 0.49 0.25)` |
| `--fl-accent-text` | `#072211` | `#ffffff` |
| `--fl-accent-hover` | accent + 10% white | accent + 12% text |
| `--fl-accent-pressed` | accent + 14% black | accent + 24% text |
| `--fl-accent-soft` | accent at 14% | accent at 14% |
| `--fl-accent-soft-strong` | accent at 24% | accent at 24% |

**Why keep it.** A brighter green from the logo's gradient (`#00d874`, `#21de73`) was considered and
rejected: next to photographs it reads as neon, it sits on the same hue as the green of two very
large consumer brands, and the kit, the site and the app already agree on `#22c55e`. A brand is
stronger for one green used with discipline than for a louder one. The luminous greens live in the
gradient, where they belong (decision 3). On wide-gamut screens the accent is allowed to be more
vivid than sRGB can show, which is where the logo's glow comes through.

**Relation to the gradient.** The accent is the gradient at rest: the same green, without the light
passing through it. So a control is flat Leaf Green; only Frameleaf itself is lit.

**Change from round 1.** The light P3 accent was darkened slightly so it clears 4.5:1 on the new
`raised`; `--fl-accent-pressed` and `--fl-accent-soft-strong` are new.

### Decision 3. Leaf Light, the brand gradient

**Decision.** One named gradient, taken stop for stop from the logo's frame
(`brand-kit/frameleaf-symbol.svg`, `#frame-gradient`), on the logo's own axis:

```css
--fl-brand-gradient: linear-gradient(137deg, #86f345 0%, #36ec72 25%, #00c4d6 57%, #00c7b0 76%, #00d874 100%);
```

**The rule: the gradient is Frameleaf speaking, never you acting.**

| It may appear | It never appears |
| --- | --- |
| The logo artwork | As the fill of a button, chip, badge, toggle or tab |
| The loading mark and the 2px navigation line | As text |
| Sign-in, first run and the link-to-Cloud panels (a hairline or the logo, not a wash) | As a panel, card or page background |
| The frame around an empty-state icon or a done mark | Touching or overlapping a photograph or video |
| The filled end of a progress bar that has finished | As a status colour, a glow, a blur or a shadow |

It is drawn in two shapes only: `fl-brand-line` (a 2px hairline) and `fl-brand-frame` (the logo's
frame around one icon, corner at the logo's 27%). `tokens.spec.ts` lists the files allowed to name
the token; everything else uses those classes or `Logo`.

**Inputs.** The kit gave the stops. The site uses the gradient at 120 degrees with shifted stops and
as gradient text; the prototype and `design/AGENTS.md` allow no gradient outside the artwork.
**Refinement of AGENTS.md:** its intent (no decorative gradients or glows) stands. This decision
adds a short list of brand moments where the logo's own light may appear as a hairline, because a
product with no trace of its logo's most distinctive quality is weaker for it. None of them is
decoration: each marks Frameleaf arriving, working or finishing.

### Decision 4. The lime highlight

**Decision.** Lime (`#b3ff8b`, the highlight edge of the app icon tile) earns one narrow role:
**light on glass.** It is the accent mark on frosted material over photographs
(`--fl-on-material-accent`, dark theme) and the focus ring in the always-dark viewer
(`--fl-viewer-focus`). Those are the two places where Leaf Green cannot promise contrast, because
anything may be behind them.

Never on a light surface (it cannot be read there: under 3:1), never as a fill, never as body text.
`--fl-lime` exists for those two uses.

**Inputs.** The site uses lime for every focus ring. The app used a pale green on material and a
pale blue ring in the viewer, neither of them a brand colour. **Departure:** in the app the
ordinary focus ring stays Leaf Green (it must be one colour with selection), and lime replaces the
two unbranded values.

### Decision 5. Type: semibold, tightening as it grows

**Decision.** SF Pro on Apple devices, bundled Inter elsewhere. Headings are semibold (600) and
their tracking tightens with size, which gives display sizes the same confident voice as the site
without heavier weights. A new top step, `hero`, is for sign-in, first run and an empty library.

| Step | Size / line | Weight | Tracking | Use |
| --- | --- | --- | --- | --- |
| hero | 40 / 1.05 | 600 | -0.035em | Sign-in, first run, an empty library. One per screen |
| display | 28 / 1.15 | 600 | -0.025em | Page titles (`h1`) |
| title | 22 / 1.25 | 600 | -0.02em | Section and error titles |
| headline | 18 / 1.3 | 600 | -0.015em | Dialog and card titles (`h2`) |
| body | 14 / 1.45 | 400 | 0 | Default text |
| callout | 13 / 1.4 | 400 | 0 | Toasts, dense rows |
| caption | 12 / 1.35 | 400 | 0 | Metadata, helper text |
| micro | 11 / 1.3 | 600 | 0.04em | Badges; uppercase section headings (`fl-type-overline`) |

**Numerals.** Anything that counts, times or aligns in a column uses tabular figures:
`font-variant-numeric: var(--fl-numeric)` or the `fl-tabular` class. `Badge`, `Chip`, `CountUp`,
`kbd`, `time` and table cells already do.

**Rendering.** Text is antialiased (`-webkit-font-smoothing`) in the scope and on the page, as on
the site: light text on ink otherwise blooms.

**Inputs.** The site sets headings at 700 to 800 with -0.025em to -0.045em. The app had 600 with
-0.015em to -0.02em and no display voice. **Departure from the site:** weight stays 600, because
the bundled Inter ships 400, 500 and 600 only, and a faked bold on Windows and Android is worse
than a real semibold. The site's tracking curve is adopted instead. Nothing is below 11px.

### Decision 6. Signature motion: Unfurl

**Decision.** One move that belongs to Frameleaf, on top of the seven-pattern vocabulary.

> A mark grows out of its lower inline-start corner, where the leaf meets the frame in the logo. It
> starts at 86% size, turned back eight degrees, and opens in 440ms on a curve with one soft
> overshoot: `cubic-bezier(0.2, 1.5, 0.4, 1)`.

| | |
| --- | --- |
| Tokens | `--fl-duration-unfurl` (440ms), `--fl-unfurl`; `DURATION.unfurl`, `UNFURL`, `UNFURL_FROM` |
| Use it | `fl-unfurl` class, or `in:unfurl` from `motion.ts` |
| Where | The logo on sign-in, first run and the loading screen (`Logo arrive`); the selection tick; a done mark when a task completes; the icon of an empty state |
| Never | A container, menu, dialog, list, or anything larger than about 96px |
| Exit | A 120ms fade. It never unfurls backwards |
| Right to left | Mirrors: grows from the lower right, turned the other way |
| Reduce Motion | The shared 150ms crossfade |

The selection tick is the reason this was chosen: selecting photographs is the most repeated
gesture in the product, so the signature is seen constantly without ever being decoration.

The loading mark never spins. A logo is not a spinner: it unfurls once and holds still
(`app.html`). Work of unknown length uses `Spinner`.

**Inputs.** The prototype's spring and the seven patterns are kept unchanged. The site has scroll
choreography but no signature. **New.**

### Decision 7. Shape: the frame ratio

**Decision.** The logo's frame turns its corner at 27% of its side. A control's corner is 27% of its
height, and each larger surface steps up one 4px grid unit so nested corners stay concentric.

| Token | Value | Use |
| --- | --- | --- |
| `--fl-radius-xs` | 4 | Badges, `kbd`, inner chips |
| `--fl-radius-sm` | 6 | Small wells, thumbnails, skeleton bars |
| `--fl-radius-control` | 12 | Buttons, fields, menu items (44px high) |
| `--fl-radius-control-compact` | 9 | The opt-in 34px desktop controls |
| `--fl-radius-card` | 16 | Cards, menus, panels |
| `--fl-radius-capsule` | 20 | Floating bars, toasts |
| `--fl-radius-sheet` | 24 | Dialogs and sheets |
| `--fl-radius-pill` | 999 | Chips, switches |

An inner corner is its container's corner less the padding between them (a 12px menu item sits 4px
inside a 16px menu). Corners are continuous (squircle) where the engine supports it, for surfaces only
(cards, sheets, panels): they carry `fl-continuous-corners` and grow their radius 1.8 times inside
`@supports (corner-shape: squircle)`. Controls and chips keep the plain 12px and pill corners: a
squircle at an ungrown radius reads as about 7px, squarer than the frame ratio. Do not write `corner-shape` in a component `<style>` block.
People photos use the `fl-squircle` mask. `fl-brand-frame` is the frame itself, at 27%.

**Inputs.** The prototype's 9px control corner was drawn for 34px controls, where it is exactly
the logo's ratio. The app then raised controls to 44px for touch and kept 9px, which made them
boxier than the logo. **Departure:** the ratio is kept, not the number. Tailwind `rounded-lg`,
`-xl`, `-2xl` and `-3xl` are mapped to 12, 16, 20 and 24 in `app.css`.

### Decision 8. Iconography and the AI indigo

**Decision.** Material Design Icons, outline at rest, filled for the current or selected item. Six
sizes, never scaled between them:

| Name | px | Use |
| --- | --- | --- |
| xs | 12 | Marks inside badges and chips |
| sm | 14 | Dense rows, captions |
| md | 16 | Default: buttons, menu items, fields |
| lg | 18 | Toolbars, rails, dialog chrome |
| xl | 20 | Prominent actions, section headers |
| hero | 28 | Empty states, error cards |

```svelte
<Icon icon={mdiClose} size={ICON_SIZE.lg} />
```

`ICON_SIZE` holds the strings the `Icon` component takes; `ICON_PX` the same sizes as numbers;
`--fl-icon-*` in CSS. Icons take the colour of their text. A status icon takes its status colour
and is always paired with words.

**AI.** Indigo `#5e5ce6` is reserved for what Frameleaf's AI produced, always with the sparkle
(`mdiShimmer`) on a solid indigo tile. It stays, deliberately: it sits on the far side of the
colour wheel from the whole green-to-teal brand range, so something the AI wrote can never be
mistaken for something Frameleaf did or something you chose. New: `--fl-ai-ink` (dark `#a3a1ff`,
light `#4b49cf`) for AI labels and links as text, which the tile colour could not do at 4.5:1 on
dark surfaces, and `--fl-ai-soft` for a tinted row. `Badge tone="ai"` is the tile as a badge.

### Decision 9. The logo

`Logo` holds the rules; `Brand` is the lockup for pages outside the shell. Artwork comes only from
`design/frameleaf/brand-kit` and is never redrawn, recoloured, stretched, outlined or boxed.

| Rule | Value |
| --- | --- |
| Clear space | A quarter of the mark's height on every side (`clearSpace`) |
| Minimum height | Symbol 16px, lockup 20px; the component enforces it |
| On dark | The supplied lockup (`frameleaf-logo-dark.svg`) |
| On light | The gradient symbol with "Frameleaf" set in text in `--fl-text`, semibold and tight. The kit has no dark-ink wordmark and a white one never goes on a light surface |
| Over a photograph or in the viewer | The white artwork (`mono`), dark surfaces only |
| App icon | The gradient tile is for the home screen and the store, never inside the product |
| Loading mark | The gradient symbol at 64px, centred on the canvas. It unfurls once and never spins |
| Arrival | `arrive` plays Unfurl once. Sign-in and first run only; never the top bar, never an error |

| Prop | Values |
| --- | --- |
| `variant` | `symbol`, `lockup` |
| `surface` | `dark`, `light`, `auto` (follows the app theme) |
| `mono` | boolean |
| `size` | `tiny` 32, `small` 40, `medium` 48, `large` 64, `giant` 96, `landing` 256 |
| `clearSpace`, `arrive`, `decorative` | boolean |

### Decision 10. Voice and tone

**Short. Plain. Reassuring.**

1. **Plain.** Everyday words. Say "photos and videos", never "assets". Never Immich, fork,
   upstream, pipeline, job queue, endpoint, sync token or any other system word.
2. **Short.** One idea per sentence. The action or the thing first. A button is a verb and an
   object: "Create album", "Try again".
3. **Reassuring.** Say what is safe before what went wrong. Nothing is the customer's fault.
4. **Specific.** Name the thing and the next step. An error always offers a way on.
5. **Calm.** No exclamation marks. No "please", "sorry", "oops" or "successfully". Sentence case
   everywhere.

Before and after, from strings in `i18n/en.json` today:

| Key | Now | In the Frameleaf voice |
| --- | --- | --- |
| `frameleaf_unable_to_load_albums` | Unable to load albums | Your albums did not load. Try again. |
| `frameleaf_auth_change_password_failed` | Unable to save your password. | Your password was not changed. Try again. |
| `frameleaf_dedup_unable_to_load` | Unable to load the deduplication preview | The duplicate preview did not load. Nothing has changed. |
| `frameleaf_bulk_archive_undo_failed` | Unable to undo the archive | These are still archived. Try Undo again. |
| `editor_edits_applied_success` | Edits applied successfully | Edits saved |
| `login_password_changed_success` | Password updated successfully | Password changed |
| `maintenance_delete_error` | Failed to delete backup. | The backup was not deleted. Try again. |
| `admin.user_successfully_removed` | User {email} has been successfully removed. | {email} was removed. |

The pattern for a failure is: what is still true, then what to do. "Unable to", "Failed to" and
"An error occurred" describe the software; the customer wants to know about their photos. These
rewrites are guidance for new and revised strings; the existing values have not been changed here.

Tone shifts with the moment, not the vocabulary: first run is warm ("Welcome. Let's bring your
photos home."), daily use is nearly silent, a destructive confirmation is exact ("Delete 12 photos
from every device. This cannot be undone."), and an error is steady.

## 3. Token reference

Tokens are defined on `.frameleaf[data-theme]`, on the media viewer, and on the document root
(following the app theme class on `<html>`). `var(--fl-*)` works everywhere, including toasts,
legacy modals and other portalled surfaces.

### Colour roles

Use the role, never a hex value. Every foreground clears 4.5:1 on `canvas`, `panel` and `raised` in
its own theme; every `*-text` clears 4.5:1 on its fill; marks and outlines clear 3:1.

| Token | Use it for | Do not use it for |
| --- | --- | --- |
| `--fl-canvas` | The page behind everything, and behind grids of photographs. `body` paints it in both themes (`app.css`) | Cards or controls |
| `--fl-panel` | Rails, bars, cards, dialogs, menus | |
| `--fl-raised` | Controls, hover fills, wells inside a panel, skeletons | Page backgrounds |
| `--fl-border` | Hairlines and dividers | Text; the only edge of a control |
| `--fl-border-strong` | The outline of a control whose edge is its only affordance (an off switch, an empty checkbox) | Dividers |
| `--fl-text` | Primary text and icons | |
| `--fl-muted` | Secondary text | Text on frosted material |
| `--fl-accent`, `--fl-accent-text` | The one primary action, selection, focus, success | Decoration; more than one filled button per surface |
| `--fl-accent-hover`, `--fl-accent-pressed` | Hover and pressed states of a filled accent control | |
| `--fl-accent-soft`, `--fl-accent-soft-strong` | Selected, and selected-and-hovered, backgrounds | Text |
| `--fl-success`, `--fl-success-text` | "Done" marks (the same green as the accent) | |
| `--fl-teal`, `--fl-teal-text` | Informational status | Actions |
| `--fl-blue`, `--fl-blue-text` | Links, neutral progress | |
| `--fl-warning`, `--fl-warning-text` | Needs attention, nothing lost yet | |
| `--fl-danger`, `--fl-danger-text` | Destructive actions, failures | Emphasis |
| `--fl-ai`, `--fl-ai-text`, `--fl-ai-ink`, `--fl-ai-soft` | AI-produced content, always with the sparkle | Anything else |
| `--fl-on-material-muted`, `--fl-on-material-accent` | Secondary text and accent marks on frosted material | Solid surfaces |
| `--fl-viewer-*` | The media viewer, neutral and dark in both themes | The rest of the app |
| `--fl-brand-gradient` | Brand moments only (decision 3), through `fl-brand-line` and `fl-brand-frame` | Everything else |
| `--fl-lime` | Light on glass (decision 4) | Light surfaces, fills, text |
| `--fl-scrim`, `--fl-scrim-blur` | The backdrop behind every modal surface | |

Status is never carried by colour alone: pair it with an icon or text.

### Type

Three ways to use a step: the class (`fl-type-title`), the pair
`font: var(--fl-type-title); letter-spacing: var(--fl-tracking-title);`, or just the size
(`--fl-font-hero`, `-display`, `-title`, `-headline`, `-size`, `-callout`, `-small`, `-micro`).
`fl-type-overline` is the uppercase section heading. `--fl-family-ui`, `--fl-family-mono`.

### Spacing, elevation, layers, controls

**Spacing** is a 4px grid: `--fl-space-half` (2), `-1` (4), `-2` (8), `-3` (12), `-4` (16), `-5` (20),
`-6` (24), `-8` (32), `-10` (40), `-12` (48), `-16` (64).

**Elevation**: `--fl-shadow-1` raised controls and cards, `-2` menus and toasts, `-3` floating
capsules, `-4` sheets and dialogs. Nothing else casts a shadow, and no shadow is coloured.

**Layers** (`--fl-z-*`): sticky 10, rail 20, popover 30, dock 35, scrim 40, modal 50, toast 60,
menu 70, tooltip 90.

**Controls**: 44px (`--fl-control-height`), 48px for touch (`--fl-control-height-touch`). The 34px
compact height (`--fl-control-height-compact`, with `--fl-radius-control-compact`) is opt-in for
desktop pointer layouts only.

### Materials

Frosted material is for things that float over photos: `fl-material` plus `fl-material-capsule`
(bars) or `fl-material-sheet` (floating cards). It turns solid under Increase Contrast and Reduce
Transparency. On material, use `--fl-text`, `--fl-on-material-muted` and `--fl-on-material-accent`
only. Modal backdrops use `--fl-scrim` with `--fl-scrim-blur` (the `fl-scrim` class for an ordinary
element).

### Where the classes work

`var(--fl-*)` works everywhere. The classes in `base.css` need a scope:

- `.frameleaf` (the shell, `<Theme>`, every dialog and toast): everything, including the element
  baseline (buttons, fields, headings) and the 44px floor.
- `.fl-scope` (the page area of the signed-in layout carries it): the classes only (`button`,
  `sr-only`, `muted` and every `fl-*`), and the primitives. No element already on a page is
  restyled. Inside it, the focus ring and height floor reach `.button`, `.fl-press` and
  `.fl-control` (the primitives mark their controls with it).

## 4. Motion

Seven patterns and one signature. Use the one that matches the surface; do not invent timings.

| Pattern | What it does | Use for | How |
| --- | --- | --- | --- |
| Press | Scale to 0.96 in 90ms, settle on the spring | Buttons, tiles | Automatic on `button` and `.button`; `fl-press` for other elements; `fl-no-press` for drag handles |
| Pop | Fade 150ms, grow from 0.9 on the 320ms spring from the anchor corner. Exit: fade 120ms | Menus, popovers, comboboxes | `fl-pop` (+ `fl-origin-top-end`, `-bottom-start`, `-bottom-end`, `-center`), `in:pop out:pop`, or `Menu` |
| Sheet | Fade 200ms, rise 40px and grow from 0.96 on the 480ms spring. Exit: 180ms | Dialogs, palettes, phone sheets | `Dialog`, `fl-sheet`, `in:sheet out:sheet` |
| Dock | Fade 200ms, rise 12px on the 420ms spring. Exit: 200ms | Selection bar, status bar, toasts, inspectors | `fl-dock`, `in:dock out:dock` (`y` for distance, negative from the top) |
| Reflow | FLIP on the 420ms spring, at most 120 tiles | Grid zoom, layout change, reorder | `animateFlip`, `animate:motionFlip` |
| Hero | View transition on the 520ms spring, 300ms root crossfade. Moving between sections is a 180ms page crossfade with no movement | Tile to viewer; card to page (album cover, person, Explore card); section changes | `viewer-zoom.ts`; `data-fl-shared` (below); `withViewTransition`; `sectionCrossfade` |
| Reveal | Fade 180ms, optional 30ms stagger up to 8 items | Skeleton to content, section entry, settings panes | `fl-reveal` (set `--i` for stagger), `in:reveal={{ index }}` |
| **Unfurl** | The signature (decision 6) | Marks only | `fl-unfurl`, `in:unfurl`, `Logo arrive` |

**Card to page.** Mark both ends with the same key and the root layout pairs them:

```svelte
<img data-fl-shared="album:{album.id}" ... />                      <!-- the card -->
<img data-fl-shared="album:{album.id}" data-fl-shared-page ... />  <!-- the page it opens -->
```

Rules:

- **Everything that opens also closes.** For an element removed by a Svelte block, use `out:`. For
  an element hidden by script (a native dialog, a popup kept mounted), call
  `leave(node, 'sheet' | 'pop' | 'dock' | 'reveal', done)` and hide it in `done`. With CSS only, add
  `fl-leaving` and remove the element when the animation ends.
- **Reduce Motion** turns every pattern, and Unfurl, into a 150ms opacity crossfade. The CSS classes
  and the helpers in `motion.ts` do this for you. Svelte `transition:` / `in:` / `out:` / `animate:`
  and `element.animate()` are not stopped by CSS, so they must go through `motion.ts` (the motion
  spec fails on a direct `svelte/transition` import) or check `prefersReducedMotion()`.
- **Durations and easings are tokens.** `--fl-motion-fast` (120), `--fl-motion` (180),
  `--fl-motion-slow` (240), `--fl-duration-fade` (200) with `--fl-ease` for opacity and colour;
  `--fl-duration`, `--fl-duration-pop`, `-dock`, `-sheet`, `-hero` with `--fl-spring` for movement;
  `--fl-snappy` for small moves and exits; `--fl-duration-unfurl` with `--fl-unfurl` for the
  signature. No literal milliseconds, no bare `ease`.
- Animate `transform`/`translate`/`scale`/`rotate` and `opacity`. Never animate layout properties
  on a grid of photos.
- Spinners and skeletons hold still under Reduce Motion; they do not disappear.

## 5. Primitives

All in `$lib/components/frameleaf/`. Text is always passed in translated.

| Component | Use | Props |
| --- | --- | --- |
| `Button` | Text button | `variant` (`default`, `primary`, `quiet`, `danger`), `type`, `disabled`, `pressed`, `label`, `initialFocus`, `onclick` |
| `IconButton` | Icon-only button or link | `label` (required), `variant`, `pressed`, `href`, `disabled`, `onclick` |
| `Menu`, `MenuItem` | Popup menu with full keyboard support and Pop motion | `label`, `align`, `bind:open`, `trigger`; item: `onSelect`, `checked`, `disabled`, `keepOpen` |
| `Dialog` | Modal sheet with Sheet motion in and out | `title`, `closeLabel`, `bind:open`, `returnFocus`, `onRequestClose`, `onClosed`, `wide`, `compactControls`, `actions` |
| `ConfirmDialog` | The one confirmation; open with `confirmFrameleaf()` | `title`, `prompt`, `confirmText`, `cancelText`, `danger`, `disabled` |
| `Toast` | Rendered by `toastManager`; do not mount directly. A done mark unfurls | |
| `InlineError` | A section failed; the page stays | `message`, `title`, `onRetry`, `retryLabel`, `retrying`, `compact`, `icon`, children for extra actions |
| `EmptyState` | Nothing here yet. Full size: the icon sits in the brand frame and unfurls. `compact`: plain | `message`, `icon`, `title`, `action`, `secondaryAction` (`{ label, onClick?, href?, icon? }`), `compact`, children |
| `Skeleton` | Loading placeholder | `variant` (`text`, `block`, `tile`, `circle`), `lines`, `width`, `height`, `aspect`, `thumbhash` |
| `Spinner` | The one ring spinner | `size` (icon size name or px), `label`, `decorative`, `delay` |
| `CountUp` | A number that counts up | `value`, `format`, `duration`, `delay` |
| `Badge` | Count or status marker, tabular | `value`, `label`, `tone` (`accent`, `teal`, `blue`, `warning`, `danger`, `neutral`, `ai`) |
| `Chip` | Active condition with optional removal | `label`, `removeLabel`, `onRemove`, `selected`, `leading` |
| `Toggle` | Switch with on/off text | `label`, `bind:checked`, `onLabel`, `offLabel`, `disabled`, `describedBy`, `onChange` |
| `SegmentedControl` | Mutually exclusive view choices | `label`, `options`, `bind:value`, `disabled`, `onChange` |
| `Pane` | Grouped card container | `label` |
| `Logo`, `Brand` | The brand mark (decision 9) | |
| `Theme` | A `.frameleaf` scope | `theme` |
| `FrameleafErrorPage` | Page-level error card | `title`, `message`, `code`, `icon`, `actions`, `standalone` |

Helpers:

```ts
import { confirmFrameleaf } from '$lib/frameleaf/confirm';
const ok = await confirmFrameleaf({ title, prompt, confirmText, danger: true });

import { toastUndo, toastAction } from '$lib/frameleaf/toast';
toastUndo($t('frameleaf_...'), () => restore(ids));
toastAction(message, { label, onAction, tone: 'info' });

import { toastManager } from '@frameleaf/ui'; // primary/success/info/warning/danger still work
```

Choosing a state:

- **Loading**: `Skeleton` when the shape is known, a thumbhash tile for photos, `Spinner` for an
  inline action, a progress bar when the length is known. Fade content in with `fl-reveal`.
- **Error**: `InlineError` in the section that failed. The full error page is for a page that
  cannot render at all.
- **Confirmation or Undo**: if the action can be reversed, do it and show `toastUndo`. Confirm only
  what cannot be undone, with `danger: true`.

## 6. Legacy kit

`@frameleaf/ui` and Tailwind utilities still draw parts of the app. They take the brand from one
place, `web/src/app.css`:

- the kit's `primary` ramp, status colours, text, border and surfaces map to the tokens;
- Tailwind `gray-*` and `neutral-*` are the Ink ramp, and `immich-*` colour utilities are the
  accent and surfaces;
- the app font is the Frameleaf stack; `rounded-lg`, `-xl`, `-2xl`, `-3xl` are the control, card,
  capsule and sheet corners;
- kit modals take the scrim, panel, sheet corner and Sheet entrance, and crossfade under Reduce
  Motion;
- `kit-bridge.ts` routes every toast to `Toast` and `modalManager.showDialog` to `ConfirmDialog`.

In new Frameleaf code, prefer the primitives above and `--fl-*` tokens over kit components and
colour utilities.

## 7. Accessibility

- **Contrast**: 4.5:1 for text, 3:1 for marks, outlines and focus. `tokens.spec.ts` proves every
  pair in both themes, including the Display P3 accent, the hover and pressed fills, text on
  frosted material over the brightest and darkest photograph, and the viewer.
- **Focus**: one ring, `--fl-focus-ring` (2px accent) at `--fl-focus-offset` (2px). It is applied
  to every `:focus-visible` inside `.frameleaf`, and to `.button`, `.fl-press` and `.fl-control`
  inside `.fl-scope`. Use `fl-focus-inset` for tiles, list rows and anything a container would
  clip. In the viewer the ring is lime. Never set `outline: none` without a visible replacement of
  at least 3:1.
- **Keyboard**: every pointer action has a keyboard path. Dialogs and menus return focus to what
  opened them; `Dialog` and `Menu` do this for you.
- **Touch**: 44px targets, 48px on coarse pointers. The token sheet enforces it for `button`,
  `input`, `select` and `summary`; links styled as buttons need `min-height: var(--fl-control-height)`.
- **Announcements**: results that arrive later use `role="status"` (polite) or `role="alert"`
  (errors). `InlineError`, `EmptyState`, `Spinner` and `Toast` do this.
- **Motion and transparency**: Reduce Motion, Increase Contrast and Reduce Transparency are
  honoured by the tokens and helpers. Do not bypass them.
- **Colour is never the only signal.** The gradient and the lime carry no meaning at all; they can
  be invisible to a reader and nothing is lost.

## 8. Do and do not

Do

- Use `--fl-*` tokens for colour, radius, spacing, type, elevation, layers and motion.
- Use one primary button per surface.
- Reuse a primitive before writing a new control.
- Give every surface that opens an exit.
- Put all text through `svelte-i18n`, in the voice of decision 10.
- Keep Leaf Light and Unfurl for the moments listed. Their rarity is the point.

Do not

- Write hex colours, literal radii, literal milliseconds or bare `ease` in component styles.
- Use Tailwind `gray`/`immich`/`primary` colour utilities in Frameleaf components.
- Add fallbacks that disagree with a token (`var(--fl-motion, 160ms)`, `var(--fl-canvas, #101416)`);
  tokens are always defined.
- Import from `svelte/transition` or call `matchMedia('(prefers-reduced-motion…)')` directly.
- Hand-roll a dialog, menu, spinner, toast or confirmation.
- Fill a control with the gradient, set text in it, or put it near a photograph.
- Use lime on a light surface, or the AI indigo, the accent or the danger colour for decoration.
- Spin, bounce or pulse the logo.
- Show a server message, status code or stack trace to a customer.

## 9. Brand decisions log

Each line can be overruled on its own. "Was" is the round 1 value.

| # | Decision | Was | Now | Overrule by |
| --- | --- | --- | --- | --- |
| 1a | Dark surfaces | `#101416` / `#171d21` / `#222a30` / `#303940` | `#0d1115` / `#141c21` / `#1f2830` / `#303b43` (Ink, hue 242) | Restoring the four values in `brand-tokens.json` and `tokens.css` |
| 1b | Light surfaces and text | `#f4f6f7` / `#eef1f3` / `#d6dce0`, text `#18252b`, muted `#53636d` | `#f3f6f8` / `#eaeef2` / `#d4dadf`, text `#0e1b24`, muted `#505e6a` | As above |
| 1c | Dark muted text | `#a1adb8` | `#9aa6b0` (the site's) | As above |
| 1d | Viewer raised surface | `#25272b` | `#262729` (neutral, under the chroma cap) | As above |
| 1e | New `border-strong` | none | `#64727d` in both themes | Removing the token; `Toggle` falls back to `--fl-muted` |
| 2a | Accent | `#22c55e` / `#157b40` | Unchanged, by decision | Choosing another green; the spec will say what else must move |
| 2b | Light P3 accent | `display-p3 0.1 0.5 0.26` | `display-p3 0.08 0.49 0.25` | Lightening light `raised` instead |
| 2c | Pressed and strong-soft accent states | none | `--fl-accent-pressed`, `--fl-accent-soft-strong` | Removing them |
| 3a | Brand gradient in product | Logo artwork only | `--fl-brand-gradient`, allowed in five listed moments | Emptying the allow-list in `tokens.spec.ts` |
| 3b | Navigation line | Solid accent | The gradient | One line in `NavigationLoadingBar.svelte` |
| 3c | Empty-state icon | Bare icon | In the gradient frame, unfurling (full size only) | The `compact` branch in `EmptyState.svelte` |
| 4 | Lime | Not used | On-material accent (dark) and viewer focus ring | Restoring `#8be9ab` and `#a5d4ef` |
| 5a | Heading tracking | -0.02 / -0.015 / -0.015em | -0.025 / -0.02 / -0.015em, `h1` follows display | `--fl-tracking-*` |
| 5b | `hero` type step | none | 40 / 1.05 / 600 / -0.035em | Removing the step |
| 5c | Micro step | 500, 0.02em | 600, 0.04em | `--fl-type-micro`, `--fl-tracking-micro` |
| 5d | Antialiased text | Browser default | Antialiased in the scope and on `body` | Two declarations in `tokens.css` and `app.css` |
| 6a | Signature motion | none | Unfurl | Removing `fl-unfurl` uses; the token can stay |
| 6b | Loading mark | Spins, 150px | Unfurls once, 64px, still | `app.html` |
| 6c | Thumbhash fade | 100ms | `--fl-motion` (180ms) | `tunables.ts` |
| 7 | Radii | 9 / 12 / 18 / 22 | 12 / 16 / 20 / 24, compact 9 (frame ratio) | The five numbers in `tokens.css` and `app.css` |
| 8a | AI text colour | Tile colour only | `--fl-ai-ink`, `--fl-ai-soft`, `Badge tone="ai"` | Removing them |
| 9a | Logo arrival | none | `arrive` prop on `Logo` and `Brand` (Unfurl), for sign-in and first run. Not used on the error page: an error is not an arrival | Dropping the prop from callers |
| 10 | Voice rules and rewrites | "write for customers" | The five rules and the pattern above; no string values changed | Editing section 2, decision 10 |
| 11 | One token document | `design/frameleaf/tokens.json` v2 beside `brand-tokens.json` v3 | The same v3 document in both, inventory regenerated | Restoring the v2 file and the old inventory entry |
| 12 | Page background (seen in the browser) | `body` painted the kit's `light`: panel white in the light theme, so pages were white with grey canvas blocks | `body` is `--fl-canvas` in both themes; rails, bars and cards are the white panel on it | The `body:not(.asset-viewer-open)` rule in `app.css` |
| 13 | Continuous corners on controls | `.button`, fields and `.chip` were squircles at 12px, which read as about 7px and did not match `Button` | Squircle for cards and sheets only; controls are plain 12px, chips are pills | The selector list under `@supports (corner-shape: squircle)` in `base.css` |
| 14 | Filled danger label | An unlayered global `.fl-danger` text-colour class painted the label in the fill colour | The label colour of `.button.fl-danger` is `!important` inside the layer, so it cannot be lost | Removing `!important` once no global `.fl-danger` rule remains |
| 15 | Control text in page content | Controls in `.fl-scope` inherited the document's 16px | `.button` and `.fl-control` in `.fl-scope` are the 14px body step, as in dialogs and the shell | The `.fl-scope` font-size rule in `base.css` |
| 16 | Removable chip height | The remove button's 44px floor made a removable chip 52px tall | The mark is 24px inside a 28px chip; a pseudo-element keeps the 44px target | The `button` rules in `Chip.svelte` |
| 17 | Page titles | The layout's title bar repeated the page's own `h1` on Explore, Memories, Tags, Folders, Best Photos, Documents and Studio projects | One title: the page's `h1` at the display step | Passing `title` to `UserPageLayout` again |
