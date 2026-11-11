<script lang="ts">
  import BrokenAsset from '$lib/components/assets/BrokenAsset.svelte';
  import Image from '$lib/components/Image.svelte';
  import { Icon } from '@frameleaf/ui';
  import { mdiEyeOffOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import type { ClassValue } from 'svelte/elements';

  interface Props {
    url: string;
    altText: string | undefined;
    title?: string | null;
    heightStyle?: string | undefined;
    widthStyle: string;
    curve?: boolean;
    shadow?: boolean;
    circle?: boolean;
    hidden?: boolean;
    border?: boolean;
    highlighted?: boolean;
    hiddenIconClass?: string;
    class?: ClassValue;
    brokenAssetClass?: ClassValue;
    /** What the tile says when the picture can't be shown; "Error loading image" unless given. */
    brokenLabel?: string;
    /**
     * FL-1409: the photo is still waiting for its thumbnail. Until it loads the tile is a calm, slowly moving
     * placeholder, never the broken-image tile, and it asks for the picture again by itself.
     */
    pending?: boolean;
    preload?: boolean;
    onComplete?: ((errored: boolean) => void) | undefined;
  }

  let {
    url,
    altText,
    title = null,
    heightStyle = undefined,
    widthStyle,
    curve = false,
    shadow = false,
    circle = false,
    hidden = false,
    border = false,
    highlighted = false,
    hiddenIconClass = 'text-white',
    onComplete = undefined,
    class: imageClass = '',
    brokenAssetClass = '',
    brokenLabel = undefined,
    pending = false,
    preload = true,
  }: Props = $props();

  /** A photo that is getting ready is asked for again this often. */
  const PENDING_RETRY_MS = 30_000;

  let phase = $state<'loading' | 'loaded' | 'error'>('loading');
  let attempt = $state(0);
  $effect(() => {
    void url;
    phase = 'loading';
    attempt = 0;
  });
  // Its thumbnail may be ready by now: a new address, so the browser asks the server again.
  const source = $derived(attempt > 0 ? `${url}${url.includes('?') ? '&' : '?'}retry=${attempt}` : url);
  $effect(() => {
    if (phase !== 'error' || !pending) {
      return;
    }
    const timer = setTimeout(() => {
      attempt += 1;
      phase = 'loading';
    }, PENDING_RETRY_MS);
    return () => clearTimeout(timer);
  });

  const setLoaded = () => {
    phase = 'loaded';
    onComplete?.(false);
  };

  const setErrored = () => {
    phase = 'error';
    onComplete?.(true);
  };

  let sharedClasses = $derived([
    curve && 'rounded-xl',
    circle && 'rounded-full',
    shadow && 'shadow-lg',
    (circle || !heightStyle) && 'aspect-square',
    border && 'border-3 border-immich-dark-primary/80 hover:border-immich-primary',
    'transition-shadow duration-150',
    highlighted && 'ring-4 ring-immich-primary dark:ring-immich-dark-primary',
    hidden && 'grayscale-50 opacity-50',
  ]);

  let style = $derived(`width: ${widthStyle}; height: ${heightStyle ?? ''};`);
</script>

{#if phase === 'error' && pending}
  <span
    data-thumbnail-pending
    class={['fl-thumb-pending', sharedClasses, imageClass, brokenAssetClass]}
    style:display="block"
    style:width={widthStyle}
    style:height={heightStyle}
    role="img"
    aria-label={$t('frameleaf_thumbnail_pending')}
  ></span>
{:else if phase === 'error'}
  <BrokenAsset class={[sharedClasses, brokenAssetClass]} width={widthStyle} height={heightStyle} label={brokenLabel} />
{:else}
  <Image
    src={source}
    onLoad={setLoaded}
    onError={setErrored}
    class={[
      'object-cover',
      pending && phase === 'loading' ? 'fl-thumb-pending' : 'bg-gray-300 dark:bg-gray-700',
      sharedClasses,
      imageClass,
    ]}
    {style}
    alt={phase === 'loaded' ? altText : ''}
    draggable={false}
    title={title ?? undefined}
    loading={preload ? 'eager' : 'lazy'}
  />
{/if}

{#if hidden}
  <div class="absolute inset-s-1/2 top-1/2 translate-[-50%] transform">
    <!-- TODO fix `title` type -->
    <Icon title={title ?? undefined} icon={mdiEyeOffOutline} size="2em" class={hiddenIconClass} />
  </div>
{/if}

<style>
  /*
   * FL-1409 (prototype messy-1110.css `.at-pending`): a photo that is getting ready. The tile's own fill with a
   * slow band of light across it; still under reduced motion. Global: the loading <img> is Image.svelte's element.
   */
  :global(.fl-thumb-pending) {
    background: linear-gradient(
        100deg,
        transparent 30%,
        color-mix(in srgb, var(--fl-text, rgb(127 127 127)) 5%, transparent) 50%,
        transparent 70%
      )
      0 0 / 220% 100% var(--fl-panel, rgb(127 127 127 / 0.12));
    animation: fl-thumb-pending 1.8s linear infinite;
  }
  @keyframes -global-fl-thumb-pending {
    to {
      background-position: -220% 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    :global(.fl-thumb-pending) {
      animation: none;
    }
  }
</style>
