<script lang="ts">
  import Button from '$lib/components/frameleaf/Button.svelte';
  import PublicDownloadStrip from '$lib/components/frameleaf/PublicDownloadStrip.svelte';
  import PublicShellFrame from '$lib/components/frameleaf/PublicShellFrame.svelte';
  import { canSendCopies, sendCopyPermitted } from '$lib/frameleaf/send-copy';
  import { locale } from '$lib/stores/preferences.store';
  import type { SharedLinkResponseDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import {
    mdiCheckboxMultipleMarkedOutline,
    mdiDownloadOutline,
    mdiExportVariant,
    mdiSelectOff,
    mdiUpload,
  } from '@mdi/js';
  import { DateTime } from 'luxon';
  import type { Snippet } from 'svelte';
  import { t } from 'svelte-i18n';

  /**
   * The public shared-link page's own shell (prototype `PublicViewer.jsx`, FL-56) inside the public
   * frame (`PublicShellFrame`: brand header and "Go to Frameleaf" footer): the share's title with
   * "Shared by … · N items · expires …", the three header actions — Add photos, Select / Done,
   * Download all / Download selected (n) — and the selection bar of Select mode.
   *
   * Every action is gated on the link exactly as the server returned it: Add photos only with
   * `allowUpload`, the download button only with `allowDownload`. The server enforces both again.
   *
   * FL-35 / FL-54: in Select mode a link that allows downloads and shows metadata (an original
   * carries its metadata) also offers "Send a copy…", the
   * browser's share sheet with the selected originals (App.jsx:818-846), where the browser can share
   * files. It is a copy, not another link: nothing about the share changes.
   *
   * "Shared by" reads the link's own `owner`, which carries only the owner's display name (FL-83). The
   * avatar is the name's initial: a public visitor cannot fetch the owner's profile image.
   */
  interface Props {
    sharedLink: SharedLinkResponseDto;
    title: string;
    count: number;
    /** Select mode; a tile picked some other way (its checkbox) turns it on too. */
    selecting: boolean;
    selectedCount: number;
    onSelectingChange: (selecting: boolean) => void;
    onUpload: () => void;
    onDownloadAll: () => void;
    onDownloadSelected: () => void;
    /** Send copies of the selected items through the share sheet. */
    onSendCopy?: () => void;
    onSelectAll: () => void;
    onClear: () => void;
    /**
     * Leave the Select mode bar out: the owner of an individual link prunes it from the library's own
     * selection bar, which already counts the selection, so a second counter would repeat it.
     */
    noSelectBar?: boolean;
    children: Snippet;
  }

  let {
    sharedLink,
    title,
    count,
    selecting,
    selectedCount,
    onSelectingChange,
    onUpload,
    onDownloadAll,
    onDownloadSelected,
    onSendCopy,
    onSelectAll,
    onClear,
    noSelectBar = false,
    children,
  }: Props = $props();

  const ownerName = $derived(sharedLink.owner?.name?.trim() || undefined);
  const expires = $derived(
    sharedLink.expiresAt ? DateTime.fromISO(sharedLink.expiresAt).toRelative({ locale: $locale }) : null,
  );
  const meta = $derived(
    [
      ownerName ? $t('frameleaf_public_shared_by', { values: { name: ownerName } }) : null,
      $t('frameleaf_public_item_count', { values: { count } }),
      expires ? $t('frameleaf_public_expires', { values: { when: expires } }) : null,
    ]
      .filter(Boolean)
      .join(' · '),
  );
</script>

<PublicShellFrame>
  {#snippet header()}
    <div class="pv-title">
      <h1>{title}</h1>
      <span>
        {#if ownerName}
          <span class="pv-avatar" aria-hidden="true">{Array.from(ownerName)[0]?.toLocaleUpperCase()}</span>
        {/if}
        {meta}
      </span>
    </div>
    <div class="pv-actions">
      {#if sharedLink.allowUpload}
        <Button onclick={onUpload}>
          <Icon icon={mdiUpload} size="18" aria-hidden={true} />
          {$t('add_photos')}
        </Button>
      {/if}
      <Button pressed={selecting} onclick={() => onSelectingChange(!selecting)}>
        <Icon icon={selecting ? mdiSelectOff : mdiCheckboxMultipleMarkedOutline} size="18" aria-hidden={true} />
        {selecting ? $t('frameleaf_public_done') : $t('frameleaf_public_select')}
      </Button>
      {#if selecting && onSendCopy && sendCopyPermitted(sharedLink) && canSendCopies()}
        <Button disabled={selectedCount === 0} onclick={onSendCopy}>
          <Icon icon={mdiExportVariant} size="18" aria-hidden={true} />
          {$t('frameleaf_send_copy')}
        </Button>
      {/if}
      {#if sharedLink.allowDownload}
        <Button
          variant="primary"
          disabled={selecting ? selectedCount === 0 : count === 0}
          onclick={selecting ? onDownloadSelected : onDownloadAll}
        >
          <Icon icon={mdiDownloadOutline} size="18" aria-hidden={true} />
          {selecting
            ? $t('frameleaf_public_download_selected', { values: { count: selectedCount } })
            : $t('frameleaf_public_download_all')}
        </Button>
      {/if}
    </div>
  {/snippet}

  {#snippet belowHeader()}
    {#if selecting && !noSelectBar}
      <div class="pv-selectbar" role="toolbar" aria-label={$t('frameleaf_public_selection')}>
        <span aria-live="polite"
          >{$t('frameleaf_public_selected_of', { values: { count: selectedCount, total: count } })}</span
        >
        <Button onclick={onSelectAll}>{$t('select_all')}</Button>
        <Button disabled={selectedCount === 0} onclick={onClear}>{$t('clear')}</Button>
      </div>
    {/if}
    {#if sharedLink.allowDownload}
      <!-- PublicViewer.jsx:401-427: the archive job strip under the header, not the Downloads panel. -->
      <PublicDownloadStrip />
    {/if}
  {/snippet}

  {@render children()}
</PublicShellFrame>

<style>
  .pv-title {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 0.125rem;
    min-width: 12rem;
  }
  .pv-title h1 {
    margin: 0;
    overflow: hidden;
    font-size: 1.125rem;
    font-weight: 650;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pv-title > span {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .pv-avatar {
    display: inline-grid;
    place-items: center;
    width: 1.5rem;
    height: 1.5rem;
    border-radius: 50%;
    background: var(--fl-raised);
    color: var(--fl-text);
    font-size: var(--fl-font-micro);
    font-weight: 600;
  }
  .pv-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }
  .pv-selectbar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 1rem;
    border-bottom: 1px solid var(--fl-border);
    background: var(--fl-panel);
    font-size: var(--fl-font-small);
  }
  .pv-selectbar > span {
    flex: 1;
  }
</style>
