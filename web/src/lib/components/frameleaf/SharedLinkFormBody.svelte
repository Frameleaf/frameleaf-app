<script lang="ts">
  import AssetCollage from './AssetCollage.svelte';
  import QrCode from './QrCode.svelte';
  import { sharedLinkBadges, relativeTime, type SharedLinkBadgeId } from '$lib/frameleaf/shared-link-badges';
  import { asUrl, handleCreateSharedLink, handleUpdateSharedLink } from '$lib/services/shared-link.service';
  import { locale } from '$lib/stores/preferences.store';
  import { getAllSharedLinks, SharedLinkType, type SharedLinkResponseDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiCheck,
    mdiClockOutline,
    mdiContentCopy,
    mdiDownloadOutline,
    mdiEyeOffOutline,
    mdiEyeOutline,
    mdiInformationOutline,
    mdiLinkVariant,
    mdiLockOutline,
    mdiOpenInNew,
    mdiQrcode,
    mdiUpload,
  } from '@mdi/js';
  import { onDestroy } from 'svelte';
  import { t } from 'svelte-i18n';

  /**
   * The fields and the "Link ready" step of a shared link, without a dialog of their own, so the
   * same form serves the link dialog (`SharedLinkForm`) and the share sheet, which shows it in
   * place. The surface that holds it draws the buttons: a submit button for `formId` while
   * `created` is unset, and Done once it is set.
   *
   * Create or edit a shared link: the design's `SharedLinkForm` (`SharedLinkForm.jsx:88-509`).
   *
   * As in the design, a new link does not show camera and location details unless asked
   * (`SharedLinkForm.jsx:108`). Downloads stay tied to metadata, as upstream: the server serves
   * originals byte for byte, embedded EXIF and GPS included, so a link that hides metadata must
   * not offer downloads. With metadata off by default, download is off by default too.
   * Creating ends on the design's "Link ready" step (address, Copy, QR code, Open) in place of
   * the legacy QR modal; editing saves and closes.
   *
   * "Show metadata" comes before "Allow downloads", which depends on it and is dimmed until it is
   * on. The "Link ready" step fades in, the new address is highlighted for a moment, and Copy
   * shows a tick once the address is on the clipboard.
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
    active = true,
    target,
    link,
    formId,
    compact = false,
    created = $bindable(),
    saving = $bindable(false),
    onSaved,
  }: {
    /** The form starts afresh from `link` (or empty) each time this turns true. */
    active?: boolean;
    target?: {
      type: SharedLinkType;
      albumId?: string;
      assetIds?: string[];
      name: string;
      /** For an album, the items its preview shows (its cover), since the form does not load the album. */
      previewAssetIds?: string[];
      /** For an album, how many items it holds. */
      count?: number;
    };
    link?: SharedLinkResponseDto;
    /** The id the form element carries, for a submit button drawn outside it. */
    formId: string;
    /** Inside another sheet that already shows the items: no heading line and no second collage. */
    compact?: boolean;
    /** The link just created: the "Link ready" step shows while it is set. */
    created?: SharedLinkResponseDto;
    saving?: boolean;
    /** Called when an existing link has been saved. */
    onSaved?: () => void;
  } = $props();

  const editing = $derived(!!link);
  const type = $derived(link?.type ?? target?.type ?? SharedLinkType.Individual);
  const albumId = $derived(link?.album?.id ?? target?.albumId);
  const assetCount = $derived(editing ? (link?.assets.length ?? 0) : (target?.assetIds?.length ?? 0));
  /** What the link shows, for the preview collage (`linkAssets`, SharedLinkForm.jsx:172). */
  const previewIds = $derived.by(() => {
    if (link) {
      if (link.type === SharedLinkType.Album) {
        return link.album?.albumThumbnailAssetId ? [link.album.albumThumbnailAssetId] : [];
      }
      return link.assets.map((asset) => asset.id);
    }
    return target?.type === SharedLinkType.Album ? (target.previewAssetIds ?? []) : (target?.assetIds ?? []);
  });
  const itemCount = $derived.by(() => {
    if (link) {
      return link.type === SharedLinkType.Album ? (link.album?.assetCount ?? previewIds.length) : link.assets.length;
    }
    return target?.type === SharedLinkType.Album
      ? (target.count ?? previewIds.length)
      : (target?.assetIds?.length ?? 0);
  });
  const name = $derived(target?.name ?? (link?.album ? link.album.albumName : ''));
  const ids = $props.id();

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
  let showQr = $state(false);
  let copyStatus = $state('');
  let addressInput = $state<HTMLInputElement>();
  /** The person's own links, to say live whether a custom address is free (SharedLinkForm.jsx:126). */
  let ownLinks = $state<SharedLinkResponseDto[] | undefined>();
  /** An address the server refused on save because another link, possibly someone else's, holds it. */
  let refusedSlug = $state('');

  const SLUG_PATTERN = /^[a-z0-9-]{3,48}$/;
  /** While typing: lowercase, spaces to dashes, nothing else (`typingSlug`, SharedLinkForm.jsx:69). */
  const typingSlug = (value: string) =>
    value
      .toLowerCase()
      .replaceAll(/[\s_]+/g, '-')
      .replaceAll(/[^a-z0-9-]/g, '')
      .replaceAll(/-{2,}/g, '-')
      .slice(0, 48);
  /** On leaving the field, stray dashes at either end go too (`normalizeSlug`). */
  const normalizeSlug = (value: string) => typingSlug(value).replaceAll(/^-+|-+$/g, '');

  /** `slugAvailability` (shared-links-data.mjs:73-87), checked against the person's own links. */
  const availability = $derived.by((): 'empty' | 'invalid' | 'taken' | 'available' | 'unknown' => {
    const value = slug.trim();
    if (!value) {
      return 'empty';
    }
    // An address a link already had is left alone, even one made before these rules.
    if (link && value === link.slug) {
      return 'available';
    }
    if (!SLUG_PATTERN.test(value)) {
      return 'invalid';
    }
    if (value === refusedSlug) {
      return 'taken';
    }
    if (!ownLinks) {
      return 'unknown';
    }
    return ownLinks.some((other) => other.id !== link?.id && (other.slug === value || other.id === value))
      ? 'taken'
      : 'available';
  });
  const slugMessage = $derived(
    {
      empty: $t('frameleaf_sharing.slug_hint'),
      unknown: $t('frameleaf_sharing.slug_hint'),
      invalid: $t('frameleaf_sharing.slug_invalid'),
      taken: $t('frameleaf_sharing.slug_taken'),
      available: $t('frameleaf_sharing.slug_available'),
    }[availability],
  );

  const loadOwnLinks = async () => {
    try {
      ownLinks = (await getAllSharedLinks({})) ?? [];
    } catch {
      // Without the list the field cannot say whether an address is free; the server still checks on save.
      ownLinks = undefined;
    }
  };

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
    refusedSlug = '';
    ownLinks = undefined;
    void loadOwnLinks();
  };

  let wasActive = false;
  $effect(() => {
    if (active && !wasActive) {
      resetFromLink();
    }
    wasActive = active;
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

  /* ---- AL-25: the preview aside (SharedLinkForm.jsx:137-171, 486-505) ---- */
  const hasPassword = $derived(editing ? (removePassword ? false : password ? true : !!link?.password) : !!password);
  const previewBadges = $derived(
    sharedLinkBadges({
      expiresAt,
      password: hasPassword ? 'set' : null,
      allowDownload,
      allowUpload,
      showMetadata,
    }),
  );
  const badgeIcons: Record<SharedLinkBadgeId, string> = {
    expired: mdiClockOutline,
    password: mdiLockOutline,
    download: mdiDownloadOutline,
    upload: mdiUpload,
    metadata: mdiInformationOutline,
    expiry: mdiClockOutline,
  };
  const expiresLabel = (at: string) =>
    $t('frameleaf_sharing.badge_expires', { values: { when: relativeTime(at, Date.now(), $locale ?? undefined) } });
  const badgeLabel = (id: SharedLinkBadgeId, at?: string) => {
    switch (id) {
      case 'expired': {
        return $t('expired');
      }
      case 'password': {
        return $t('password');
      }
      case 'download': {
        return $t('frameleaf_sharing.badge_downloads');
      }
      case 'upload': {
        return $t('frameleaf_sharing.badge_uploads');
      }
      case 'metadata': {
        return $t('frameleaf_sharing.badge_metadata');
      }
      case 'expiry': {
        return expiresLabel(at ?? new Date().toISOString());
      }
    }
  };
  /** The address the link will have: its custom one once free, or the one it already has. */
  const previewUrl = $derived.by(() => {
    const free = availability === 'available' && slug.trim();
    if (free) {
      // the address the new slug would give, not the link's current one
      return asUrl({ ...link, slug: free, key: link?.key ?? '', url: null } as SharedLinkResponseDto);
    }
    return link ? asUrl(link) : '';
  });
  const viewerSummary = $derived(
    [
      $t(
        showMetadata
          ? 'frameleaf_sharing.summary_items_with_metadata'
          : 'frameleaf_sharing.summary_items_without_metadata',
        { values: { count: itemCount } },
      ),
      $t(
        allowDownload
          ? allowUpload
            ? 'frameleaf_sharing.summary_download_upload'
            : 'frameleaf_sharing.summary_download_only'
          : allowUpload
            ? 'frameleaf_sharing.summary_upload_only'
            : 'frameleaf_sharing.summary_no_download',
      ),
      $t(hasPassword ? 'frameleaf_sharing.summary_password' : 'frameleaf_sharing.summary_no_password'),
      expiresAt
        ? $t('frameleaf_sharing.summary_expires', { values: { label: expiresLabel(expiresAt) } })
        : $t('frameleaf_sharing.summary_never_expires'),
    ].join(' '),
  );

  /** The Copy button shows a tick for a moment once the address is on the clipboard. */
  const COPIED_MS = 1500;
  let copied = $state(false);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  onDestroy(() => clearTimeout(copiedTimer));

  async function copyCreated() {
    try {
      await navigator.clipboard.writeText(createdUrl);
      copyStatus = $t('frameleaf_sharing.link_copied');
      copied = true;
      clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => (copied = false), COPIED_MS);
    } catch {
      copyStatus = $t('frameleaf_sharing.copy_unavailable');
    }
  }

  const onSlugTaken = () => {
    refusedSlug = slug.trim();
    error = $t('frameleaf_sharing.slug_taken');
  };

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (availability === 'invalid' || availability === 'taken') {
      error = slugMessage;
      return;
    }
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
        const success = await handleUpdateSharedLink(
          link,
          {
            description,
            slug: slug.trim() || null,
            allowDownload,
            allowUpload,
            showMetadata,
            expiresAt,
            password: removePassword ? null : password || undefined,
          },
          { onSlugTaken },
        );
        if (success) {
          onSaved?.();
        }
      } else {
        const saved = await handleCreateSharedLink(
          {
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
          },
          { onSlugTaken },
        );
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

{#if created}
  <div class="slf-created fl-reveal">
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
        {#if copied}
          <span class="slf-copied"><Icon icon={mdiCheck} size="18" /></span>
        {:else}
          <Icon icon={mdiContentCopy} size="18" />
        {/if}
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
  {#if !compact}
    <p class="slf-target">
      {type === SharedLinkType.Album
        ? $t('album_with_link_access')
        : $t('frameleaf_sharing.items_selected', { values: { count: assetCount } })}
      {#if name}<strong>{name}</strong>{/if}
    </p>
  {/if}

  <div class="slf-grid" class:is-compact={compact}>
    <form id={formId} class="slf-fields" aria-busy={saving} onsubmit={submit} novalidate>
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
            value={slug}
            maxlength="48"
            spellcheck="false"
            autocapitalize="off"
            placeholder={$t('frameleaf_sharing.slug_placeholder')}
            aria-describedby="{ids}-slug-hint"
            aria-invalid={availability === 'invalid' || availability === 'taken'}
            oninput={(event) => {
              slug = typingSlug(event.currentTarget.value);
              event.currentTarget.value = slug;
            }}
            onblur={() => (slug = normalizeSlug(slug))}
          />
        </div>
        <small id="{ids}-slug-hint" class="slf-slug-status" data-status={availability} role="status">
          {slugMessage}
        </small>
        {#if editing && link && (slug.trim() || null) !== (link.slug || null)}
          <p class="slf-warning" role="status">{$t('frameleaf_sharing.slug_change_warning')}</p>
        {/if}
      </div>

      <div class="slf-toggles">
        <!-- Metadata first: downloads depend on it, so the switch that unlocks them comes before them. -->
        <label class="slf-toggle">
          <span>
            <strong>{$t('show_metadata')}</strong>
            <small>{$t('frameleaf_sharing.show_metadata_description')}</small>
          </span>
          <input type="checkbox" role="switch" class="slf-switch" bind:checked={showMetadata} />
        </label>
        <label class="slf-toggle slf-dependent" class:is-off={!showMetadata}>
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

    <aside class="slf-preview" aria-label={$t('frameleaf_sharing.link_preview')}>
      {#if !compact}
        <AssetCollage ids={previewIds} count={itemCount} />
      {/if}
      <div class="slf-preview-body">
        <strong>{description.trim() || name}</strong>
        <small>
          {type === SharedLinkType.Album
            ? $t('frameleaf_sharing.preview_album', { values: { name } })
            : $t('frameleaf_sharing.preview_individual')} · {$t('frameleaf_sharing.individual_items', {
            values: { count: itemCount },
          })}
        </small>
        <p class="slf-url">
          <Icon icon={mdiLinkVariant} size="16" aria-hidden={true} />
          {#if previewUrl}
            <span>{previewUrl}</span>
          {:else}
            <span class="slf-muted">{$t('frameleaf_sharing.preview_address_pending')}</span>
          {/if}
        </p>
        <ul class="slf-badges" aria-label={$t('frameleaf_sharing.link_details')}>
          {#each previewBadges as badge (badge.id)}
            <li class="slf-badge" data-tone={badge.tone}>
              <Icon icon={badgeIcons[badge.id]} size="14" aria-hidden={true} />
              {badgeLabel(badge.id, badge.at)}
            </li>
          {/each}
        </ul>
        <p class="slf-summary">{viewerSummary}</p>
      </div>
    </aside>
  </div>
{/if}

<style>
  .slf-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(220px, 280px);
    gap: 1.25rem;
    align-items: start;
  }
  .slf-grid.is-compact {
    grid-template-columns: minmax(0, 1fr);
  }
  @media (max-width: 720px) {
    .slf-grid {
      grid-template-columns: minmax(0, 1fr);
    }
  }
  .slf-preview {
    display: flex;
    flex-direction: column;
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    overflow: hidden;
  }
  .slf-preview-body {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.75rem;
    min-width: 0;
  }
  .slf-preview-body strong {
    overflow-wrap: anywhere;
  }
  .slf-url {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    margin: 0;
    font-size: var(--fl-font-micro);
    overflow-wrap: anywhere;
  }
  .slf-muted {
    color: var(--fl-muted);
  }
  .slf-badges {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .slf-badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: var(--fl-font-micro);
    line-height: 1;
    color: var(--fl-muted);
    background: var(--fl-raised);
    border-radius: var(--fl-radius-pill);
    padding: 5px 9px;
  }
  .slf-badge[data-tone='danger'] {
    color: var(--fl-danger);
    background: color-mix(in srgb, var(--fl-danger), transparent 86%);
  }
  .slf-badge[data-tone='info'] {
    color: var(--fl-teal);
    background: color-mix(in srgb, var(--fl-teal), transparent 86%);
  }
  .slf-summary {
    margin: 0;
    color: var(--fl-muted);
    font-size: 0.8125rem;
  }
  .slf-slug-status[data-status='available'] {
    color: var(--fl-teal);
  }
  .slf-slug-status[data-status='invalid'],
  .slf-slug-status[data-status='taken'] {
    color: var(--fl-danger);
  }
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
  /* Downloads follow "Show metadata": dimmed while that is off, so the dependency is visible. */
  .slf-dependent {
    transition: opacity var(--fl-motion-fast) var(--fl-ease);
  }
  .slf-dependent.is-off {
    opacity: 0.5;
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
    font-family: var(--fl-family-mono);
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
  /* The new address is ringed in the accent for a moment, so the eye lands on what was made. */
  .slf-created input {
    animation: slf-address-ready calc(var(--fl-motion-slow) * 5) var(--fl-ease) both;
  }
  @keyframes slf-address-ready {
    from {
      box-shadow: 0 0 0 3px var(--fl-accent-soft);
      border-color: var(--fl-accent);
    }
  }
  .slf-copied {
    display: inline-flex;
    color: var(--fl-accent);
    animation: fl-pop-in var(--fl-duration-pop) var(--fl-spring) both;
  }
  .slf-created-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .slf-created-actions button,
  .slf-created-actions .button,
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
  .slf-status {
    color: var(--fl-muted);
    font-size: 0.875rem;
    min-height: 1.25rem;
  }
</style>
