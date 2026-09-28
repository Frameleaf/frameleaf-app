<script lang="ts">
  /**
   * API keys, from the `api-keys` section of the design template's `PersonalAccess`: Create API
   * key, and for each key its name, permissions and last update with Edit, Rotate and Delete.
   * Creating or rotating shows the new value once; rotating stops the old value at once.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import ApiKeyDialog from '$lib/components/frameleaf/access/ApiKeyDialog.svelte';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import { summarizePermissions } from '$lib/frameleaf/personal-access';
  import { handleDeleteApiKey, handleRotateApiKey } from '$lib/services/api-key.service';
  import { locale } from '$lib/stores/preferences.store';
  import { getApiKeys, Permission, type ApiKeyResponseDto } from '@immich/sdk';
  import { modalManager } from '@immich/ui';
  import { DateTime } from 'luxon';
  import { t } from 'svelte-i18n';
  import './access.css';

  let { keys = $bindable([]) }: { keys?: ApiKeyResponseDto[] } = $props();

  const refresh = async () => {
    try {
      keys = await getApiKeys();
    } catch {
      // The list keeps what it showed; the next action reports a real problem.
    }
  };

  const updated = (key: ApiKeyResponseDto) =>
    DateTime.fromISO(key.updatedAt, { locale: $locale }).toLocaleString(DateTime.DATE_MED);

  const permissionText = (key: ApiKeyResponseDto) => {
    if (key.permissions.includes(Permission.All)) {
      return $t('frameleaf_access_key_full_access');
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
            <small>{$t('frameleaf_access_key_updated', { values: { date: updated(key) } })}</small>
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
