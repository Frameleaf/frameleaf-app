<script lang="ts">
  /**
   * Frameleaf brand mark for the shell (FL-135).
   *
   * Sourced only from the authorized `design/frameleaf/brand-kit` originals; nothing here is
   * redrawn, recolored or re-exported. See docs/docs/developer/frameleaf-plan/06-brand-assets.md.
   *
   * `variant="icon"` always renders the transparent gradient symbol (`frameleaf-symbol.svg`),
   * which the brand kit documents as safe on any surface, light or dark.
   *
   * `variant="inline"` renders the full lockup:
   * - `theme="dark"` renders the authorized `frameleaf-logo-dark.svg`, whose near-white
   *   lettering is only ever placed on a dark surface, as supplied.
   * - `theme="light"` has no supplied dark-ink wordmark to fall back to (the kit ships no
   *   light-background wordmark at all), so it renders the symbol next to a plain-text
   *   "Frameleaf" label colored with the caller's `--fl-text` token instead of an image.
   *
   * `decorative` marks the mark `aria-hidden`/`alt=""` for callers (e.g. `TopBar`) that already
   * wrap it in an element carrying its own accessible name, so the name is never announced twice.
   */
  import logoDarkUrl from '../../assets/frameleaf/frameleaf-logo-dark.svg?url';
  import symbolUrl from '../../assets/frameleaf/frameleaf-symbol.svg?url';

  // Matches @immich/ui's `Logo` size scale so call sites that previously rendered the vendored
  // Immich mark at a given size render this mark at the same size.
  const sizeClasses = {
    tiny: 'h-8',
    small: 'h-10',
    medium: 'h-12',
    large: 'h-16',
    giant: 'h-24',
    landing: 'h-64',
  } as const;

  type Props = {
    variant?: 'icon' | 'inline';
    theme?: 'light' | 'dark';
    size?: keyof typeof sizeClasses;
    decorative?: boolean;
    class?: string;
  };

  let { variant = 'icon', theme = 'dark', size, decorative = false, class: className = '' }: Props = $props();

  const name = 'Frameleaf';
  const sizedClass = $derived([size ? sizeClasses[size] : '', className].filter(Boolean).join(' '));
</script>

{#if variant === 'icon'}
  <img src={symbolUrl} alt={decorative ? '' : name} aria-hidden={decorative || undefined} class={sizedClass} />
{:else if theme === 'dark'}
  <img src={logoDarkUrl} alt={decorative ? '' : name} aria-hidden={decorative || undefined} class={sizedClass} />
{:else}
  <span class="fl-logo-inline {sizedClass}">
    <img src={symbolUrl} alt="" aria-hidden="true" class="fl-logo-inline-symbol" />
    <span aria-hidden={decorative || undefined}>{name}</span>
  </span>
{/if}

<style>
  .fl-logo-inline {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--fl-text);
    font-weight: 600;
    font-size: 1.0625rem;
    white-space: nowrap;
  }
  .fl-logo-inline-symbol {
    height: 100%;
    width: auto;
  }
</style>
