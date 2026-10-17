<script lang="ts">
  /**
   * Your preferences › Look & playback (FL-368, after the approved prototype
   * `settings-v2/server/preferences.jsx`): the same device preferences as before in four headed
   * groups, with the theme and the date format each as one choice instead of a switch and a field.
   *
   * Everything here but "Show albums" and "Show archived photos in search" is kept on this device and
   * applies as it is chosen, as it always has. Those two are account preferences and keep the Save
   * bar. ACCOUNT-P3 added "Use less movement", "Open the library in", "Show file names in Work view"
   * and "Show archived photos in search", and moved "Dates and numbers" up to Appearance.
   */
  import { invalidateAll } from '$app/navigation';
  import SegmentedControl from '$lib/components/frameleaf/SegmentedControl.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Select from '$lib/components/frameleaf/settings/kit/Select.svelte';
  import Switch from '$lib/components/frameleaf/settings/kit/Switch.svelte';
  import OwnPreferencesForm from '$lib/components/frameleaf/settings/OwnPreferencesForm.svelte';
  import { fallbackLocale, locales } from '$lib/constants';
  import { libraryGridPreferences } from '$lib/frameleaf/library-grid-preferences.svelte';
  import {
    DEFAULT_LIBRARY_LAYOUT,
    LIBRARY_LAYOUTS,
    libraryPreferenceKey,
    type LibraryLayout,
  } from '$lib/frameleaf/library-session';
  import { createOwnPreferencesDraft } from '$lib/frameleaf/own-preferences-draft';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import {
    alwaysLoadOriginalFile,
    alwaysLoadOriginalVideo,
    autoPlayVideo,
    lang,
    libraryStartLayout,
    locale,
    loopVideo,
    playVideoThumbnailOnHover,
    showDeleteModal,
  } from '$lib/stores/preferences.store';
  import { reduceMotion } from '$lib/stores/reduce-motion.store';
  import { createDateFormatter, findLocale } from '$lib/utils';
  import { convertBCP47, getClosestAvailableLocale, langCodes, langs } from '$lib/utils/i18n';
  import { AssetOrder } from '@frameleaf/sdk';
  import { ThemePreference, themeManager } from '@frameleaf/ui';
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

  const languageOptions = langs.map((entry) => ({ label: entry.name, value: convertBCP47(entry.code) }));
  const language = $derived(getClosestAvailableLocale([$lang], langCodes));
  const onLanguage = async (value: string) => {
    $lang = value;
    await i18nLocale.set(convertBCP47(value));
    await invalidateAll();
  };

  const localeOptions = locales
    .filter(({ code }) => Intl.NumberFormat.supportedLocalesOf(code).length > 0)
    .map(({ name, code }) => ({ label: name, value: code }));

  let editedLocale = $derived(findLocale($locale).code);
  let sample: string = $derived(createDateFormatter(editedLocale).formatDateTime(time));
  const customLocale = $derived(findLocale(editedLocale).code || fallbackLocale.code);

  // The two account preferences on this page; "Show archived photos in search" is ACCOUNT-P3.
  const albums = createOwnPreferencesDraft(['albums.defaultAssetOrder', 'search.includeArchived']);

  /**
   * ACCOUNT-P3: until "Open the library in" is chosen, the library opens in the layout used last on
   * this device, so the choice shows that one.
   */
  const lastLayout = $derived.by((): LibraryLayout => {
    try {
      const stored = JSON.parse(localStorage.getItem(libraryPreferenceKey(authManager.user.id)) ?? 'null');
      return LIBRARY_LAYOUTS.includes(stored?.layout) ? stored.layout : DEFAULT_LIBRARY_LAYOUT;
    } catch {
      return DEFAULT_LIBRARY_LAYOUT;
    }
  });
</script>

<!-- The Save bar is for the account preferences ("Show albums", "Show archived photos in search"); the rest of the page is kept on this device as it is chosen. -->
<OwnPreferencesForm store={albums}>
  <KitPage>
    <Section
      title={$t('frameleaf_prefs_look_appearance')}
      description={$t('frameleaf_prefs_look_appearance_description')}
    >
      <Row
        label={$t('frameleaf_prefs_look_theme')}
        help={themeManager.preference === ThemePreference.System
          ? $t('frameleaf_prefs_look_theme_help_device')
          : $t('frameleaf_prefs_look_theme_help_chosen')}
      >
        <SegmentedControl
          label={$t('frameleaf_prefs_look_theme')}
          options={[
            { value: ThemePreference.System, label: $t('frameleaf_prefs_look_theme_device') },
            { value: ThemePreference.Light, label: $t('frameleaf_prefs_look_theme_light') },
            { value: ThemePreference.Dark, label: $t('frameleaf_prefs_look_theme_dark') },
          ]}
          value={themeManager.preference}
          onChange={(value) => themeManager.setPreference(value as ThemePreference)}
        />
      </Row>
      <Row label={$t('frameleaf_prefs_look_language')} help={$t('frameleaf_prefs_look_language_help')}>
        <Select
          label={$t('frameleaf_prefs_look_language')}
          value={languageOptions.some((option) => option.value === language) ? (language ?? 'en') : 'en'}
          options={languageOptions}
          onChange={onLanguage}
        />
      </Row>
      <Row
        label={$t('frameleaf_prefs_look_dates')}
        help={$t('frameleaf_prefs_look_dates_help', { values: { sample } })}
      >
        <SegmentedControl
          label={$t('frameleaf_prefs_look_dates')}
          options={[
            { value: 'device', label: $t('frameleaf_prefs_look_dates_device') },
            { value: 'region', label: $t('frameleaf_prefs_look_dates_region') },
          ]}
          value={$locale === 'default' ? 'device' : 'region'}
          onChange={(value) => ($locale = value === 'device' ? 'default' : fallbackLocale.code)}
        />
        {#if $locale !== 'default'}
          <Select
            label={$t('frameleaf_prefs_look_region')}
            value={customLocale}
            options={localeOptions}
            onChange={(value) => ($locale = value)}
          />
        {/if}
      </Row>
      <Row label={$t('frameleaf_prefs_look_motion')} help={$t('frameleaf_prefs_look_motion_help')}>
        <Switch
          label={$t('frameleaf_prefs_look_motion')}
          checked={$reduceMotion}
          onChange={(value) => ($reduceMotion = value)}
        />
      </Row>
    </Section>

    <Section title={$t('frameleaf_prefs_look_browsing')}>
      <Row label={$t('frameleaf_prefs_look_start')} help={$t('frameleaf_prefs_look_start_help')}>
        <SegmentedControl
          label={$t('frameleaf_prefs_look_start')}
          options={[
            { value: 'timeline', label: $t('frameleaf_library_layout_timeline') },
            { value: 'browse', label: $t('frameleaf_library_layout_browse') },
            { value: 'work', label: $t('frameleaf_library_layout_work') },
          ]}
          value={$libraryStartLayout ?? lastLayout}
          onChange={(value) => ($libraryStartLayout = value as LibraryLayout)}
        />
      </Row>
      <Row label={$t('frameleaf_prefs_look_albums')} help={$t('frameleaf_prefs_look_albums_help')}>
        <SegmentedControl
          label={$t('frameleaf_prefs_look_albums')}
          options={[
            { value: AssetOrder.Desc, label: $t('newest_first') },
            { value: AssetOrder.Asc, label: $t('oldest_first') },
          ]}
          value={albums.draft['albums.defaultAssetOrder']}
          onChange={(value) => albums.set('albums.defaultAssetOrder', value as AssetOrder)}
        />
      </Row>
      <Row label={$t('frameleaf_prefs_look_file_names')} help={$t('frameleaf_prefs_look_file_names_help')}>
        <Switch
          label={$t('frameleaf_prefs_look_file_names')}
          checked={libraryGridPreferences.showFileNames}
          onChange={(value) => (libraryGridPreferences.showFileNames = value)}
        />
      </Row>
      <Row label={$t('frameleaf_prefs_look_archived')} help={$t('frameleaf_prefs_look_archived_help')}>
        <Switch
          label={$t('frameleaf_prefs_look_archived')}
          checked={albums.draft['search.includeArchived']}
          onChange={(value) => albums.set('search.includeArchived', value)}
        />
      </Row>
    </Section>

    <Section title={$t('frameleaf_prefs_look_media')}>
      <Row label={$t('frameleaf_prefs_look_full_quality')} help={$t('frameleaf_prefs_look_full_quality_help')}>
        <Switch
          label={$t('frameleaf_prefs_look_full_quality')}
          checked={$alwaysLoadOriginalFile}
          onChange={(value) => ($alwaysLoadOriginalFile = value)}
        />
      </Row>
      <Row label={$t('frameleaf_prefs_look_hover')} help={$t('frameleaf_prefs_look_hover_help')}>
        <Switch
          label={$t('frameleaf_prefs_look_hover')}
          checked={$playVideoThumbnailOnHover}
          onChange={(value) => ($playVideoThumbnailOnHover = value)}
        />
      </Row>
      <Row label={$t('frameleaf_prefs_look_auto_play')} help={$t('frameleaf_prefs_look_auto_play_help')}>
        <Switch
          label={$t('frameleaf_prefs_look_auto_play')}
          checked={$autoPlayVideo}
          onChange={(value) => ($autoPlayVideo = value)}
        />
      </Row>
      <Row label={$t('frameleaf_prefs_look_loop')} help={$t('frameleaf_prefs_look_loop_help')}>
        <Switch
          label={$t('frameleaf_prefs_look_loop')}
          checked={$loopVideo}
          onChange={(value) => ($loopVideo = value)}
        />
      </Row>
      <Row label={$t('frameleaf_prefs_look_original_video')} help={$t('frameleaf_prefs_look_original_video_help')}>
        <Switch
          label={$t('frameleaf_prefs_look_original_video')}
          checked={$alwaysLoadOriginalVideo}
          onChange={(value) => ($alwaysLoadOriginalVideo = value)}
        />
      </Row>
    </Section>

    <Section title={$t('frameleaf_prefs_look_safety')}>
      <Row label={$t('frameleaf_prefs_look_ask_delete')} help={$t('frameleaf_prefs_look_ask_delete_help')}>
        <Switch
          label={$t('frameleaf_prefs_look_ask_delete')}
          checked={$showDeleteModal}
          onChange={(value) => ($showDeleteModal = value)}
        />
      </Row>
    </Section>
  </KitPage>
</OwnPreferencesForm>
