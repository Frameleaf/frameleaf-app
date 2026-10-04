<script lang="ts">
  /**
   * Slideshow settings (FL-36), the template's `SlideshowSettings` (MediaViewer.jsx:2086-2182,
   * media-viewer.css:822-893): a non-modal panel over the bottom-left of the running slideshow,
   * so the photo stays in view and a new transition shows on the next item. Photo duration,
   * image fit, caption, order, transition, repeat and the progress bar, with the prototype's
   * copy, built from the Frameleaf settings rows (SettingSelect, SettingToggle). Changes apply at
   * once. Escape or the close button hands focus back to the caller (`onClose`).
   *
   * Autoplay is not in the prototype; its row is kept because production has always had the
   * preference (source behaviour retained, recorded in the conformance audit).
   */
  import IconButton from '$lib/components/frameleaf/IconButton.svelte';
  import SettingSelect from '$lib/components/frameleaf/settings/SettingSelect.svelte';
  import SettingToggle from '$lib/components/frameleaf/settings/SettingToggle.svelte';
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
  import { Icon } from '@immich/ui';
  import { mdiClose } from '@mdi/js';
  import { onDestroy } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';
  import { get } from 'svelte/store';

  let { onClose }: { onClose: () => void } = $props();

  // Closing the viewer (or ending the slideshow) with the panel open leaves it closed next time.
  // MediaViewer.jsx:499-502: opening the panel puts focus on Photo duration.
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
    slideshowAutoplay,
    showProgressBar,
  } = slideshowStore;

  /** MediaViewer.jsx:2103 */
  const DURATIONS = [2, 3, 5, 10, 15, 30];

  const durationOptions = $derived(
    [...new Set([...DURATIONS, $slideshowDelay])]
      .filter((seconds) => Number.isFinite(seconds) && seconds > 0)
      .sort((a, b) => a - b)
      .map((seconds) => ({
        value: seconds,
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
  const setCaption = (value: string | number) => {
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
        value: transition,
        text:
          transition === DEFAULT_SLIDESHOW_TRANSITION
            ? $t('frameleaf_slideshow_transition_default', { values: { name } })
            : name,
      };
    }),
  );
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
  <SettingSelect
    label={$t('frameleaf_slideshow_duration')}
    value={$slideshowDelay}
    options={durationOptions}
    number
    onSelect={(value) => ($slideshowDelay = Number(value))}
  />
  <SettingSelect
    label={$t('frameleaf_slideshow_fit')}
    value={$slideshowLook}
    options={fitOptions}
    onSelect={(value) => ($slideshowLook = value as SlideshowLook)}
  />
  <SettingSelect
    label={$t('frameleaf_slideshow_caption')}
    value={caption}
    options={captionOptions}
    onSelect={setCaption}
  />
  <SettingSelect
    label={$t('frameleaf_slideshow_order')}
    value={$slideshowNavigation}
    options={orderOptions}
    onSelect={(value) => ($slideshowNavigation = value as SlideshowNavigation)}
  />
  <SettingSelect
    label={$t('frameleaf_slideshow_transition')}
    value={$slideshowTransition}
    options={transitionOptions}
    onSelect={(value) => ($slideshowTransition = parseSlideshowTransition(value))}
  />
  <SettingToggle
    title={$t('frameleaf_slideshow_repeat')}
    checked={$slideshowRepeat}
    onToggle={(checked) => ($slideshowRepeat = checked)}
  />
  <SettingToggle
    title={$t('autoplay_slideshow')}
    checked={$slideshowAutoplay}
    onToggle={(checked) => ($slideshowAutoplay = checked)}
  />
  <SettingToggle
    title={$t('frameleaf_slideshow_progress')}
    checked={$showProgressBar}
    onToggle={(checked) => ($showProgressBar = checked)}
  />
  <p class="slideshow-settings-help">{$t('frameleaf_slideshow_help')}</p>
</section>

<style>
  /* media-viewer.css:822-893 */
  .slideshow-settings {
    position: fixed;
    z-index: 5;
    bottom: 68px;
    left: 18px;
    display: flex;
    flex-direction: column;
    width: 340px;
    max-width: calc(100% - 36px);
    max-height: calc(100dvh - 152px);
    overflow-y: auto;
    padding: 16px 18px;
    color: var(--fl-viewer-text);
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
  .slideshow-settings header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 4px;
  }
  .slideshow-settings h2 {
    margin: 0;
    font-size: 15px;
    font-weight: 550;
  }
  /* MediaViewer.jsx:2179 / media-viewer.css:888-893 */
  .slideshow-settings-help {
    margin: 14px 0 0;
    color: var(--fl-viewer-muted);
    font-size: var(--fl-font-micro);
    line-height: 1.5;
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
