<script lang="ts">
  /**
   * FL-655: Manage for the access Save to Frameleaf added by signing in (prototype `ApiKeys.jsx`,
   * README point 61). There is no key to copy or replace: it says what the access can do, how it was
   * added and when it was last used, and offers only Remove access, which signs that browser out
   * and keeps its waiting items.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { extensionBrowser, handleRemoveExtensionAccess } from '$lib/services/api-key.service';
  import { locale } from '$lib/stores/preferences.store';
  import type { ApiKeyResponseDto } from '@frameleaf/sdk';
  import { DateTime } from 'luxon';
  import { t } from 'svelte-i18n';
  import './access.css';

  let { apiKey, onClose }: { apiKey: ApiKeyResponseDto; onClose: () => void } = $props();

  let open = $state(true);
  let working = $state(false);

  const browser = $derived(extensionBrowser(apiKey));
  const added = $derived(DateTime.fromISO(apiKey.createdAt, { locale: $locale }).toLocaleString(DateTime.DATE_MED));
  const used = $derived(
    apiKey.lastUsedAt
      ? $t('frameleaf_access_key_last_used', {
          values: { when: DateTime.fromISO(apiKey.lastUsedAt).toRelative({ locale: $locale }) ?? '' },
        })
      : $t('frameleaf_access_key_never_used'),
  );

  $effect(() => {
    if (!open) {
      onClose();
    }
  });

  const remove = async () => {
    working = true;
    try {
      if (await handleRemoveExtensionAccess(apiKey)) {
        open = false;
      }
    } finally {
      working = false;
    }
  };
</script>

<Dialog title={apiKey.name} closeLabel={$t('close')} bind:open>
  <dl class="fl-access-form extension-access">
    <div>
      <dt>{$t('frameleaf_access_key_extension_can')}</dt>
      <dd>
        <span>{$t('frameleaf_access_key_purpose_capture')}</span>
        <small>{$t('frameleaf_access_key_purpose_capture_help')}</small>
      </dd>
    </div>
    <div>
      <dt>{$t('frameleaf_access_key_extension_added')}</dt>
      <dd>
        <span>{used}</span>
        <small>{$t('frameleaf_access_key_extension_added_help', { values: { browser, date: added } })}</small>
      </dd>
    </div>
    <div>
      <dt>{$t('frameleaf_access_key_extension_remove')}</dt>
      <dd>
        <Button variant="danger" disabled={working} onclick={remove}>
          {$t('frameleaf_access_key_extension_remove_more')}
        </Button>
        <small>{$t('frameleaf_access_key_extension_remove_help', { values: { browser } })}</small>
      </dd>
    </div>
  </dl>
  {#snippet actions()}
    <Button variant="primary" initialFocus onclick={() => (open = false)}>{$t('done')}</Button>
  {/snippet}
</Dialog>

<style>
  .extension-access {
    margin: 0;
  }
  .extension-access > div {
    display: grid;
    gap: var(--fl-space-1);
  }
  .extension-access dt {
    font-weight: 600;
  }
  .extension-access dd {
    display: grid;
    justify-items: start;
    gap: var(--fl-space-1);
    margin: 0;
  }
  .extension-access small {
    color: var(--fl-muted);
  }
</style>
