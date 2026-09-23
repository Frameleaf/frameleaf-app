<script lang="ts">
  /**
   * The account's own library features (FL-77), from the design template's "Library features"
   * settings (`settings-advanced.mjs`) with the album viewing order and "Show memories" it maps
   * onto the same preferences (`account-preference-settings.mjs`).
   *
   * Each navigation switch is its own preference: it stays visible, keeps its value and is only
   * unavailable while its feature is off. These switches choose tools and navigation; they never
   * restrict access. While an administrator has turned casting off the Chromecast switch is
   * unavailable and is never sent.
   */
  import OwnPreferencesForm from '$lib/components/frameleaf/settings/OwnPreferencesForm.svelte';
  import SettingField from '$lib/components/frameleaf/settings/SettingField.svelte';
  import SettingSelect from '$lib/components/frameleaf/settings/SettingSelect.svelte';
  import SettingToggle from '$lib/components/frameleaf/settings/SettingToggle.svelte';
  import { SettingInputFieldType } from '$lib/constants';
  import type { AccountPreferenceKey } from '$lib/frameleaf/account-preferences';
  import { createOwnPreferencesDraft } from '$lib/frameleaf/own-preferences-draft';
  import { AssetOrder } from '@immich/sdk';
  import { t } from 'svelte-i18n';

  const keys: AccountPreferenceKey[] = [
    'albums.defaultAssetOrder',
    'folders.enabled',
    'folders.sidebarWeb',
    'memories.enabled',
    'memories.sidebarWeb',
    'memories.duration',
    'people.enabled',
    'people.sidebarWeb',
    'people.minimumFaces',
    'ratings.enabled',
    'sharedLinks.enabled',
    'sharedLinks.sidebarWeb',
    'tags.enabled',
    'tags.sidebarWeb',
    'cast.gCastEnabled',
    'recentlyAdded.sidebarWeb',
  ];

  const store = createOwnPreferencesDraft(keys);
  const draft = $derived(store.draft);
  const castDisabledByAdmin = $derived(draft['cast.adminDisabled']);
</script>

<OwnPreferencesForm {store}>
  <SettingSelect
    label={$t('frameleaf_own_prefs_album_order')}
    desc={$t('frameleaf_own_prefs_album_order_help')}
    options={[
      { value: AssetOrder.Desc, text: $t('newest_first') },
      { value: AssetOrder.Asc, text: $t('oldest_first') },
    ]}
    bind:value={
      () => draft['albums.defaultAssetOrder'], (value) => store.set('albums.defaultAssetOrder', value as AssetOrder)
    }
  />

  <SettingToggle
    title={$t('frameleaf_own_prefs_folders')}
    subtitle={$t('frameleaf_own_prefs_folders_help')}
    bind:checked={() => draft['folders.enabled'], (value) => store.set('folders.enabled', value)}
  />
  <SettingToggle
    title={$t('frameleaf_own_prefs_folders_sidebar')}
    subtitle={$t('frameleaf_own_prefs_folders_sidebar_help')}
    disabled={!draft['folders.enabled']}
    bind:checked={() => draft['folders.sidebarWeb'], (value) => store.set('folders.sidebarWeb', value)}
  />

  <SettingToggle
    title={$t('frameleaf_own_prefs_memories')}
    subtitle={$t('frameleaf_own_prefs_memories_help')}
    bind:checked={() => draft['memories.enabled'], (value) => store.set('memories.enabled', value)}
  />
  <SettingToggle
    title={$t('frameleaf_own_prefs_memories_sidebar')}
    subtitle={$t('frameleaf_own_prefs_memories_sidebar_help')}
    disabled={!draft['memories.enabled']}
    bind:checked={() => draft['memories.sidebarWeb'], (value) => store.set('memories.sidebarWeb', value)}
  />
  <SettingField
    inputType={SettingInputFieldType.NUMBER}
    label={$t('frameleaf_own_prefs_memory_duration')}
    description={$t('frameleaf_own_prefs_memory_duration_help')}
    min={1}
    max={3600}
    bind:value={() => draft['memories.duration'], (value) => store.set('memories.duration', value ?? null)}
  />

  <SettingToggle
    title={$t('frameleaf_own_prefs_people')}
    subtitle={$t('frameleaf_own_prefs_people_help')}
    bind:checked={() => draft['people.enabled'], (value) => store.set('people.enabled', value)}
  />
  <SettingToggle
    title={$t('frameleaf_own_prefs_people_sidebar')}
    subtitle={$t('frameleaf_own_prefs_people_sidebar_help')}
    disabled={!draft['people.enabled']}
    bind:checked={() => draft['people.sidebarWeb'], (value) => store.set('people.sidebarWeb', value)}
  />
  <SettingField
    inputType={SettingInputFieldType.NUMBER}
    label={$t('frameleaf_own_prefs_minimum_faces')}
    description={$t('frameleaf_own_prefs_minimum_faces_help')}
    min={1}
    max={100_000}
    disabled={!draft['people.enabled']}
    bind:value={() => draft['people.minimumFaces'], (value) => store.set('people.minimumFaces', value ?? null)}
  />

  <SettingToggle
    title={$t('frameleaf_own_prefs_ratings')}
    subtitle={$t('frameleaf_own_prefs_ratings_help')}
    bind:checked={() => draft['ratings.enabled'], (value) => store.set('ratings.enabled', value)}
  />

  <SettingToggle
    title={$t('frameleaf_own_prefs_shared_links')}
    subtitle={$t('frameleaf_own_prefs_shared_links_help')}
    bind:checked={() => draft['sharedLinks.enabled'], (value) => store.set('sharedLinks.enabled', value)}
  />
  <SettingToggle
    title={$t('frameleaf_own_prefs_shared_links_sidebar')}
    subtitle={$t('frameleaf_own_prefs_shared_links_sidebar_help')}
    disabled={!draft['sharedLinks.enabled']}
    bind:checked={() => draft['sharedLinks.sidebarWeb'], (value) => store.set('sharedLinks.sidebarWeb', value)}
  />

  <SettingToggle
    title={$t('frameleaf_own_prefs_tags')}
    subtitle={$t('frameleaf_own_prefs_tags_help')}
    bind:checked={() => draft['tags.enabled'], (value) => store.set('tags.enabled', value)}
  />
  <SettingToggle
    title={$t('frameleaf_own_prefs_tags_sidebar')}
    subtitle={$t('frameleaf_own_prefs_tags_sidebar_help')}
    disabled={!draft['tags.enabled']}
    bind:checked={() => draft['tags.sidebarWeb'], (value) => store.set('tags.sidebarWeb', value)}
  />

  <SettingToggle
    title={$t('frameleaf_own_prefs_cast')}
    subtitle={castDisabledByAdmin ? $t('frameleaf_cast_disabled_by_admin') : $t('frameleaf_own_prefs_cast_help')}
    disabled={castDisabledByAdmin}
    bind:checked={() => draft['cast.gCastEnabled'], (value) => store.set('cast.gCastEnabled', value)}
  />

  <SettingToggle
    title={$t('frameleaf_own_prefs_recently_added_sidebar')}
    subtitle={$t('frameleaf_own_prefs_recently_added_sidebar_help')}
    bind:checked={() => draft['recentlyAdded.sidebarWeb'], (value) => store.set('recentlyAdded.sidebarWeb', value)}
  />
</OwnPreferencesForm>
