<script lang="ts">
  /**
   * Slideshow settings (FL-36, VIEWER-P2), the template's `SlideshowSettings` (MediaViewer.jsx:2097-2194,
   * media-viewer.css:822-893): a small non-modal popover above the footer's left end, so the photo
   * stays in view and a new transition shows on the next item. Each row puts its label on the left and
   * its choice on the right: photo duration, image fit, caption, order and transition, then the Repeat
   * and progress-bar checkboxes and one line about videos. Changes apply at once. Escape or the close
   * button hands focus back to the caller (`onClose`).
   *
   * Play always plays (VIEWER-P1), so the old Autoplay switch is gone, as in the template.
   */
  import IconButton from '$lib/components/frameleaf/IconButton.svelte';
  import {
    DEFAULT_SLIDESHOW_TRANSITION,
    parseSlideshowTransition,
    SLIDESHOW_TRANSITIONS,
    SlideshowTransition,
  } from '$lib/frameleaf/slideshow-transitions';
  import {
    SlideshowLook,
    SlideshowMetadataOverlayMode,
    SlideshowNavigation,
    slideshowStore,
  } from '$lib/stores/slideshow.store';
  import { Icon } from '@frameleaf/ui';
  import { mdiClose } from '@mdi/js';
  import { onDestroy } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';
  import { get } from 'svelte/store';

  let { onClose }: { onClose: () => void } = $props();

  // Closing the viewer (or ending the slideshow) with the panel open leaves it closed next time.
  // MediaViewer.jsx:510-513: opening the panel puts focus on Photo duration.
  const focusFirstControl = (panel: HTMLElement) => {
    panel.querySelector<HTMLElement>('select')?.focus();
  };

  onDestroy(() => {
    if (get(slideshowStore.settingsOpen)) {
      void slideshowStore.closeSettings({ restoreFocus: false });
    }
  });

  const titleId = $props.id();

  const {
    slideshowDelay,
    slideshowLook,
    slideshowShowMetadataOverlay,
    slideshowMetadataOverlayMode,
    slideshowNavigation,
    slideshowTransition,
    slideshowRepeat,
    showProgressBar,
  } = slideshowStore;

  /** MediaViewer.jsx:2117 */
  const DURATIONS = [2, 3, 5, 10, 15, 30];

  const durationOptions = $derived(
    [...new Set([...DURATIONS, $slideshowDelay])]
      .filter((seconds) => Number.isFinite(seconds) && seconds > 0)
      .sort((a, b) => a - b)
      .map((seconds) => ({
        value: String(seconds),
        text: $t('frameleaf_slideshow_duration_seconds', { values: { count: seconds } }),
      })),
  );

  const fitOptions = $derived([
    { value: SlideshowLook.Contain, text: $t('frameleaf_slideshow_fit_contain') },
    { value: SlideshowLook.Cover, text: $t('frameleaf_slideshow_fit_cover') },
    { value: SlideshowLook.BlurredBackground, text: $t('frameleaf_slideshow_fit_blur') },
  ]);

  type Caption = 'off' | 'description' | 'details';
  const caption = $derived<Caption>(
    $slideshowShowMetadataOverlay
      ? $slideshowMetadataOverlayMode === SlideshowMetadataOverlayMode.DescriptionOnly
        ? 'description'
        : 'details'
      : 'off',
  );
  const captionOptions = $derived([
    { value: 'off', text: $t('frameleaf_slideshow_caption_off') },
    { value: 'description', text: $t('frameleaf_slideshow_caption_description') },
    { value: 'details', text: $t('frameleaf_slideshow_caption_details') },
  ]);
  const setCaption = (value: string) => {
    $slideshowShowMetadataOverlay = value !== 'off';
    if (value === 'description') {
      $slideshowMetadataOverlayMode = SlideshowMetadataOverlayMode.DescriptionOnly;
    } else if (value === 'details') {
      $slideshowMetadataOverlayMode = SlideshowMetadataOverlayMode.Full;
    }
  };

  const orderOptions = $derived([
    { value: SlideshowNavigation.AscendingOrder, text: $t('frameleaf_slideshow_order_ascending') },
    { value: SlideshowNavigation.DescendingOrder, text: $t('frameleaf_slideshow_order_descending') },
    { value: SlideshowNavigation.Shuffle, text: $t('frameleaf_slideshow_order_shuffle') },
  ]);

  const TRANSITION_LABEL: Record<SlideshowTransition, Translations> = {
    [SlideshowTransition.None]: 'frameleaf_slideshow_transition_none',
    [SlideshowTransition.Fade]: 'frameleaf_slideshow_transition_fade',
    [SlideshowTransition.Slide]: 'frameleaf_slideshow_transition_slide',
    [SlideshowTransition.KenBurns]: 'frameleaf_slideshow_transition_ken_burns',
    [SlideshowTransition.Memories]: 'frameleaf_slideshow_transition_memories',
  };
  const transitionOptions = $derived(
    SLIDESHOW_TRANSITIONS.map((transition) => {
      const name = $t(TRANSITION_LABEL[transition]);
      return {
        value: transition as string,
        text:
          transition === DEFAULT_SLIDESHOW_TRANSITION
            ? $t('frameleaf_slideshow_transition_default', { values: { name } })
            : name,
      };
    }),
  );

  type Row = {
    label: string;
    value: string;
    options: { value: string; text: string }[];
    onChange: (value: string) => void;
  };
  const rows = $derived<Row[]>([
    {
      label: $t('frameleaf_slideshow_duration'),
      value: String($slideshowDelay),
      options: durationOptions,
      onChange: (value) => ($slideshowDelay = Number(value)),
    },
    {
      label: $t('frameleaf_slideshow_fit'),
      value: $slideshowLook,
      options: fitOptions,
      onChange: (value) => ($slideshowLook = value as SlideshowLook),
    },
    { label: $t('frameleaf_slideshow_caption'), value: caption, options: captionOptions, onChange: setCaption },
    {
      label: $t('frameleaf_slideshow_order'),
      value: $slideshowNavigation,
      options: orderOptions,
      onChange: (value) => ($slideshowNavigation = value as SlideshowNavigation),
    },
    {
      label: $t('frameleaf_slideshow_transition'),
      value: $slideshowTransition,
      options: transitionOptions,
      onChange: (value) => ($slideshowTransition = parseSlideshowTransition(value)),
    },
  ]);
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<section
  class="frameleaf slideshow-settings fl-continuous-corners"
  data-theme="dark"
  data-testid="slideshow-settings"
  aria-labelledby={titleId}
  {@attach focusFirstControl}
  onkeydown={(event) => {
    if (event.key !== 'Escape') {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    onClose();
  }}
>
  <header>
    <h2 id={titleId}>{$t('slideshow')}</h2>
    <IconButton label={$t('frameleaf_slideshow_settings_close')} onclick={onClose}>
      <Icon icon={mdiClose} size="1.125rem" />
    </IconButton>
  </header>
  {#each rows as row (row.label)}
    <label class="slideshow-settings-row">
      <span>{row.label}</span>
      <select value={row.value} onchange={(event) => row.onChange(event.currentTarget.value)}>
        {#each row.options as option (option.value)}
          <option value={option.value}>{option.text}</option>
        {/each}
      </select>
    </label>
  {/each}
  <label class="slideshow-settings-check">
    <input
      type="checkbox"
      checked={$slideshowRepeat}
      onchange={(event) => ($slideshowRepeat = event.currentTarget.checked)}
    />
    <span>{$t('frameleaf_slideshow_repeat')}</span>
  </label>
  <label class="slideshow-settings-check">
    <input
      type="checkbox"
      checked={$showProgressBar}
      onchange={(event) => ($showProgressBar = event.currentTarget.checked)}
    />
    <span>{$t('frameleaf_slideshow_progress')}</span>
  </label>
  <p class="slideshow-settings-help">{$t('frameleaf_slideshow_help')}</p>
</section>

<style>
  /* media-viewer.css:822-837: above the footer's left end (and above the phone toolbar). */
  .slideshow-settings {
    position: fixed;
    z-index: 5;
    bottom: calc(var(--fl-viewer-toolbar-offset, 60px) + var(--fl-space-2));
    left: max(18px, env(safe-area-inset-left));
    width: 340px;
    max-width: calc(100% - 36px);
    max-height: calc(100dvh - 152px);
    overflow-y: auto;
    padding: var(--fl-space-4) 18px;
    color: var(--fl-viewer-text);
    /* The viewer is dark in both themes; the native lists and checkboxes follow it. */
    color-scheme: dark;
    background: var(--fl-viewer-raised);
    border: 1px solid var(--fl-viewer-border);
    border-radius: var(--fl-radius-card);
    box-shadow: var(--fl-shadow-2);
    animation: fl-slideshow-settings-pop var(--fl-motion) var(--fl-ease);
  }
  @supports (corner-shape: squircle) {
    .slideshow-settings {
      border-radius: calc(var(--fl-radius-card) * 1.8);
    }
  }
  /* media-viewer.css:838-851 */
  .slideshow-settings header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--fl-space-3);
    margin-bottom: var(--fl-space-1);
  }
  .slideshow-settings h2 {
    margin: 0;
    font-size: 15px;
    font-weight: 550;
  }
  /* media-viewer.css:852-874: label on the left, its choice on the right. */
  .slideshow-settings-row {
    display: flex;
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    gap: var(--fl-space-4);
    margin: 10px 0;
    font-size: var(--fl-font-small);
  }
  .slideshow-settings-row select {
    appearance: auto;
    min-width: 156px;
    max-width: 190px;
    min-height: 34px;
    padding: 6px var(--fl-space-2);
    color: var(--fl-viewer-text);
    background: var(--fl-viewer-panel);
    border: 1px solid var(--fl-viewer-border);
    border-radius: var(--fl-radius-control);
    font: inherit;
    font-size: var(--fl-font-small);
    cursor: pointer;
  }
  .slideshow-settings-row select:focus-visible,
  .slideshow-settings-check input:focus-visible {
    outline: 2px solid var(--fl-viewer-focus);
    outline-offset: var(--fl-focus-offset);
  }
  /* media-viewer.css:875-887 */
  .slideshow-settings-check {
    display: flex;
    align-items: center;
    gap: 9px;
    min-height: 34px;
    font-size: var(--fl-font-small);
    cursor: pointer;
  }
  .slideshow-settings-check input {
    width: 16px;
    height: 16px;
    margin: 0;
    accent-color: var(--fl-accent);
    cursor: pointer;
  }
  /* MediaViewer.jsx:2191 / media-viewer.css:888-893 */
  .slideshow-settings-help {
    margin: 14px 0 0;
    color: var(--fl-viewer-muted);
    font-size: var(--fl-font-micro);
    line-height: 1.5;
  }
  /* Touch keeps the 44px targets. */
  @media (pointer: coarse) {
    .slideshow-settings-row select,
    .slideshow-settings-check {
      min-height: var(--fl-control-height);
    }
  }
  /* media-viewer.css:2083-2087 */
  @media (max-width: 700px) {
    .slideshow-settings {
      left: max(10px, env(safe-area-inset-left));
      max-width: calc(100% - 20px);
    }
  }
  /* media-viewer.css:193-202 (mv-pop) */
  @keyframes fl-slideshow-settings-pop {
    from {
      opacity: 0;
      transform: translateY(-4px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
  /* Reduce Motion: a plain crossfade, no slide */
  @keyframes fl-slideshow-settings-fade {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .slideshow-settings {
      animation: fl-slideshow-settings-fade 150ms ease;
    }
  }
</style>
