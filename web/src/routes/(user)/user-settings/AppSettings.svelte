<script lang="ts">
  /**
   * Your preferences → App settings (FL-71 CC-50): the same device preferences as before, in the
   * Frameleaf setting rows (`SettingToggle`, `SettingSelect`) instead of the upstream `Field`,
   * `Switch` and Combobox controls.
   */
  import SettingSelect from '$lib/components/frameleaf/settings/SettingSelect.svelte';
  import SettingToggle from '$lib/components/frameleaf/settings/SettingToggle.svelte';
  import { invalidateAll } from '$app/navigation';
  import { fallbackLocale, locales } from '$lib/constants';
  import {
    alwaysLoadOriginalFile,
    alwaysLoadOriginalVideo,
    autoPlayVideo,
    lang,
    locale,
    loopVideo,
    playVideoThumbnailOnHover,
    showDeleteModal,
  } from '$lib/stores/preferences.store';
  import { createDateFormatter, findLocale } from '$lib/utils';
  import { convertBCP47, getClosestAvailableLocale, langCodes, langs } from '$lib/utils/i18n';
  import { Theme, themeManager, ThemePreference } from '@immich/ui';
  import { onMount } from 'svelte';
  import { locale as i18nLocale, t } from 'svelte-i18n';

  let time = $state(new Date());

  onMount(() => {
    const interval = setInterval(() => {
      time = new Date();
    }, 1000);

    return () => {
      clearInterval(interval);
    };
  });

  const languageOptions = langs.map((entry) => ({ text: entry.name, value: convertBCP47(entry.code) }));
  const language = $derived(getClosestAvailableLocale([$lang], langCodes));
  const onLanguage = async (value: string | number) => {
    $lang = String(value);
    await i18nLocale.set(convertBCP47(String(value)));
    await invalidateAll();
  };

  const localeOptions = locales
    .filter(({ code }) => Intl.NumberFormat.supportedLocalesOf(code).length > 0)
    .map(({ name, code }) => ({ text: name, value: code }));

  let editedLocale = $derived(findLocale($locale).code);
  let selectedDate: string = $derived(createDateFormatter(editedLocale).formatDateTime(time));
  const customLocale = $derived(findLocale(editedLocale).code || fallbackLocale.code);

  const handleToggleSystemTheme = (checked: boolean) => {
    const current = themeManager.value === Theme.Dark ? ThemePreference.Dark : ThemePreference.Light;
    themeManager.setPreference(checked ? ThemePreference.System : current);
  };
</script>

<section class="app-settings">
  <SettingToggle
    title={$t('theme_selection')}
    subtitle={$t('theme_selection_description')}
    checked={themeManager.preference === ThemePreference.System}
    onToggle={handleToggleSystemTheme}
  />

  <SettingSelect
    label={$t('language')}
    desc={$t('language_setting_description')}
    value={language}
    options={languageOptions}
    onSelect={onLanguage}
  />

  <SettingToggle
    title={$t('use_browser_locale')}
    subtitle={$t('use_browser_locale_description')}
    checked={$locale === 'default'}
    onToggle={(checked) => ($locale = checked ? 'default' : fallbackLocale.code)}
  >
    <p class="sample">{selectedDate}</p>
  </SettingToggle>

  {#if $locale !== 'default'}
    <SettingSelect
      label={$t('custom_locale')}
      desc={$t('custom_locale_description')}
      value={customLocale}
      options={localeOptions}
      onSelect={(value) => ($locale = String(value))}
    />
  {/if}

  <SettingToggle
    title={$t('display_original_photos')}
    subtitle={$t('display_original_photos_setting_description')}
    bind:checked={$alwaysLoadOriginalFile}
  />
  <SettingToggle
    title={$t('video_hover_setting')}
    subtitle={$t('video_hover_setting_description')}
    bind:checked={$playVideoThumbnailOnHover}
  />
  <SettingToggle
    title={$t('setting_video_viewer_auto_play_title')}
    subtitle={$t('setting_video_viewer_auto_play_subtitle')}
    bind:checked={$autoPlayVideo}
  />
  <SettingToggle title={$t('loop_videos')} subtitle={$t('loop_videos_description')} bind:checked={$loopVideo} />
  <SettingToggle
    title={$t('play_original_video')}
    subtitle={$t('play_original_video_setting_description')}
    bind:checked={$alwaysLoadOriginalVideo}
  />
  <SettingToggle
    title={$t('permanent_deletion_warning')}
    subtitle={$t('permanent_deletion_warning_setting_description')}
    bind:checked={$showDeleteModal}
  />
</section>

<style>
  .app-settings {
    display: grid;
    gap: 0.25rem;
    margin: 0.5rem 0;
  }
  .sample {
    margin: 0.375rem 0 0;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
</style>
