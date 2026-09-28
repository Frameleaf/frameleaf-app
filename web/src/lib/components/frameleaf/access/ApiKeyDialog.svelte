<script lang="ts">
  /**
   * Create or edit one of your API keys, and show a new key once (FL-67), from the
   * `personal-key-create` / `personal-key-edit` forms and the one-time reveal of the design
   * template's `PersonalForm`.
   *
   * Every current permission is offered, searchable, with full access first; choosing full
   * access or every permission saves `all`, as the previous editor did. A key that can delete
   * things says so. A created or rotated key is shown once in this dialog with Copy; closing it
   * drops the value and it cannot be shown again.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import {
    API_KEY_NAME_MAX_LENGTH,
    filterPermissions,
    INDIVIDUAL_PERMISSIONS,
    keyCanDelete,
    normalizeKeyPermissions,
  } from '$lib/frameleaf/personal-access';
  import { handleCreateApiKey, handleUpdateApiKey } from '$lib/services/api-key.service';
  import { Permission, type ApiKeyResponseDto } from '@immich/sdk';
  import { t } from 'svelte-i18n';
  import './access.css';

  let {
    apiKey,
    secret: revealed,
    onClose,
  }: {
    /** The key to edit; omit to create one. */
    apiKey?: ApiKeyResponseDto;
    /** A key value to show once, for a key that was just rotated. */
    secret?: string;
    onClose: () => void;
  } = $props();

  let open = $state(true);
  let name = $state(apiKey?.name ?? '');
  let selected = $state<Permission[]>(
    apiKey
      ? apiKey.permissions.includes(Permission.All)
        ? [Permission.All]
        : [...apiKey.permissions]
      : [Permission.AssetRead],
  );
  let search = $state('');
  let working = $state(false);
  let secret = $state(revealed ?? '');
  let copyStatus = $state('');

  const fullAccess = $derived(selected.includes(Permission.All));
  const visible = $derived(filterPermissions(search));
  const count = $derived(fullAccess ? INDIVIDUAL_PERMISSIONS.length : selected.length);
  const valid = $derived(name.trim().length > 0 && selected.length > 0);
  const listId = $props.id();

  $effect(() => {
    if (open) {
      return;
    }

    secret = '';
    onClose();
  });

  const toggle = (permission: Permission, checked: boolean) => {
    if (permission === Permission.All) {
      selected = checked ? [Permission.All] : [];
      return;
    }
    const current = selected.filter((value) => value !== Permission.All);
    selected = checked ? [...current, permission] : current.filter((value) => value !== permission);
  };

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (working || !valid) {
      return;
    }

    working = true;
    try {
      const permissions = normalizeKeyPermissions(selected);
      if (apiKey) {
        if (await handleUpdateApiKey(apiKey, { name: name.trim(), permissions })) {
          open = false;
        }
        return;
      }
      const response = await handleCreateApiKey({ name: name.trim(), permissions });
      if (response) {
        secret = response.secret;
      }
    } finally {
      working = false;
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(secret);
      copyStatus = $t('frameleaf_access_key_copied');
    } catch {
      copyStatus = $t('frameleaf_access_key_copy_unavailable');
    }
  };
</script>

<Dialog
  title={secret
    ? $t('frameleaf_access_key_secret_title')
    : apiKey
      ? $t('frameleaf_access_key_edit')
      : $t('frameleaf_access_key_create')}
  closeLabel={$t('close')}
  bind:open
>
  {#if secret}
    <div class="fl-access-form">
      <p>{$t('frameleaf_access_key_secret_description')}</p>
      <code class="fl-access-secret" aria-label={$t('frameleaf_access_key_secret_label')}>{secret}</code>
      <p class="fl-access-footnote">{$t('frameleaf_access_key_secret_footnote')}</p>
      <p class="fl-access-footnote" role="status">{copyStatus}</p>
      <footer>
        <Button onclick={copy}>{$t('frameleaf_access_key_copy')}</Button>
        <Button variant="primary" onclick={() => (open = false)}>{$t('done')}</Button>
      </footer>
    </div>
  {:else}
    <form class="fl-access-form" autocomplete="off" onsubmit={submit}>
      <label class="fl-access-field">
        <span>{$t('frameleaf_access_key_name')}</span>
        <!-- svelte-ignore a11y_autofocus -->
        <input
          required
          autofocus
          maxlength={API_KEY_NAME_MAX_LENGTH}
          placeholder={$t('frameleaf_access_key_name_placeholder')}
          disabled={working}
          bind:value={name}
        />
      </label>
      <p>{$t('frameleaf_access_key_permissions_count', { values: { count } })}</p>
      <label class="fl-access-field">
        <span>{$t('frameleaf_access_key_find_permission')}</span>
        <input type="search" aria-controls={listId} bind:value={search} />
      </label>
      <div class="permissions" id={listId} role="group" aria-label={$t('frameleaf_access_key_permissions')}>
        {#each visible as permission (permission)}
          <label class="fl-access-check">
            <input
              type="checkbox"
              checked={fullAccess || selected.includes(permission)}
              disabled={working || (fullAccess && permission !== Permission.All)}
              onchange={(event) => toggle(permission, event.currentTarget.checked)}
            />
            <span>{permission === Permission.All ? $t('frameleaf_access_key_full_access') : permission}</span>
          </label>
        {:else}
          <p class="fl-access-footnote">{$t('frameleaf_access_key_no_permissions_match')}</p>
        {/each}
      </div>
      {#if keyCanDelete(selected)}
        <p class="fl-access-notice">{$t('frameleaf_access_key_delete_warning')}</p>
      {/if}
      <footer>
        <Button disabled={working} onclick={() => (open = false)}>{$t('cancel')}</Button>
        <Button type="submit" variant="primary" disabled={working || !valid}>
          {apiKey ? $t('save') : $t('frameleaf_access_key_create')}
        </Button>
      </footer>
    </form>
  {/if}
</Dialog>

<style>
  .permissions {
    display: grid;
    max-height: 16rem;
    overflow-y: auto;
    padding: 0.25rem 0.5rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
</style>
