<script lang="ts">
  import Dialog from './Dialog.svelte';
  import QrCode from './QrCode.svelte';
  import { asUrl, handleCreateSharedLink, handleUpdateSharedLink } from '$lib/services/shared-link.service';
  import { SharedLinkType, type SharedLinkResponseDto } from '@immich/sdk';
  import { locale } from '$lib/stores/preferences.store';
  import { Icon } from '@immich/ui';
  import { mdiContentCopy, mdiEyeOffOutline, mdiEyeOutline, mdiOpenInNew, mdiQrcode } from '@mdi/js';
  import { t } from 'svelte-i18n';

  /**
   * Create or edit a shared link: the design's `SharedLinkForm` (`SharedLinkForm.jsx:88-509`).
   *
   * As in the design, a new link does not show camera and location details unless asked
   * (`SharedLinkForm.jsx:108`). Downloads stay tied to metadata, as upstream: the server serves
   * originals byte for byte, embedded EXIF and GPS included, so a link that hides metadata must
   * not offer downloads. With metadata off by default, download is off by default too.
   * Creating ends on the design's "Link ready" step (address, Copy, QR code, Open) in place of
   * the legacy QR modal; editing saves and closes.
   */
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  type Preset = { id: string; ms: number | null; value?: number; unit?: 'minute' | 'hour' | 'day' | 'month' | 'year' };
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
    onClosed,
  }: {
    open?: boolean;
    target?: { type: SharedLinkType; albumId?: string; assetIds?: string[]; name: string };
    link?: SharedLinkResponseDto;
    /** Called once the form (or its "Link ready" step) has closed. */
    onClosed?: () => void;
  } = $props();

  const editing = $derived(!!link);
  const type = $derived(link?.type ?? target?.type ?? SharedLinkType.Individual);
  const albumId = $derived(link?.album?.id ?? target?.albumId);
  const assetCount = $derived(editing ? (link?.assets.length ?? 0) : (target?.assetIds?.length ?? 0));
  const name = $derived(target?.name ?? (link?.album ? link.album.albumName : ''));
  const ids = $props.id();
  const formId = `${ids}-form`;

  let description = $state('');
  let password = $state('');
  let showPassword = $state(false);
  let removePassword = $state(false);
  let slug = $state('');
  let allowDownload = $state(false);
  let allowUpload = $state(false);
  let showMetadata = $state(false);
  let preset = $state('never');
  let customAt = $state('');
  let error = $state('');
  let saving = $state(false);
  /** The link just created: the dialog shows the "Link ready" step while it is set. */
  let created = $state<SharedLinkResponseDto | undefined>();
  let showQr = $state(false);
  let copyStatus = $state('');
  let addressInput = $state<HTMLInputElement>();

  // The dialog stays open between the steps, so the "Link ready" address takes focus itself.
  $effect(() => {
    if (created && addressInput) {
      addressInput.focus();
    }
  });

  const presetLabel = (item: Preset) =>
    item.id === 'never'
      ? $t('never')
      : $t('frameleaf_sharing.expires_in', {
          values: {
            duration: new Intl.NumberFormat($locale, { style: 'unit', unit: item.unit, unitDisplay: 'long' }).format(
              item.value as number,
            ),
          },
        });

  const resetFromLink = () => {
    description = link?.description ?? '';
    password = '';
    showPassword = false;
    removePassword = false;
    slug = link?.slug ?? '';
    allowDownload = link ? link.allowDownload && link.showMetadata : false;
    allowUpload = link ? link.allowUpload : false;
    showMetadata = link ? link.showMetadata : false;
    preset = link?.expiresAt ? 'custom' : 'never';
    customAt = link?.expiresAt ? toLocalInputValue(link.expiresAt) : '';
    error = '';
    created = undefined;
    showQr = false;
    copyStatus = '';
  };

  let wasOpen = false;
  $effect(() => {
    if (open && !wasOpen) {
      resetFromLink();
    }
    if (!open && wasOpen) {
      created = undefined;
      onClosed?.();
    }
    wasOpen = open;
  });

  function toLocalInputValue(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
      return '';
    }
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  // Originals carry their embedded metadata, so hiding metadata turns downloads off (upstream rule).
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

  const expiryHint = $derived(
    expiresAt
      ? $t('frameleaf_sharing.expires_at', {
          values: { date: new Date(expiresAt).toLocaleString($locale, { dateStyle: 'medium', timeStyle: 'short' }) },
        })
      : $t('frameleaf_sharing.never_expires_hint'),
  );

  const createdUrl = $derived(created ? asUrl(created) : '');

  async function copyCreated() {
    try {
      await navigator.clipboard.writeText(createdUrl);
      copyStatus = $t('frameleaf_sharing.link_copied');
    } catch {
      copyStatus = $t('frameleaf_sharing.copy_unavailable');
    }
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    // A new link must expire in the future (SharedLinkForm.jsx:185-193); an existing, already
    // expired link can still be edited without moving its date.
    if (preset === 'custom' && (!expiresAt || (!editing && Date.parse(expiresAt) <= Date.now()))) {
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
        const saved = await handleCreateSharedLink({
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
        if (saved) {
          created = saved;
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

<!-- One dialog for both steps: swapping dialogs would close the first and, with it, the whole form. -->
<Dialog
  title={created
    ? $t('frameleaf_sharing.link_ready_title')
    : editing
      ? $t('frameleaf_sharing.edit_shared_link_title')
      : $t('frameleaf_sharing.create_shared_link_title')}
  closeLabel={$t('close')}
  bind:open
>
  {#if created}
    <div class="slf-created">
      <p>
        {created.password
          ? $t('frameleaf_sharing.link_ready_body_password', { values: { name: created.description || name } })
          : $t('frameleaf_sharing.link_ready_body', { values: { name: created.description || name } })}
      </p>
      <label>
        {$t('frameleaf_sharing.link_address')}
        <input
          bind:this={addressInput}
          readonly
          value={createdUrl}
          onfocus={(event) => event.currentTarget.select()}
          aria-describedby="{ids}-created-status"
        />
      </label>
      <div class="slf-created-actions">
        <button type="button" onclick={() => void copyCreated()}>
          <Icon icon={mdiContentCopy} size="18" />
          {$t('frameleaf_sharing.copy')}
        </button>
        <button type="button" aria-pressed={showQr} onclick={() => (showQr = !showQr)}>
          <Icon icon={mdiQrcode} size="18" />
          {$t('frameleaf_sharing.qr_code')}
        </button>
        <a class="button" href={createdUrl} target="_blank" rel="noopener noreferrer">
          <Icon icon={mdiOpenInNew} size="18" />
          {$t('open')}
        </a>
      </div>
      {#if showQr}
        <div class="slf-qr">
          <QrCode
            value={createdUrl}
            label={$t('view_qr_code')}
            copyLabel={$t('copy_link')}
            downloadLabel={$t('download')}
            errorLabel={$t('frameleaf_sharing.qr_error')}
            fileName={created.slug || created.id}
            showActions={false}
          />
        </div>
      {/if}
      <span id="{ids}-created-status" class="slf-status" role="status" aria-live="polite">{copyStatus}</span>
    </div>
  {:else}
    <p class="slf-target">
      {type === SharedLinkType.Album
        ? $t('album_with_link_access')
        : $t('frameleaf_sharing.items_selected', { values: { count: assetCount } })}
      {#if name}<strong>{name}</strong>{/if}
    </p>

    <form id={formId} class="slf-fields" onsubmit={submit} novalidate>
      <label>
        {$t('description')}
        <input
          bind:value={description}
          maxlength="500"
          data-initial-focus
          placeholder={$t('frameleaf_sharing.description_placeholder')}
        />
      </label>

      <div class="slf-field">
        <label for="{ids}-password">{$t('password')}</label>
        <div class="slf-password">
          <input
            id="{ids}-password"
            type={showPassword ? 'text' : 'password'}
            autocomplete="new-password"
            bind:value={password}
            maxlength="120"
            disabled={removePassword}
            aria-describedby="{ids}-password-hint"
            placeholder={editing && link?.password && !removePassword
              ? $t('frameleaf_sharing.password_set_hint')
              : $t('frameleaf_sharing.password_placeholder')}
          />
          <button
            type="button"
            class="icon"
            aria-pressed={showPassword}
            aria-label={showPassword ? $t('hide_password') : $t('show_password')}
            title={showPassword ? $t('hide_password') : $t('show_password')}
            onclick={() => (showPassword = !showPassword)}
          >
            <Icon icon={showPassword ? mdiEyeOffOutline : mdiEyeOutline} size="18" />
          </button>
        </div>
        {#if editing && link?.password}
          <label class="slf-inline">
            <input type="checkbox" bind:checked={removePassword} />
            {$t('frameleaf_sharing.remove_password')}
          </label>
        {/if}
        <small id="{ids}-password-hint">{$t('frameleaf_sharing.password_hint')}</small>
      </div>

      <div class="slf-field">
        <label for="{ids}-slug">{$t('frameleaf_sharing.custom_address')}</label>
        <div class="slf-slug">
          <span aria-hidden="true">/s/</span>
          <input
            id="{ids}-slug"
            bind:value={slug}
            maxlength="48"
            spellcheck="false"
            autocapitalize="off"
            placeholder={$t('frameleaf_sharing.slug_placeholder')}
            aria-describedby="{ids}-slug-hint"
          />
        </div>
        <small id="{ids}-slug-hint">{$t('frameleaf_sharing.slug_hint')}</small>
        {#if editing && link && (slug.trim() || null) !== (link.slug || null)}
          <p class="slf-warning" role="status">{$t('frameleaf_sharing.slug_change_warning')}</p>
        {/if}
      </div>

      <div class="slf-toggles">
        <label class="slf-toggle">
          <span>
            <strong>{$t('frameleaf_sharing.allow_download')}</strong>
            <small id="{ids}-download-hint">
              {showMetadata
                ? $t('frameleaf_sharing.allow_download_description')
                : $t('frameleaf_sharing.download_needs_metadata')}
            </small>
          </span>
          <input
            type="checkbox"
            role="switch"
            class="slf-switch"
            bind:checked={allowDownload}
            disabled={!showMetadata}
            aria-describedby="{ids}-download-hint"
          />
        </label>
        <label class="slf-toggle">
          <span>
            <strong>{$t('frameleaf_sharing.allow_upload')}</strong>
            <small>{$t('frameleaf_sharing.allow_upload_description')}</small>
          </span>
          <input type="checkbox" role="switch" class="slf-switch" bind:checked={allowUpload} />
        </label>
        <label class="slf-toggle">
          <span>
            <strong>{$t('show_metadata')}</strong>
            <small>{$t('frameleaf_sharing.show_metadata_description')}</small>
          </span>
          <input type="checkbox" role="switch" class="slf-switch" bind:checked={showMetadata} />
        </label>
      </div>

      <div class="slf-expiry">
        <label>
          {$t('frameleaf_sharing.expires')}
          <select bind:value={preset}>
            {#each PRESETS as item (item.id)}
              <option value={item.id}>{presetLabel(item)}</option>
            {/each}
            <option value="custom">{$t('frameleaf_sharing.custom_expiry')}</option>
          </select>
        </label>
        {#if preset === 'custom'}
          <label>
            {$t('frameleaf_sharing.expiry_date_time')}
            <input type="datetime-local" bind:value={customAt} min={toLocalInputValue(new Date().toISOString())} />
          </label>
        {/if}
      </div>
      <small>{expiryHint}</small>

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
    </form>
  {/if}
  {#snippet actions()}
    {#if created}
      <button type="button" class="primary" onclick={() => (open = false)}>{$t('done')}</button>
    {:else}
      <button type="button" onclick={() => (open = false)}>{$t('cancel')}</button>
      <button type="submit" form={formId} class="primary" disabled={saving}>
        {editing ? $t('save') : $t('create_link')}
      </button>
    {/if}
  {/snippet}
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
  .slf-toggle > span {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }
  .slf-slug {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }
  .slf-slug span {
    color: var(--fl-muted);
    font-family: var(--fl-font-mono, monospace);
  }
  .slf-slug input {
    flex: 1;
  }
  .slf-password button.icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 44px;
  }
  .slf-created {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .slf-created p {
    margin: 0;
  }
  .slf-created-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .slf-created-actions button,
  .slf-created-actions .button,
  button.primary,
  button[type='button']:not(.icon) {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    min-height: 40px;
    padding: 0 1rem;
    background: var(--fl-raised);
    color: var(--fl-text);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    text-decoration: none;
  }
  .slf-created-actions button[aria-pressed='true'] {
    border-color: var(--fl-accent);
  }
  button.primary {
    background: var(--fl-accent);
    color: var(--fl-accent-text);
    border-color: var(--fl-accent);
  }
  .slf-status {
    color: var(--fl-muted);
    font-size: 0.875rem;
    min-height: 1.25rem;
  }
</style>
