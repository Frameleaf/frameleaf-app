<script lang="ts">
  /**
   * The account's own download packaging (FL-77), from the design template's "Personal download
   * packaging" settings. The size is entered in GiB and stored as an exact byte count: an
   * unchanged size is never re-sent, so a size set elsewhere to an arbitrary number of bytes is
   * kept exactly.
   */
  import OwnPreferencesForm from '$lib/components/frameleaf/settings/OwnPreferencesForm.svelte';
  import SettingField from '$lib/components/frameleaf/settings/SettingField.svelte';
  import SettingToggle from '$lib/components/frameleaf/settings/SettingToggle.svelte';
  import { SettingInputFieldType } from '$lib/constants';
  import { archiveSizeToGib, gibToArchiveSize, type AccountPreferenceKey } from '$lib/frameleaf/account-preferences';
  import { createOwnPreferencesDraft } from '$lib/frameleaf/own-preferences-draft';
  import { untrack } from 'svelte';
  import { t } from 'svelte-i18n';

  const keys: AccountPreferenceKey[] = ['download.archiveSize', 'download.includeEmbeddedVideos'];
  const store = createOwnPreferencesDraft(keys);
  const draft = $derived(store.draft);

  // The field keeps what was typed and only follows the draft when the draft changes some other
  // way (cancel, save, load latest).
  let archiveGib = $state<number | null>(untrack(() => archiveSizeToGib(store.draft['download.archiveSize'])));
  $effect(() => {
    const bytes = store.draft['download.archiveSize'];
    untrack(() => {
      if (gibToArchiveSize(archiveGib) !== bytes) {
        archiveGib = archiveSizeToGib(bytes);
      }
    });
  });

  const setArchiveGib = (value: number | string | null | undefined) => {
    const gib = (value ?? '') === '' ? null : Number(value);
    archiveGib = gib;
    store.set('download.archiveSize', gibToArchiveSize(gib));
  };
</script>

<OwnPreferencesForm {store}>
  <SettingField
    inputType={SettingInputFieldType.NUMBER}
    label={$t('frameleaf_own_prefs_archive_size')}
    description={$t('frameleaf_own_prefs_archive_size_help')}
    min={0}
    step="any"
    bind:value={() => archiveGib, (value) => setArchiveGib(value)}
  />
  <SettingToggle
    title={$t('frameleaf_own_prefs_motion_videos')}
    subtitle={$t('frameleaf_own_prefs_motion_videos_help')}
    bind:checked={
      () => draft['download.includeEmbeddedVideos'], (value) => store.set('download.includeEmbeddedVideos', value)
    }
  />
</OwnPreferencesForm>
