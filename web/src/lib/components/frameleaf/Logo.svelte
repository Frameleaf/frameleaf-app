<script lang="ts">
  /**
   * The Frameleaf brand mark (FL-135), and the one place its usage rules live.
   *
   * Sourced only from the authorized `design/frameleaf/brand-kit` originals; nothing here is
   * redrawn, recolored or re-exported.
   *
   * Which artwork is drawn follows from three props:
   *
   * `variant`
   * - `symbol` (or the earlier name `icon`): the leaf-in-frame symbol alone, for compact
   *   branding. The transparent gradient symbol (`frameleaf-symbol.svg`) is safe on any surface.
   * - `lockup` (or `inline`): the symbol with the wordmark.
   *
   * `surface` (or the earlier name `theme`): what the mark sits on, not the app theme.
   * - `dark`: the authorized `frameleaf-logo-dark.svg`, whose near-white lettering is only ever
   *   placed on a dark surface, as supplied.
   * - `light`: the kit ships no dark-ink wordmark, so the lockup is the symbol next to a
   *   plain-text "Frameleaf" in the caller's `--fl-text`. A white wordmark never goes on a
   *   light surface.
   * - `auto`: follows the app theme, for a mark that sits on the canvas or a panel.
   *
   * `mono`: the single-colour white artwork (`frameleaf-symbol-white.svg`,
   * `frameleaf-logo-white.svg`), for a dark surface where the gradient would compete: over a
   * photograph or the viewer. There is no mono artwork for a light surface, so `mono` is ignored
   * there and the light rules above apply.
   *
   * Size and space: `size` picks a height; `LOGO_MIN_HEIGHT` (tokens.ts) is enforced as a floor; `clearSpace`
   * pads the mark by a quarter of its height on every side so neighbours keep their distance.
   *
   * `arrive` fades the mark in once as it appears, for the moments Frameleaf introduces itself:
   * sign-in and first run. Never in the top bar, never on an error.
   *
   * `decorative` marks the mark `aria-hidden`/`alt=""` for callers (e.g. `TopBar`) that already
   * wrap it in an element carrying its own accessible name, so the name is never announced twice.
   */
  import { LOGO_CLEAR_SPACE, LOGO_MIN_HEIGHT } from '$lib/frameleaf/tokens';
  import { Theme as AppTheme, themeManager } from '@frameleaf/ui';
  import logoDarkUrl from '../../assets/frameleaf/frameleaf-logo-dark.svg?url';
  import logoWhiteUrl from '../../assets/frameleaf/frameleaf-logo-white.svg?url';
  import symbolWhiteUrl from '../../assets/frameleaf/frameleaf-symbol-white.svg?url';
  import symbolUrl from '../../assets/frameleaf/frameleaf-symbol.svg?url';

  // Matches @frameleaf/ui's `Logo` size scale so call sites that previously rendered the vendored
  // Immich mark at a given size render this mark at the same size.
  const sizeClasses = {
    tiny: 'h-8',
    small: 'h-10',
    medium: 'h-12',
    large: 'h-16',
    giant: 'h-24',
    landing: 'h-64',
  } as const;
  /** The same scale in px, to work out the clear space. */
  const sizeHeights = { tiny: 32, small: 40, medium: 48, large: 64, giant: 96, landing: 256 } as const;

  type Surface = 'light' | 'dark' | 'auto';

  type Props = {
    variant?: 'symbol' | 'lockup' | 'icon' | 'inline';
    surface?: Surface;
    /** The earlier name for `surface`; `surface` wins when both are given. */
    theme?: 'light' | 'dark';
    mono?: boolean;
    size?: keyof typeof sizeClasses;
    clearSpace?: boolean;
    /** Fade the mark in once as it appears (sign-in, first run). */
    arrive?: boolean;
    decorative?: boolean;
    class?: string;
  };

  let {
    variant = 'symbol',
    surface,
    theme = 'dark',
    mono = false,
    size,
    clearSpace = false,
    arrive = false,
    decorative = false,
    class: className = '',
  }: Props = $props();

  const name = 'Frameleaf';
  const sizedClass = $derived([size ? sizeClasses[size] : '', className].filter(Boolean).join(' '));
  const symbolOnly = $derived(variant === 'symbol' || variant === 'icon');
  const onDark = $derived.by(() => {
    const requested: Surface = surface ?? theme;
    return requested === 'auto' ? themeManager.value === AppTheme.Dark : requested === 'dark';
  });
  // Mono exists only as white artwork, so only on a dark surface.
  const white = $derived(mono && onDark);
  const padding = $derived(clearSpace ? `${sizeHeights[size ?? 'tiny'] * LOGO_CLEAR_SPACE}px` : undefined);
</script>

{#if symbolOnly}
  <img
    src={white ? symbolWhiteUrl : symbolUrl}
    alt={decorative ? '' : name}
    aria-hidden={decorative || undefined}
    class="fl-logo-symbol {sizedClass}"
    class:fl-logo-clear={clearSpace}
    class:fl-logo-arrive={arrive}
    style:min-height="{LOGO_MIN_HEIGHT.symbol}px"
    style:padding
  />
{:else if onDark}
  <img
    src={white ? logoWhiteUrl : logoDarkUrl}
    alt={decorative ? '' : name}
    aria-hidden={decorative || undefined}
    class="fl-logo-lockup {sizedClass}"
    class:fl-logo-clear={clearSpace}
    class:fl-logo-arrive={arrive}
    style:min-height="{LOGO_MIN_HEIGHT.lockup}px"
    style:padding
  />
{:else}
  <span
    class="fl-logo-inline {sizedClass}"
    class:fl-logo-clear={clearSpace}
    class:fl-logo-arrive={arrive}
    style:min-height="{LOGO_MIN_HEIGHT.lockup}px"
    style:padding
  >
    <img src={symbolUrl} alt="" aria-hidden="true" class="fl-logo-inline-symbol" />
    <span aria-hidden={decorative || undefined}>{name}</span>
  </span>
{/if}

<style>
  .fl-logo-symbol,
  .fl-logo-lockup {
    width: auto;
    max-width: 100%;
  }
  /* Clear space is padding outside the drawn height (a quarter of it, set inline). */
  .fl-logo-clear {
    box-sizing: content-box;
  }
  .fl-logo-inline {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--fl-text);
    /* The name beside the symbol, set as the wordmark is drawn: semibold and tight. */
    font-weight: 600;
    font-size: 1.0625rem;
    letter-spacing: var(--fl-tracking-title);
    white-space: nowrap;
  }
  .fl-logo-inline-symbol {
    height: 100%;
    width: auto;
  }
  /* The mark fades in once (base.css keyframes); important so it outranks the global clamp. */
  .fl-logo-arrive {
    animation: fl-fade-in var(--fl-motion-slow) var(--fl-ease) both;
  }
  @media (prefers-reduced-motion: reduce) {
    .fl-logo-arrive {
      animation: fl-fade-in var(--fl-duration-reduced) var(--fl-ease) both !important;
    }
  }
</style>
