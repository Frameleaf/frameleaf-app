<script lang="ts">
  import Brand from '$lib/components/frameleaf/Brand.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import '$lib/frameleaf/tokens.css';
  import { locale } from '$lib/stores/preferences.store';
  import type { SharedLinkResponseDto } from '@immich/sdk';
  import { Icon, Theme as AppTheme, themeManager } from '@immich/ui';
  import { mdiCheckboxMultipleMarkedOutline, mdiDownloadOutline, mdiSelectOff, mdiUpload } from '@mdi/js';
  import { DateTime } from 'luxon';
  import type { Snippet } from 'svelte';
  import { t } from 'svelte-i18n';

  /**
   * The public shared-link page's own shell (prototype `PublicViewer.jsx`, FL-56): the brand, the
   * share's title with "Shared by … · N items · expires …", the three header actions — Add photos,
   * Select / Done, Download all / Download selected (n) — the selection bar of Select mode, and the
   * "Go to Frameleaf" footer. No rail, top bar or account menu reaches a public visitor.
   *
   * Every action is gated on the link exactly as the server returned it: Add photos only with
   * `allowUpload`, the download button only with `allowDownload`. The server enforces both again.
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
    onSelectAll: () => void;
    onClear: () => void;
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
    onSelectAll,
    onClear,
    children,
  }: Props = $props();

  const ownerName = $derived(sharedLink.owner?.name?.trim() || undefined);
  const appTheme = $derived(themeManager.value === AppTheme.Dark ? 'dark' : 'light');
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

<div class="frameleaf public-viewer" data-theme={appTheme}>
  <header class="pv-header">
    <a class="pv-brand" href="/" data-sveltekit-preload-data="hover">
      <Brand />
    </a>
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
  </header>

  {#if selecting}
    <div class="pv-selectbar" role="toolbar" aria-label={$t('frameleaf_public_selection')}>
      <span aria-live="polite"
        >{$t('frameleaf_public_selected_of', { values: { count: selectedCount, total: count } })}</span
      >
      <Button onclick={onSelectAll}>{$t('select_all')}</Button>
      <Button disabled={selectedCount === 0} onclick={onClear}>{$t('clear')}</Button>
    </div>
  {/if}

  <main class="pv-main">
    {@render children()}
  </main>

  <footer class="pv-footer">
    <a class="pv-exit" href="/" data-sveltekit-preload-data="hover">{$t('frameleaf_public_go_home')}</a>
  </footer>
</div>

<style>
  .public-viewer {
    display: flex;
    flex-direction: column;
    height: 100dvh;
    color: var(--fl-text);
    background: var(--fl-canvas);
  }
  .pv-header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem 1.25rem;
    padding: 0.75rem 1rem;
    background: color-mix(in srgb, var(--fl-canvas), transparent 12%);
    border-bottom: 1px solid var(--fl-border);
  }
  .pv-brand {
    display: inline-flex;
    flex-shrink: 0;
    width: 8.5rem;
  }
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
  .pv-main {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 0 0.5rem;
  }
  .pv-footer {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    padding: 0.5rem 1rem;
    border-top: 1px solid var(--fl-border);
    font-size: var(--fl-font-small);
  }
  .pv-exit {
    color: var(--fl-accent);
    font-weight: 560;
  }
  .pv-exit:hover {
    text-decoration: underline;
  }
  @media (min-width: 768px) {
    .pv-main {
      padding: 0 1.5rem;
    }
  }
</style>
