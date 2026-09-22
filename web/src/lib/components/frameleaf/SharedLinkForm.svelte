<script lang="ts">
  import Dialog from './Dialog.svelte';
  import QrCode from './QrCode.svelte';
  import { asUrl, handleCreateSharedLink, handleUpdateSharedLink } from '$lib/services/shared-link.service';
  import { SharedLinkType, type SharedLinkResponseDto } from '@immich/sdk';
  import { locale } from '$lib/stores/preferences.store';
  import { t } from 'svelte-i18n';

  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  type Preset = { id: string; ms: number | null; value?: number; unit?: Intl.RelativeTimeFormatUnit };
  const PRESETS: Preset[] = [
    { id: '30m', ms: 30 * MINUTE, value: 30, unit: 'minute' },
    { id: '1h', ms: HOUR, value: 1, unit: 'hour' },
    { id: '6h', ms: 6 * HOUR, value: 6, unit: 'hour' },
    { id: '1d', ms: DAY, value: 1, unit: 'day' },
    { id: '7d', ms: 7 * DAY, value: 7, unit: 'day' },
    { id: '30d', ms: 30 * DAY, value: 30, unit: 'day' },
    { id: '3mo', ms: 90 * DAY, value: 3, unit: 'month' },
    { id: '1y', ms: 365 * DAY, value: 1, unit: 'year' },
    { id: 'never', ms: null },
  ];

  let {
    open = $bindable(false),
    target,
    link,
  }: {
    open?: boolean;
    target?: { type: SharedLinkType; albumId?: string; assetIds?: string[]; name: string };
    link?: SharedLinkResponseDto;
  } = $props();

  const editing = $derived(!!link);
  const type = $derived(link?.type ?? target?.type ?? SharedLinkType.Individual);
  const albumId = $derived(link?.album?.id ?? target?.albumId);
  const assetCount = $derived(editing ? (link?.assets.length ?? 0) : (target?.assetIds?.length ?? 0));
  const name = $derived(target?.name ?? (link?.album ? link.album.albumName : ''));

  let description = $state('');
  let password = $state('');
  let showPassword = $state(false);
  let removePassword = $state(false);
  let slug = $state('');
  let allowDownload = $state(true);
  let allowUpload = $state(false);
  let showMetadata = $state(true);
  let preset = $state('never');
  let customAt = $state('');
  let error = $state('');
  let saving = $state(false);

  const relativeTime = $derived(new Intl.RelativeTimeFormat($locale));
  const presetLabel = (item: Preset) =>
    item.id === 'never' ? $t('never') : relativeTime.format(item.value as number, item.unit as Intl.RelativeTimeFormatUnit);

  const resetFromLink = () => {
    description = link?.description ?? '';
    password = '';
    showPassword = false;
    removePassword = false;
    slug = link?.slug ?? '';
    allowDownload = link ? link.allowDownload : true;
    allowUpload = link ? link.allowUpload : false;
    showMetadata = link ? link.showMetadata : true;
    preset = link?.expiresAt ? 'custom' : 'never';
    customAt = link?.expiresAt ? toLocalInputValue(link.expiresAt) : '';
    error = '';
  };
  $effect(() => {
    if (open) {
      resetFromLink();
    }
  });

  function toLocalInputValue(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
      return '';
    }
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  // Existing product invariant carried over from SharedLinkFormFields.svelte:
  // download requires metadata to be shown.
  $effect(() => {
    if (!showMetadata && allowDownload) {
      allowDownload = false;
    }
  });

  const expiresAt = $derived.by(() => {
    if (preset === 'never') {
      return null;
    }
    if (preset === 'custom') {
      const at = Date.parse(customAt);
      return Number.isFinite(at) ? new Date(at).toISOString() : null;
    }
    const found = PRESETS.find((item) => item.id === preset);
    return found?.ms ? new Date(Date.now() + found.ms).toISOString() : null;
  });

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (preset === 'custom' && !expiresAt) {
      error = $t('frameleaf_sharing.invalid_expiry');
      return;
    }
    saving = true;
    error = '';
    try {
      if (editing && link) {
        const success = await handleUpdateSharedLink(link, {
          description,
          slug: slug.trim() || null,
          allowDownload,
          allowUpload,
          showMetadata,
          expiresAt,
          password: removePassword ? null : password || undefined,
        });
        if (success) {
          open = false;
        }
      } else {
        const success = await handleCreateSharedLink({
          type,
          albumId,
          assetIds: target?.assetIds,
          description,
          slug: slug.trim() || null,
          allowDownload,
          allowUpload,
          showMetadata,
          expiresAt,
          password: password || null,
        });
        if (success) {
          open = false;
        }
      }
      // The password value never leaves this pending submission; drop it now
      // whether or not the save succeeded.
      password = '';
    } finally {
      saving = false;
    }
  }
</script>

<Dialog title={editing ? $t('frameleaf_sharing.edit_shared_link_title') : $t('frameleaf_sharing.create_shared_link_title')} closeLabel={$t('close')} bind:open>
  <p class="slf-target">
    {type === SharedLinkType.Album ? $t('album_with_link_access') : $t('frameleaf_sharing.items_selected', { values: { count: assetCount } })}
    {#if name}<strong>{name}</strong>{/if}
  </p>

  <form class="slf-fields" onsubmit={submit}>
    <label>
      {$t('description')}
      <input bind:value={description} maxlength="500" />
    </label>

    <div class="slf-field">
      <label for="slf-password">{$t('password')}</label>
      <div class="slf-password">
        <input
          id="slf-password"
          type={showPassword ? 'text' : 'password'}
          autocomplete="new-password"
          bind:value={password}
          maxlength="120"
          disabled={removePassword}
          placeholder={editing && link?.password && !removePassword ? $t('frameleaf_sharing.password_set_hint') : $t('frameleaf_sharing.password_placeholder')}
        />
        <button type="button" aria-pressed={showPassword} onclick={() => (showPassword = !showPassword)}>
          {showPassword ? $t('hide_password') : $t('show_password')}
        </button>
      </div>
      {#if editing && link?.password}
        <label class="slf-inline">
          <input type="checkbox" bind:checked={removePassword} />
          {$t('frameleaf_sharing.remove_password')}
        </label>
      {/if}
      <small>{$t('shared_link_password_description')}</small>
    </div>

    <div class="slf-field">
      <label for="slf-slug">{$t('shared_link_custom_url_title')}</label>
      <input id="slf-slug" bind:value={slug} maxlength="48" spellcheck="false" autocapitalize="off" />
      <small>{$t('shared_link_custom_url_description')}</small>
      {#if editing && link && (slug.trim() || null) !== (link.slug || null)}
        <p class="slf-warning" role="status">{$t('frameleaf_sharing.slug_change_warning')}</p>
      {/if}
    </div>

    <div class="slf-toggles">
      <label class="slf-toggle">
        <span>{$t('show_metadata')}</span>
        <input type="checkbox" role="switch" class="slf-switch" aria-label={$t('show_metadata')} bind:checked={showMetadata} />
      </label>
      <label class="slf-toggle">
        <span>{$t('allow_public_user_to_download')}</span>
        <input
          type="checkbox"
          role="switch"
          class="slf-switch"
          aria-label={$t('allow_public_user_to_download')}
          bind:checked={allowDownload}
          disabled={!showMetadata}
        />
      </label>
      <label class="slf-toggle">
        <span>{$t('allow_public_user_to_upload')}</span>
        <input type="checkbox" role="switch" class="slf-switch" aria-label={$t('allow_public_user_to_upload')} bind:checked={allowUpload} />
      </label>
    </div>

    <div class="slf-expiry">
      <label>
        {$t('expire_after')}
        <select bind:value={preset}>
          {#each PRESETS as item (item.id)}
            <option value={item.id}>{presetLabel(item)}</option>
          {/each}
          <option value="custom">{$t('expire_after')}…</option>
        </select>
      </label>
      {#if preset === 'custom'}
        <label>
          {$t('expire_after')}
          <input type="datetime-local" bind:value={customAt} min={toLocalInputValue(new Date().toISOString())} />
        </label>
      {/if}
    </div>

    {#if error}
      <p class="slf-error" role="alert">{error}</p>
    {/if}

    {#if editing && link}
      <div class="slf-qr">
        <QrCode
          value={asUrl(link)}
          label={$t('view_qr_code')}
          copyLabel={$t('copy_link')}
          downloadLabel={$t('download')}
          errorLabel={$t('frameleaf_sharing.qr_error')}
          fileName={link.slug || link.id}
          showActions={true}
        />
      </div>
    {/if}

    <div class="slf-actions">
      <button type="button" onclick={() => (open = false)}>{$t('cancel')}</button>
      <button type="submit" class="primary" disabled={saving}>
        {editing ? $t('save') : $t('create_link')}
      </button>
    </div>
  </form>
</Dialog>

<style>
  .slf-target {
    color: var(--fl-muted);
    font-size: 0.875rem;
  }
  .slf-fields {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.875rem;
  }
  input,
  select {
    background: var(--fl-raised);
    color: var(--fl-text);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    padding: 0.5rem;
  }
  .slf-field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.875rem;
  }
  .slf-password {
    display: flex;
    gap: 0.5rem;
  }
  .slf-password input {
    flex: 1;
  }
  .slf-password button {
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    color: var(--fl-text);
  }
  .slf-inline {
    flex-direction: row;
    align-items: center;
    gap: 0.5rem;
  }
  small {
    color: var(--fl-muted);
  }
  .slf-warning {
    color: var(--fl-accent);
    font-size: 0.8125rem;
  }
  .slf-toggles {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .slf-toggle {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }
  .slf-expiry {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
  }
  .slf-error {
    color: var(--fl-accent);
  }
  .slf-qr {
    display: flex;
    justify-content: center;
    padding: 0.5rem 0;
  }
  .slf-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }
  .slf-actions button {
    background: var(--fl-raised);
    color: var(--fl-text);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    padding: 0 1rem;
  }
  .slf-actions button.primary {
    background: var(--fl-accent);
    color: var(--fl-accent-text);
    border-color: var(--fl-accent);
  }
</style>
