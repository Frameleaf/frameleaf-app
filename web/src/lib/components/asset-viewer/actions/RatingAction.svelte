<script lang="ts">
  /**
   * The viewer's Rating tool (audit V-3), ported from `MediaViewer.jsx:1076-1125` and `RatingStars`
   * (2053-2085), styled after `.mv-popover`, `.mv-rating-popover` and `.mv-stars`
   * (media-viewer.css:131-240): a star button in the top row that opens five stars and Clear. Pressing
   * the current star again or Clear removes the rating; arrow keys move between the stars and Escape
   * closes the popover and returns focus to the button. The 1-5 keys rate, and 0 first returns a
   * zoomed photo to fit and only at fit clears the rating (MediaViewer.jsx:816-822).
   */
  import { shortcuts } from '$lib/actions/shortcut';
  import type { OnAction } from '$lib/components/asset-viewer/actions/action';
  import { AssetAction } from '$lib/constants';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import { toTimelineAsset } from '$lib/utils/timeline-util';
  import { updateAsset, type AssetResponseDto } from '@immich/sdk';
  import { Icon, IconButton } from '@immich/ui';
  import { mdiStar, mdiStarOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    asset: AssetResponseDto;
    onAction: OnAction;
  };

  let { asset, onAction }: Props = $props();

  const STARS = [1, 2, 3, 4, 5];

  let open = $state(false);
  let wrapper: HTMLDivElement | undefined = $state();
  let popover: HTMLDivElement | undefined = $state();
  /**
   * The toolbar scrolls sideways on narrow screens, which would clip an absolutely placed popover, so
   * it is placed against the window from the button's box: below it in the top row, above it in the
   * phone toolbar.
   */
  let placement = $state<{ top?: number; bottom?: number; right: number }>({ right: 0 });

  const place = () => {
    const button = wrapper?.querySelector<HTMLButtonElement>('button[aria-haspopup]');
    if (!button) {
      return;
    }
    const box = button.getBoundingClientRect();
    const right = Math.max(8, window.innerWidth - box.right);
    placement =
      box.top > window.innerHeight / 2
        ? { bottom: window.innerHeight - box.top + 6, right }
        : { top: box.bottom + 6, right };
  };

  const enabled = $derived(authManager.authenticated && authManager.preferences.ratings.enabled);
  const current = $derived.by(() => {
    const value = Number(asset.exifInfo?.rating ?? 0);
    return Number.isSafeInteger(value) && value >= 0 && value <= 5 ? value : 0;
  });
  const ratingText = $derived(
    current === 0 ? $t('frameleaf_viewer_not_rated') : $t('frameleaf_viewer_stars', { values: { count: current } }),
  );

  const focusButton = () => wrapper?.querySelector<HTMLButtonElement>('button[aria-haspopup]')?.focus();

  const close = (returnFocus: boolean) => {
    open = false;
    if (returnFocus) {
      focusButton();
    }
  };

  const rateAsset = async (rating: number | null) => {
    try {
      await updateAsset({
        id: asset.id,
        updateAssetDto: { rating },
      });

      asset = {
        ...asset,
        exifInfo: {
          ...asset.exifInfo,
          rating,
        },
      };

      onAction({
        type: AssetAction.RATING,
        asset: toTimelineAsset(asset),
        rating,
      });
    } catch (error) {
      handleError(error, $t('errors.unable_to_set_rating'));
    }
  };

  const choose = (star: number) => {
    close(true);
    // Pressing the current rating again clears it (RatingStars, MediaViewer.jsx:2068).
    void rateAsset(star === current ? null : star);
  };

  $effect(() => {
    if (open) {
      popover?.querySelector<HTMLButtonElement>('button[aria-pressed="true"], button')?.focus();
    }
  });

  const onPopoverKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const buttons = [...(popover?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[(index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
  };

  const onDocumentPointerDown = (event: PointerEvent) => {
    if (open && wrapper && !wrapper.contains(event.target as Node)) {
      open = false;
    }
  };
</script>

<svelte:window onresize={() => open && place()} />

<svelte:document
  onpointerdown={onDocumentPointerDown}
  use:shortcuts={enabled
    ? [
        {
          shortcut: { key: '0' },
          // 0 first returns a zoomed photo to fit; only at fit does it clear the rating.
          onShortcut: () => (assetViewerManager.zoom > 1 ? assetViewerManager.animatedZoom(1) : rateAsset(null)),
        },
        ...STARS.map((rating) => ({
          shortcut: { key: String(rating) },
          onShortcut: () => rateAsset(rating),
        })),
      ]
    : []}
/>

{#if enabled}
  <div class="fl-rating-wrap" bind:this={wrapper}>
    <IconButton
      color="secondary"
      shape="round"
      variant="ghost"
      icon={current ? mdiStar : mdiStarOutline}
      aria-label={$t('frameleaf_viewer_rating_label', { values: { rating: ratingText } })}
      title={$t('frameleaf_viewer_rating_label', { values: { rating: ratingText } })}
      aria-haspopup="true"
      aria-expanded={open}
      class={open || current > 0 ? 'fl-rating-active' : undefined}
      onclick={() => {
        if (!open) {
          place();
        }
        open = !open;
      }}
      data-testid="viewer-rating-button"
    />
    {#if open}
      <!-- The popover's arrow keys move between its stars and Escape returns to the tool (MediaViewer.jsx:1076-1125). -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div
        class="fl-rating-popover fl-continuous-corners"
        role="group"
        aria-label={$t('frameleaf_viewer_rate_item')}
        bind:this={popover}
        style:top={placement.top === undefined ? undefined : `${placement.top}px`}
        style:bottom={placement.bottom === undefined ? undefined : `${placement.bottom}px`}
        style:right="{placement.right}px"
        onkeydown={onPopoverKeydown}
      >
        <div class="fl-stars" role="group" aria-label={$t('frameleaf_info_rating')}>
          {#each STARS as star (star)}
            <button
              type="button"
              class:filled={star <= current}
              aria-label={$t('frameleaf_viewer_rate_stars', { values: { count: star } })}
              aria-pressed={star === current}
              onclick={() => choose(star)}
            >
              <Icon icon={star <= current ? mdiStar : mdiStarOutline} size="22" aria-hidden />
            </button>
          {/each}
          <button type="button" class="fl-stars-clear" disabled={!current} onclick={() => choose(current)}>
            {$t('clear')}
          </button>
        </div>
      </div>
    {/if}
  </div>
{/if}

<style>
  .fl-rating-wrap {
    position: relative;
  }

  .fl-rating-wrap :global(.fl-rating-active) {
    background: #ffffff12;
  }

  /* .mv-popover + .mv-rating-popover (media-viewer.css:131-192). */
  .fl-rating-popover {
    position: fixed;
    z-index: 6;
    padding: 10px 12px;
    background: var(--fl-viewer-raised);
    border: 1px solid var(--fl-viewer-border);
    border-radius: var(--fl-radius-card);
    box-shadow: var(--fl-shadow-2);
    animation: fl-rating-pop var(--fl-motion, 220ms) var(--fl-ease, ease);
  }

  @keyframes fl-rating-pop {
    from {
      opacity: 0;
      transform: translateY(-4px);
    }
  }

  /* .mv-stars (media-viewer.css:204-240). */
  .fl-stars {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .fl-stars button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    border: 0;
    border-radius: var(--fl-radius-control);
    background: none;
    color: var(--fl-viewer-muted);
    cursor: pointer;
    transition: transform var(--fl-motion-fast, 150ms) var(--fl-ease, ease);
  }

  .fl-stars button.filled {
    color: var(--fl-warning);
  }

  .fl-stars button:hover:not(:disabled) {
    transform: scale(1.12);
    color: var(--fl-warning);
  }

  .fl-stars .fl-stars-clear {
    width: auto;
    margin-left: 6px;
    padding: 0 10px;
    font: inherit;
    font-size: var(--fl-font-small);
    color: var(--fl-viewer-muted);
  }

  .fl-stars .fl-stars-clear:hover:not(:disabled) {
    transform: none;
    color: var(--fl-viewer-text);
    background: #ffffff0f;
  }

  .fl-stars .fl-stars-clear:disabled {
    cursor: default;
    opacity: 0.5;
  }

  @media (prefers-reduced-motion: reduce) {
    .fl-rating-popover {
      animation-name: fl-rating-fade;
    }

    .fl-stars button:hover:not(:disabled) {
      transform: none;
    }

    @keyframes fl-rating-fade {
      from {
        opacity: 0;
      }
    }
  }
</style>
