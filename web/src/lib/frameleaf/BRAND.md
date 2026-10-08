# Frameleaf design system

The reference for anyone building Frameleaf: the web app first, and the same decisions for the
website and the native apps. It says what the brand is, why each value is what it is, and how to use
it. The files it points to are the source of truth, and `tokens.spec.ts` fails if they drift.

| What | Where |
| --- | --- |
| Token source | `web/src/lib/frameleaf/brand-tokens.json` |
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

## 1. The design system

Frameleaf's web app follows the prototype in `design/frameleaf/template`: an Apple-style photo
library with quiet, compact chrome, one green accent for the one thing to do next, neutral surfaces
behind every photograph, and frosted materials for floating bars and sheets. The brand mark is the
brand kit's own artwork and is never redrawn, recoloured or animated beyond a fade.

Principles:

1. **Photos first.** The photograph is the only thing on screen allowed to be colourful by
   default. Chrome is quiet and compact; one saturated colour, one primary action per surface.
2. **Dark first, light equal.** Every colour is a role with a value per theme. Never write a
   colour that only works in one.
3. **Restraint.** No decorative gradients, glows, washes or logo motion. The accent and the
   prototype's spring are the only flourishes.
4. **Honest states.** Loading looks like what is coming, an error says what happened and offers a
   way on, an empty screen offers the action that fills it.
5. **Accessible by construction.** Contrast, focus, touch size and Reduce Motion are handled in the
   tokens and primitives, so using them is the easy path.

## 2. Values at a glance

- **Surfaces** are the prototype's: canvas, panel, raised and border per theme
  (`design/frameleaf/template/src/reference/tokens.css`). The viewer is dark in both themes.
- **Accent** is Leaf Green, `#22c55e` dark and `#157b40` light, with a Display P3 twin.
- **Radii** follow the prototype scale: 9px controls, 12px cards, 16px floating capsules, 22px
  sheets; 4px and 6px for badges and thumbnails.
- **Type** is the system stack (SF Pro on Apple devices, bundled Inter elsewhere) at 14px body,
  semibold headings. Counts use tabular figures.
- **Motion** is the September 24 prototype's spring and ease, in seven patterns (section 4). The
  logo fades in; nothing spins or overshoots on its own.
- **Voice** is plain, short, reassuring and specific. No system words (asset, job queue,
  endpoint), no exclamation marks, no blame.

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
- **Reduce Motion** turns every pattern into a 150ms opacity crossfade. The CSS classes
  and the helpers in `motion.ts` do this for you. Svelte `transition:` / `in:` / `out:` / `animate:`
  and `element.animate()` are not stopped by CSS, so they must go through `motion.ts` (the motion
  spec fails on a direct `svelte/transition` import) or check `prefersReducedMotion()`.
- **Durations and easings are tokens.** `--fl-motion-fast` (120), `--fl-motion` (180),
  `--fl-motion-slow` (240), `--fl-duration-fade` (200) with `--fl-ease` for opacity and colour;
  `--fl-duration`, `--fl-duration-pop`, `-dock`, `-sheet`, `-hero` with `--fl-spring` for movement;
  `--fl-snappy` for small moves and exits. No literal milliseconds, no bare `ease`.
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
| `Toast` | Rendered by `toastManager`; do not mount directly.  | |
| `InlineError` | A section failed; the page stays | `message`, `title`, `onRetry`, `retryLabel`, `retrying`, `compact`, `icon`, children for extra actions |
| `EmptyState` | Nothing here yet. Full size: the icon sits on a soft accent plate. `compact`: plain | `message`, `icon`, `title`, `action`, `secondaryAction` (`{ label, onClick?, href?, icon? }`), `compact`, children |
| `Skeleton` | Loading placeholder | `variant` (`text`, `block`, `tile`, `circle`), `lines`, `width`, `height`, `aspect`, `thumbhash` |
| `Spinner` | The one ring spinner | `size` (icon size name or px), `label`, `decorative`, `delay` |
| `CountUp` | A number that counts up | `value`, `format`, `duration`, `delay` |
| `Badge` | Count or status marker, tabular | `value`, `label`, `tone` (`accent`, `teal`, `blue`, `warning`, `danger`, `neutral`, `ai`) |
| `Chip` | Active condition with optional removal | `label`, `removeLabel`, `onRemove`, `selected`, `leading` |
| `Toggle` | Switch with on/off text | `label`, `bind:checked`, `onLabel`, `offLabel`, `disabled`, `describedBy`, `onChange` |
| `SegmentedControl` | Mutually exclusive view choices | `label`, `options`, `bind:value`, `disabled`, `onChange` |
| `Pane` | Grouped card container | `label` |
| `Logo`, `Brand` | The brand mark | |
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
- Tailwind `gray-*` and `neutral-*` are the Frameleaf neutral ramp, and `immich-*` colour utilities are the
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
  clip. In the viewer the ring is the viewer focus colour. Never set `outline: none` without a visible replacement of
  at least 3:1.
- **Keyboard**: every pointer action has a keyboard path. Dialogs and menus return focus to what
  opened them; `Dialog` and `Menu` do this for you.
- **Touch**: 44px targets, 48px on coarse pointers. The token sheet enforces it for `button`,
  `input`, `select` and `summary`; links styled as buttons need `min-height: var(--fl-control-height)`.
- **Announcements**: results that arrive later use `role="status"` (polite) or `role="alert"`
  (errors). `InlineError`, `EmptyState`, `Spinner` and `Toast` do this.
- **Motion and transparency**: Reduce Motion, Increase Contrast and Reduce Transparency are
  honoured by the tokens and helpers. Do not bypass them.
- **Colour is never the only signal.** Decoration carries no meaning at all; it can
  be invisible to a reader and nothing is lost.

## 8. Do and do not

Do

- Use `--fl-*` tokens for colour, radius, spacing, type, elevation, layers and motion.
- Use one primary button per surface.
- Reuse a primitive before writing a new control.
- Give every surface that opens an exit.
- Put all text through `svelte-i18n`, in the Frameleaf voice (section 2).

Do not

- Write hex colours, literal radii, literal milliseconds or bare `ease` in component styles.
- Use Tailwind `gray`/`immich`/`primary` colour utilities in Frameleaf components.
- Add fallbacks that disagree with a token (`var(--fl-motion, 160ms)`, `var(--fl-canvas, #101416)`);
  tokens are always defined.
- Import from `svelte/transition` or call `matchMedia('(prefers-reduced-motion…)')` directly.
- Hand-roll a dialog, menu, spinner, toast or confirmation.
- Fill a control with the gradient, set text in it, or put it near a photograph.
- Spin, bounce or pulse the logo.
- Show a server message, status code or stack trace to a customer.

## 9. Decisions log

2026-10-08: the owner rejected the proposed brand system (Ink surfaces, the Leaf Light gradient, the Unfurl motion, the lime highlight and the enlarged radius scale). The tokens follow the prototype again; the functional repairs from the PR 140 design review stay.
