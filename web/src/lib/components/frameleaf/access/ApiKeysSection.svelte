<script lang="ts">
  /**
   * API keys, from the `api-keys` section of the design template's `PersonalAccess`: Create API
   * key, and for each key its name, what it is for, when it was last used (FL-367) and when it was
   * made, with Edit, Replace and Delete.
   * Creating or rotating shows the new value once; rotating stops the old value at once.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import ApiKeyDialog from '$lib/components/frameleaf/access/ApiKeyDialog.svelte';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import { keyPurpose, summarizePermissions } from '$lib/frameleaf/personal-access';
  import { handleDeleteApiKey, handleRotateApiKey } from '$lib/services/api-key.service';
  import { locale } from '$lib/stores/preferences.store';
  import { getApiKeys, Permission, type ApiKeyResponseDto } from '@frameleaf/sdk';
  import { modalManager } from '@frameleaf/ui';
  import { DateTime } from 'luxon';
  import { t, type Translations } from 'svelte-i18n';
  import './access.css';

  let { keys = $bindable([]) }: { keys?: ApiKeyResponseDto[] } = $props();

  const refresh = async () => {
    try {
      keys = await getApiKeys();
    } catch {
      // The list keeps what it showed; the next action reports a real problem.
    }
  };

  const made = (key: ApiKeyResponseDto) =>
    DateTime.fromISO(key.createdAt, { locale: $locale }).toLocaleString(DateTime.DATE_MED);
  /** FL-367: "Last used 2 days ago" or "Never used", from what the server records. */
  const lastUsed = (key: ApiKeyResponseDto) =>
    key.lastUsedAt
      ? $t('frameleaf_access_key_last_used', {
          values: { when: DateTime.fromISO(key.lastUsedAt).toRelative({ locale: $locale }) ?? '' },
        })
      : $t('frameleaf_access_key_never_used');

  const permissionText = (key: ApiKeyResponseDto) => {
    if (key.permissions.includes(Permission.All)) {
      return $t('frameleaf_access_key_full_access');
    }
    const purpose = keyPurpose(key.permissions);
    if (purpose !== 'custom') {
      return $t(`frameleaf_access_key_purpose_${purpose.replace('-', '_')}_row` as Translations);
    }
    const { shown, more } = summarizePermissions(key.permissions);
    const list = shown.join(' · ');
    return more > 0 ? $t('frameleaf_access_key_permissions_more', { values: { list, count: more } }) : list;
  };

  const rotate = async (key: ApiKeyResponseDto) => {
    const response = await handleRotateApiKey(key);
    if (response) {
      await modalManager.show(ApiKeyDialog, { secret: response.secret });
    }
  };
</script>

<OnEvents
  onApiKeyCreate={() => void refresh()}
  onApiKeyUpdate={(update) => (keys = keys.map((key) => (key.id === update.id ? update : key)))}
  onApiKeyDelete={({ id }) => (keys = keys.filter((key) => key.id !== id))}
/>

<section class="fl-access-section" aria-labelledby="fl-access-keys">
  <div class="fl-access-head">
    <div>
      <h3 id="fl-access-keys">{$t('frameleaf_access_keys_title')}</h3>
      <p>{$t('frameleaf_access_keys_description')}</p>
    </div>
    <Button variant="primary" onclick={() => modalManager.show(ApiKeyDialog, {})}>
      {$t('frameleaf_access_key_create')}
    </Button>
  </div>
  {#if keys.length > 0}
    <ul class="fl-access-list">
      {#each keys as key (key.id)}
        <li class="fl-access-item">
          <div>
            <strong>{key.name}</strong>
            <small>{permissionText(key)}</small>
            <small>{lastUsed(key)} · {$t('frameleaf_access_key_made', { values: { date: made(key) } })}</small>
          </div>
          <div class="fl-access-actions">
            <Button onclick={() => modalManager.show(ApiKeyDialog, { apiKey: key })}>
              {$t('frameleaf_access_key_edit_short')}
            </Button>
            <Button onclick={() => rotate(key)}>{$t('frameleaf_access_key_rotate')}</Button>
            <Button onclick={() => handleDeleteApiKey(key)}>{$t('frameleaf_access_key_delete')}</Button>
          </div>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="fl-access-empty">{$t('frameleaf_access_keys_empty')}</p>
  {/if}
</section>
