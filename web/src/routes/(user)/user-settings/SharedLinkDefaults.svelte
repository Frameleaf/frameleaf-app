<script lang="ts">
  /**
   * Your preferences › Shared links (FL-922, after the approved prototype `settings-v2/quick-wins.jsx`
   * SharedLinksPreferences): how long a new shared link lasts unless you change it on the link. No
   * choice of your own follows the server's default (the server reads it that way), so the first
   * option says which that is. Changes wait for the Save bar.
   */
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Select from '$lib/components/frameleaf/settings/kit/Select.svelte';
  import OwnPreferencesForm from '$lib/components/frameleaf/settings/OwnPreferencesForm.svelte';
  import type { AccountPreferenceKey } from '$lib/frameleaf/account-preferences';
  import {
    LINK_EXPIRY_NONE,
    linkExpiryChoices,
    linkExpiryFromValue,
    linkExpiryValue,
  } from '$lib/frameleaf/link-expiry';
  import { createOwnPreferencesDraft } from '$lib/frameleaf/own-preferences-draft';
  import { serverConfigManager } from '$lib/managers/server-config-manager.svelte';
  import { t } from 'svelte-i18n';

  const keys: AccountPreferenceKey[] = ['sharedLinks.defaultExpiryDays'];
  const store = createOwnPreferencesDraft(keys);
  const own = $derived(store.draft['sharedLinks.defaultExpiryDays']);
  const server = $derived(serverConfigManager.value.sharedLinkDefaultExpiryDays ?? null);
  const after = (days: number) => $t('frameleaf_link_expiry_days', { values: { count: days } });
  const helpId = $props.id();

  const options = $derived([
    {
      value: LINK_EXPIRY_NONE,
      label:
        server === null
          ? $t('frameleaf_link_expiry_never')
          : $t('frameleaf_link_expiry_server_option', { values: { after: after(server) } }),
    },
    ...linkExpiryChoices(own).map((days) => ({ value: String(days), label: after(days) })),
  ]);
  const help = $derived(
    own === null
      ? server === null
        ? $t('frameleaf_link_expiry_help_never')
        : $t('frameleaf_link_expiry_help_server', { values: { after: after(server) } })
      : $t('frameleaf_link_expiry_help_own', { values: { after: after(own) } }),
  );
</script>

<OwnPreferencesForm {store}>
  <KitPage>
    <Section title={$t('frameleaf_link_expiry_section')}>
      <Row label={$t('frameleaf_link_expiry_label')} {help} {helpId}>
        <Select
          label={$t('frameleaf_link_expiry_label')}
          value={linkExpiryValue(own)}
          {options}
          describedBy={helpId}
          onChange={(value) => store.set('sharedLinks.defaultExpiryDays', linkExpiryFromValue(value))}
        />
      </Row>
      <p class="hint">
        {server === null
          ? $t('frameleaf_link_expiry_server_never')
          : $t('frameleaf_link_expiry_server_set', { values: { after: after(server) } })}
      </p>
    </Section>
  </KitPage>
</OwnPreferencesForm>

<style>
  .hint {
    margin: 0;
    padding: var(--fl-space-4) 0 var(--fl-space-5);
    border-top: 1px solid var(--fl-border);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.5;
  }
</style>
