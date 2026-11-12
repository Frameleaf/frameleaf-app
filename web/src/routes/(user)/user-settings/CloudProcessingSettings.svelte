<script lang="ts">
  /**
   * Your preferences › Where your photos are processed (FL-1484, after the approved prototype
   * `settings-v2/server/preferences.jsx` ProcessingChoice). Each person chooses whether AI work on their
   * own photos may use Frameleaf Cloud. "Only at home" keeps it on this server and computers at home; the
   * server enforces it wherever work is routed or sent to Frameleaf Cloud. Only the person changes it: an
   * administrator sees the choice in Computers. Changes wait for the Save bar.
   */
  import Facts from '$lib/components/frameleaf/settings/kit/Facts.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Tiles from '$lib/components/frameleaf/settings/kit/Tiles.svelte';
  import OwnPreferencesForm from '$lib/components/frameleaf/settings/OwnPreferencesForm.svelte';
  import type { AccountPreferenceKey } from '$lib/frameleaf/account-preferences';
  import { createOwnPreferencesDraft } from '$lib/frameleaf/own-preferences-draft';
  import { t } from 'svelte-i18n';

  const ANYWHERE = 'anywhere';
  const HOME = 'home';

  const keys: AccountPreferenceKey[] = ['cloudProcessing.enabled'];
  const store = createOwnPreferencesDraft(keys);
  const draft = $derived(store.draft);
  const home = $derived(!draft['cloudProcessing.enabled']);
</script>

<OwnPreferencesForm {store}>
  <KitPage>
    <Section title={$t('frameleaf_prefs_processing_yours')}>
      <Tiles
        label={$t('frameleaf_prefs_processing_title')}
        value={home ? HOME : ANYWHERE}
        options={[
          {
            id: ANYWHERE,
            name: $t('frameleaf_prefs_processing_anywhere'),
            hint: $t('frameleaf_prefs_processing_anywhere_hint'),
          },
          { id: HOME, name: $t('frameleaf_prefs_processing_home'), hint: $t('frameleaf_prefs_processing_home_hint') },
        ]}
        onChange={(id) => store.set('cloudProcessing.enabled', id === ANYWHERE)}
      />
    </Section>

    <Section
      title={$t(
        home ? 'frameleaf_prefs_processing_changes_home_title' : 'frameleaf_prefs_processing_changes_anywhere_title',
      )}
      description={$t(home ? 'frameleaf_prefs_processing_changes_home' : 'frameleaf_prefs_processing_changes_anywhere')}
    >
      <Facts
        columns={4}
        rows={[
          {
            label: $t('frameleaf_prefs_processing_shared'),
            value: $t('frameleaf_prefs_processing_shared_value'),
            detail: $t('frameleaf_prefs_processing_shared_detail'),
          },
          {
            label: $t('frameleaf_prefs_processing_who'),
            value: $t('frameleaf_prefs_processing_who_value'),
            detail: $t('frameleaf_prefs_processing_who_detail'),
          },
          {
            label: $t('frameleaf_prefs_processing_search'),
            value: $t('frameleaf_prefs_processing_search_value'),
            detail: $t('frameleaf_prefs_processing_search_detail'),
          },
          {
            label: $t('frameleaf_prefs_processing_started'),
            value: $t('frameleaf_prefs_processing_started_value'),
            detail: $t('frameleaf_prefs_processing_started_detail'),
          },
        ]}
      />
    </Section>
  </KitPage>
</OwnPreferencesForm>
