<script lang="ts">
  /**
   * Slideshow settings (FL-36), from the template's `SlideshowSettings` (MediaViewer.jsx:2086-2182):
   * photo duration, image fit, caption, order, transition, repeat and the progress bar, with
   * the prototype's copy. It is the Frameleaf Dialog rather than the prototype's inline popover
   * so it reads like every other sheet, and it is composed from the settings rows
   * (SettingSelect, SettingToggle). Changes apply at once, as in the prototype.
   */
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
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
  import { t, type Translations } from 'svelte-i18n';

  let { open = $bindable(false) }: { open?: boolean } = $props();

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

<Dialog title={$t('slideshow')} closeLabel={$t('frameleaf_slideshow_settings_close')} bind:open>
  <div class="slideshow-settings" data-testid="slideshow-settings">
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
      title={$t('frameleaf_slideshow_progress')}
      checked={$showProgressBar}
      onToggle={(checked) => ($showProgressBar = checked)}
    />
    <p class="slideshow-settings-help">{$t('frameleaf_slideshow_help')}</p>
  </div>
</Dialog>

<style>
  .slideshow-settings {
    display: flex;
    flex-direction: column;
    width: min(340px, calc(100vw - 80px));
  }
  /* MediaViewer.jsx:2179 / media-viewer.css:888-893 */
  .slideshow-settings-help {
    margin: 14px 0 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
    line-height: 1.5;
  }
</style>
