<script lang="ts">
  /**
   * Large files (FL-47), ported from the large-files part of the design template's
   * `UtilitiesManager.jsx`: the largest originals first, with their account and logical size, a
   * fixed review before anything moves to the trash, an export of the list and an evidence view.
   *
   * The list is the server's (`searchLargeAssets`), so it already leaves out Locked media outside an
   * unlocked session and anything the owner's privacy filters hide. Moving to the trash goes through
   * `reviewTrash` and `applyTrashReview`: the reviewed items are frozen, and the server refuses when
   * one of them changed (already trashed, locked, hidden) since the review. Undo restores exactly
   * the items that moved, through the same review.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import {
    canTrashLargeFile,
    filterLargeFiles,
    LARGE_FILES_ALL_ACCOUNTS,
    largeFileExport,
    largeFileFormat,
    largeFileOwners,
    largeFileSize,
    largeFileStatus,
    type LargeFileShow,
  } from '$lib/frameleaf/large-files';
  import { formatBytes } from '$lib/frameleaf/physical-dedup';
  import { isStaleReview } from '$lib/frameleaf/trash';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { websocketEvents } from '$lib/stores/websocket';
  import { downloadJson, getAssetMediaUrl } from '$lib/utils';
  import {
    applyTrashReview,
    getUtilityActivity,
    UtilityActivityAction,
    UtilityActivityTool,
    type UtilityActivityEntryDto,
    AssetMediaSize,
    getPartners,
    PartnerDirection,
    reviewTrash,
    TrashReviewAction,
    type AssetResponseDto,
    type TrashReviewResponseDto,
  } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { DateTime } from 'luxon';
  import { mdiCheckCircleOutline, mdiClose, mdiDownload, mdiHistory, mdiUndo } from '@mdi/js';
  import { onMount } from 'svelte';
  import type { SvelteSet } from 'svelte/reactivity';
  import { t } from 'svelte-i18n';

  type Props = {
    assets: AssetResponseDto[];
    /** Items moved to the trash since the list loaded; the page's viewer skips them. */
    trashed: SvelteSet<string>;
    /** Items permanently deleted since the list loaded, here or anywhere else; the viewer skips them too. */
    removed: SvelteSet<string>;
    /** Open an item in the full viewer. */
    onOpen: (asset: AssetResponseDto) => void;
  };

  let { assets, trashed, removed, onOpen }: Props = $props();

  type Review = TrashReviewResponseDto & { rows: AssetResponseDto[] };

  let owner = $state(LARGE_FILES_ALL_ACCOUNTS);
  let query = $state('');
  let show = $state<LargeFileShow>('open');
  let selected = $state<string[]>([]);
  let partnerNames = $state<Record<string, string>>({});
  let notice = $state('');
  let error = $state('');
  let undoIds = $state<string[] | null>(null);
  let busy = $state(false);

  /**
   * UT-11: "Recent utility activity" (`UtilitiesManager.jsx:946-956`), newest first, drawn with the
   * settings history rows (`CommandCenter.jsx:2594-2622`, `.cc-history`). Owner decision (FL-146,
   * 2026-09-25): it is the server's persistent history of this owner's moves and undos made here
   * (`GET /trash/activity`), kept for a year, not this visit's. An item is named only while this
   * session may still see it; the others are counted.
   */
  let activity = $state<UtilityActivityEntryDto[]>([]);
  let activityError = $state(false);
  const loadActivity = async () => {
    try {
      ({ entries: activity } = await getUtilityActivity({ tool: UtilityActivityTool.LargeFiles }));
      activityError = false;
    } catch {
      activityError = true;
    }
  };

  let review = $state<Review | null>(null);
  let reviewOpen = $state(false);
  let inspect = $state<AssetResponseDto | null>(null);
  let inspectOpen = $state(false);

  const userId = $derived(authManager.user.id);
  const context = $derived({ userId, trashed });
  const trashEnabled = $derived(featureFlagsManager.value.trash);
  const present = $derived(assets.filter((asset) => !removed.has(asset.id)));

  const ownerName = (id: string) =>
    id === userId ? authManager.user.name : (partnerNames[id] ?? $t('frameleaf_large_files_other_account'));

  const statusText = (asset: AssetResponseDto) => {
    switch (largeFileStatus(asset, context)) {
      case 'trashed': {
        return $t('frameleaf_large_files_status_trashed');
      }
      case 'shared': {
        return $t('frameleaf_large_files_status_shared');
      }
      default: {
        return $t('frameleaf_large_files_status_open');
      }
    }
  };

  const rows = $derived(
    filterLargeFiles(present, context, {
      owner,
      show,
      query,
      describe: (asset) => `${ownerName(asset.ownerId)} ${statusText(asset)}`,
    }),
  );
  const editable = $derived(rows.filter((asset) => canTrashLargeFile(asset, context)));
  const chosen = $derived(editable.filter((asset) => selected.includes(asset.id)));
  const allChosen = $derived(editable.length > 0 && editable.every((asset) => selected.includes(asset.id)));
  const owners = $derived(largeFileOwners(present, userId));
  const viewBytes = $derived(rows.reduce((sum, asset) => sum + largeFileSize(asset), 0));

  const toggle = (id: string) => {
    selected = selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id];
  };

  /**
   * UT-15: the row's second line is the original's type and resolution, as the template's `format`
   * (`UtilitiesManager.jsx:258-262`); without either, the owner's path, then the size. A partner's
   * path is never shown.
   */
  const detail = (asset: AssetResponseDto) => {
    const { type, videoResolution, megapixels } = largeFileFormat(asset);
    const parts = [
      type,
      videoResolution,
      megapixels ? $t('frameleaf_large_files_megapixels', { values: { count: megapixels } }) : undefined,
    ].filter(Boolean);
    if (parts.length > 0) {
      return parts.join(' · ');
    }
    return asset.ownerId === userId ? asset.originalPath : formatBytes(largeFileSize(asset));
  };

  const failureMessage = (cause: unknown) =>
    isStaleReview(cause) ? $t('frameleaf_large_files_error_changed') : $t('frameleaf_large_files_error_unavailable');

  /** Freeze the chosen items on the server and show them before anything moves. */
  const ask = async () => {
    if (chosen.length === 0 || busy) {
      return;
    }
    const frozen = [...chosen];
    busy = true;
    error = '';
    try {
      const reviewed = await reviewTrash({
        trashReviewDto: { action: TrashReviewAction.Trash, ids: frozen.map((asset) => asset.id) },
      });
      review = { ...reviewed, rows: frozen };
      reviewOpen = true;
    } catch (error_) {
      error = failureMessage(error_);
    } finally {
      busy = false;
    }
  };

  const apply = async () => {
    if (!review || busy) {
      return;
    }
    const current = review;
    const ids = current.rows.map((asset) => asset.id);
    busy = true;
    try {
      const { count } = await applyTrashReview({
        trashApplyDto: {
          action: TrashReviewAction.Trash,
          ids,
          token: current.token,
          source: UtilityActivityTool.LargeFiles,
        },
      });
      for (const id of ids) {
        trashed.add(id);
      }
      selected = selected.filter((id) => !ids.includes(id));
      undoIds = ids;
      void loadActivity();
      notice = $t('frameleaf_large_files_moved', { values: { count } });
      error = '';
      reviewOpen = false;
      review = null;
    } catch (error_) {
      error = failureMessage(error_);
      reviewOpen = false;
      review = null;
    } finally {
      busy = false;
    }
  };

  /** Undo restores exactly the items that moved, and refuses if any of them changed since. */
  const undo = async () => {
    const ids = undoIds;
    if (!ids || busy) {
      return;
    }
    busy = true;
    try {
      const reviewed = await reviewTrash({ trashReviewDto: { action: TrashReviewAction.Restore, ids } });
      await applyTrashReview({
        trashApplyDto: {
          action: TrashReviewAction.Restore,
          ids,
          token: reviewed.token,
          source: UtilityActivityTool.LargeFiles,
        },
      });
      void loadActivity();
      for (const id of ids) {
        trashed.delete(id);
      }
      undoIds = null;
      notice = $t('frameleaf_large_files_undone');
    } catch (error_) {
      error = failureMessage(error_);
    } finally {
      busy = false;
    }
  };

  /**
   * The server trashed or deleted items elsewhere. When the one open in the evidence view left the
   * list, show the item that followed it (or the one before, at the end) rather than a gone item.
   */
  const leaveGone = (ids: readonly string[], before: readonly AssetResponseDto[]) => {
    const current = inspect;
    if (!inspectOpen || !current || !ids.includes(current.id) || rows.some((asset) => asset.id === current.id)) {
      return;
    }
    const still = new Set(rows.map((asset) => asset.id));
    const at = before.findIndex((asset) => asset.id === current.id);
    const next =
      before.slice(at + 1).find((asset) => still.has(asset.id)) ??
      before.slice(0, Math.max(at, 0)).findLast((asset) => still.has(asset.id));
    if (next) {
      inspect = next;
    } else {
      inspectOpen = false;
      inspect = null;
    }
  };

  const exportList = () => downloadJson(largeFileExport(rows, { owner, ownerName }), 'large-file-review.json');

  onMount(() => {
    void loadActivity();
    void getPartners({ direction: PartnerDirection.SharedWith })
      .then((partners) => {
        partnerNames = Object.fromEntries(partners.map((partner) => [partner.id, partner.name]));
      })
      .catch(() => {
        // names fall back to "Another account"; nothing else depends on them
      });

    const unsubscribers = [
      // the server's word on trash, restore and permanent deletion: from the viewer, another tab or device
      websocketEvents.on('on_asset_trash', (ids) => {
        const before = rows;
        const known = new Set(assets.map((asset) => asset.id));
        for (const id of ids) {
          if (known.has(id)) {
            trashed.add(id);
          }
        }
        selected = selected.filter((id) => !ids.includes(id));
        leaveGone(ids, before);
      }),
      websocketEvents.on('on_asset_restore', (ids) => {
        for (const id of ids) {
          trashed.delete(id);
        }
      }),
      websocketEvents.on('on_asset_delete', (id) => {
        const before = rows;
        removed.add(id);
        trashed.delete(id);
        selected = selected.filter((value) => value !== id);
        if (undoIds?.includes(id)) {
          undoIds = null;
        }
        leaveGone([id], before);
      }),
    ];
    return () => {
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
    };
  });
</script>

<div class="large-files">
  {#if error}
    <p role="alert" class="lf-message error">{error}</p>
  {/if}
  {#if notice}
    <div role="status" class="lf-message">
      <Icon icon={mdiCheckCircleOutline} size="1rem" aria-hidden={true} />
      <span>{notice}</span>
      {#if undoIds}
        <Button disabled={busy} onclick={() => void undo()}>
          <Icon icon={mdiUndo} size="1rem" aria-hidden={true} />
          {$t('frameleaf_large_files_undo')}
        </Button>
      {/if}
      <Button variant="quiet" label={$t('frameleaf_large_files_dismiss')} onclick={() => (notice = '')}>
        <Icon icon={mdiClose} size="1rem" aria-hidden={true} />
      </Button>
    </div>
  {/if}

  <div class="lf-toolbar">
    <label>
      {$t('frameleaf_large_files_account')}
      <select
        bind:value={owner}
        onchange={() => {
          selected = [];
        }}
      >
        <option value={LARGE_FILES_ALL_ACCOUNTS}>{$t('frameleaf_large_files_all_accounts')}</option>
        {#each owners as id (id)}
          <option value={id}>{ownerName(id)}</option>
        {/each}
      </select>
    </label>
    <label>
      {$t('frameleaf_large_files_find')}
      <input type="search" bind:value={query} placeholder={$t('frameleaf_large_files_find_placeholder')} />
    </label>
    <label>
      {$t('frameleaf_large_files_show')}
      <select
        bind:value={show}
        onchange={() => {
          selected = [];
        }}
      >
        <option value="open">{$t('frameleaf_large_files_show_open')}</option>
        <option value="all">{$t('frameleaf_large_files_show_all')}</option>
      </select>
    </label>
  </div>

  <div class="lf-stats">
    <span><strong>{formatBytes(viewBytes)}</strong> {$t('frameleaf_large_files_in_view')}</span>
    <span>{$t('frameleaf_large_files_order_note')}</span>
  </div>

  <div class="lf-toolbar">
    <Button disabled={chosen.length === 0 || busy || !trashEnabled} onclick={() => void ask()}>
      {$t('frameleaf_large_files_move_selected')}
    </Button>
    <Button disabled={rows.length === 0} onclick={exportList}>
      <Icon icon={mdiDownload} size="1rem" aria-hidden={true} />
      {$t('frameleaf_large_files_export')}
    </Button>
    {#if !trashEnabled}
      <span class="lf-hint">{$t('frameleaf_large_files_trash_off')}</span>
    {/if}
  </div>

  <div class="lf-table-scroll">
    <table>
      <thead>
        <tr>
          <th>
            <input
              type="checkbox"
              aria-label={$t('frameleaf_large_files_select_all')}
              checked={allChosen}
              disabled={editable.length === 0}
              onchange={() => (selected = allChosen ? [] : editable.map((asset) => asset.id))}
            />
          </th>
          <th>{$t('frameleaf_large_files_column_original')}</th>
          <th>{$t('frameleaf_large_files_column_account')}</th>
          <th>{$t('frameleaf_large_files_column_size')}</th>
          <th>{$t('frameleaf_large_files_column_review')}</th>
        </tr>
      </thead>
      <tbody>
        {#each rows as asset (asset.id)}
          <tr>
            <td>
              <input
                type="checkbox"
                aria-label={$t('frameleaf_large_files_select_item', { values: { name: asset.originalFileName } })}
                disabled={!canTrashLargeFile(asset, context)}
                checked={selected.includes(asset.id)}
                onchange={() => toggle(asset.id)}
              />
            </td>
            <td>
              <div class="lf-file">
                <button
                  type="button"
                  aria-label={$t('frameleaf_large_files_open', { values: { name: asset.originalFileName } })}
                  onclick={() => onOpen(asset)}
                >
                  <img
                    src={getAssetMediaUrl({ id: asset.id, size: AssetMediaSize.Thumbnail, cacheKey: asset.thumbhash })}
                    alt=""
                    loading="lazy"
                    draggable="false"
                  />
                </button>
                <span>
                  <strong>{asset.originalFileName}</strong>
                  <small>{detail(asset)}</small>
                </span>
              </div>
            </td>
            <td>
              {ownerName(asset.ownerId)}
              {#if largeFileStatus(asset, context) === 'shared'}
                <small>{$t('frameleaf_large_files_owner_required')}</small>
              {:else if largeFileStatus(asset, context) === 'trashed'}
                <small>{$t('frameleaf_large_files_status_trashed')}</small>
              {/if}
            </td>
            <td>{formatBytes(largeFileSize(asset))}</td>
            <td>
              <Button
                onclick={() => {
                  inspect = asset;
                  inspectOpen = true;
                }}
              >
                {$t('frameleaf_large_files_inspect')}
              </Button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
    {#if rows.length === 0}
      <div class="lf-empty">
        <Icon icon={mdiCheckCircleOutline} size="1.75rem" aria-hidden={true} />
        <h3>{$t('frameleaf_large_files_empty_title')}</h3>
        <p>{$t('frameleaf_large_files_empty_help')}</p>
      </div>
    {/if}
  </div>

  {#if activity.length > 0 || activityError}
    <details class="lf-history">
      <summary>{$t('library_care_recent_activity')}</summary>
      {#if activityError}
        <p role="alert" class="lf-history-error">{$t('frameleaf_large_files_activity_unavailable')}</p>
      {/if}
      <div class="cc-history">
        {#each activity as entry (entry.id)}
          <article>
            <div>
              <Icon icon={mdiHistory} size="1rem" aria-hidden={true} />
              <strong>
                {entry.action === UtilityActivityAction.Trash
                  ? $t('frameleaf_large_files_activity_trash')
                  : $t('frameleaf_large_files_activity_restore')} · {$t('library_care_activity_items', {
                  values: { count: entry.itemCount },
                })}{entry.bytes > 0 ? ` · ${formatBytes(entry.bytes)}` : ''}
              </strong>
              <time datetime={entry.createdAt}>
                {DateTime.fromISO(entry.createdAt).toLocaleString(DateTime.DATETIME_MED)}
              </time>
            </div>
            {#if entry.items.length > 0}
              <details>
                <summary>{$t('frameleaf_large_files_activity_view_items')}</summary>
                {#each entry.items as item (item.assetId)}
                  <p>
                    <strong>{item.fileName}</strong>
                    <span>{formatBytes(item.bytes)}</span>
                  </p>
                {/each}
              </details>
            {/if}
            {#if entry.unavailableCount > 0}
              <small>
                {$t('frameleaf_large_files_activity_not_shown', { values: { count: entry.unavailableCount } })}
              </small>
            {/if}
          </article>
        {/each}
      </div>
    </details>
  {/if}
</div>

<Dialog title={inspect?.originalFileName ?? ''} closeLabel={$t('close')} bind:open={inspectOpen}>
  {#if inspect}
    <div class="lf-dialog">
      <div class="lf-evidence">
        <img
          src={getAssetMediaUrl({ id: inspect.id, size: AssetMediaSize.Preview, cacheKey: inspect.thumbhash })}
          alt={inspect.originalFileName}
        />
        <dl>
          <dt>{$t('frameleaf_large_files_column_account')}</dt>
          <dd>{ownerName(inspect.ownerId)}</dd>
          <dt>{$t('frameleaf_large_files_original_size')}</dt>
          <dd>{formatBytes(largeFileSize(inspect))}</dd>
          <dt>{$t('frameleaf_large_files_status')}</dt>
          <dd>{statusText(inspect)}</dd>
          {#if inspect.ownerId === userId}
            <dt>{$t('frameleaf_large_files_original_path')}</dt>
            <dd>{inspect.originalPath}</dd>
          {/if}
        </dl>
      </div>
      <div class="lf-dialog-actions">
        <Button onclick={() => (inspectOpen = false)}>{$t('frameleaf_large_files_done')}</Button>
      </div>
    </div>
  {/if}
</Dialog>

<Dialog title={$t('frameleaf_large_files_review_title')} closeLabel={$t('cancel')} bind:open={reviewOpen}>
  {#if review}
    <div class="lf-dialog">
      <p>{$t('frameleaf_large_files_review_fixed')}</p>
      <div class="lf-review-rows">
        {#each review.rows as asset (asset.id)}
          <div>
            <strong>{asset.originalFileName}</strong>
            <span>{ownerName(asset.ownerId)} · {formatBytes(largeFileSize(asset))}</span>
          </div>
        {/each}
      </div>
      <p>{$t('frameleaf_large_files_review_retained_note')}</p>
      {#if review.retainedOriginals > 0}
        <p>
          {$t('frameleaf_large_files_review_shared', {
            values: { count: review.retainedOriginals, size: formatBytes(review.retainedBytes) },
          })}
        </p>
      {/if}
      <div class="lf-dialog-actions">
        <Button onclick={() => (reviewOpen = false)}>{$t('cancel')}</Button>
        <Button variant="primary" disabled={busy} onclick={() => void apply()}>
          {$t('frameleaf_large_files_review_confirm', { values: { count: review.count } })}
        </Button>
      </div>
    </div>
  {/if}
</Dialog>

<style>
  /* UtilitiesManager.jsx:946-956, utilities-manager.css .um-history */
  .lf-history {
    margin-top: 24px;
    border-top: 1px solid var(--fl-border);
    padding: 18px 0;
  }
  .lf-history summary {
    cursor: pointer;
  }
  .lf-history-error {
    color: var(--fl-danger);
  }
  /* command-center.css:1012-1051 (.cc-history) */
  .cc-history article {
    padding: 20px 0;
    border-bottom: 1px solid var(--fl-border);
  }
  .cc-history article > div {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
  }
  .cc-history strong {
    font-size: 12px;
    font-weight: 500;
  }
  .cc-history time {
    margin-left: auto;
    color: var(--fl-muted);
    font-size: 11px;
  }
  .cc-history small {
    display: block;
    color: var(--fl-muted);
    font-size: 10px;
    margin-top: 10px;
  }
  .cc-history details {
    margin-top: 15px;
  }
  .cc-history details summary {
    font-size: 11px;
    color: var(--fl-muted);
  }
  .cc-history details p {
    display: flex;
    gap: 20px;
    margin: 6px 0 0;
    font-size: 11px;
  }
  .cc-history details span {
    color: var(--fl-muted);
  }
  .large-files {
    min-width: 0;
    color: var(--fl-text);
    font-size: var(--fl-font-small);
  }
  .lf-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    gap: 12px;
    padding: 14px 0;
  }
  .lf-toolbar > label {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 8px;
    min-width: 140px;
    max-width: 280px;
    font-size: var(--fl-font-micro);
    color: var(--fl-muted);
  }
  .lf-toolbar input,
  .lf-toolbar select {
    width: 100%;
    padding: 10px;
    font-size: var(--fl-font-small);
    color: var(--fl-text);
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .lf-hint {
    align-self: center;
    font-size: var(--fl-font-micro);
    color: var(--fl-muted);
  }
  .lf-stats {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 16px 30px;
    margin: 8px 0;
    padding: 18px 0;
    color: var(--fl-muted);
    border-block: 1px solid var(--fl-border);
  }
  .lf-stats strong {
    margin-right: 7px;
    font-size: 24px;
    font-weight: 550;
    color: var(--fl-text);
  }
  .lf-message {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
    background: var(--fl-panel);
    border-left: 2px solid var(--fl-accent);
  }
  .lf-message > span {
    flex: 1;
  }
  .lf-message.error {
    border-color: var(--fl-danger);
  }
  .lf-table-scroll {
    overflow: auto;
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  table {
    width: 100%;
    border-collapse: collapse;
    text-align: left;
  }
  th {
    padding: 13px;
    font-size: var(--fl-font-micro);
    font-weight: 500;
    white-space: nowrap;
    color: var(--fl-muted);
    background: var(--fl-canvas);
  }
  td {
    padding: 14px 12px;
    border-top: 1px solid var(--fl-border);
  }
  td:first-child {
    width: 20px;
  }
  td > small {
    display: block;
    margin-top: 5px;
    font-size: var(--fl-font-micro);
    color: var(--fl-muted);
  }
  input[type='checkbox'] {
    width: 16px;
    height: 16px;
    margin: 0;
    accent-color: var(--fl-accent);
  }
  .lf-file {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 200px;
  }
  .lf-file button {
    flex-shrink: 0;
    padding: 0;
    border-radius: var(--fl-radius-control);
    overflow: hidden;
  }
  .lf-file img {
    display: block;
    width: 66px;
    height: 48px;
    object-fit: cover;
    background: var(--fl-raised);
  }
  .lf-file strong {
    display: block;
    font-weight: 500;
    overflow-wrap: anywhere;
  }
  .lf-file small {
    display: block;
    max-width: 260px;
    margin-top: 6px;
    font-size: var(--fl-font-micro);
    color: var(--fl-muted);
    overflow-wrap: anywhere;
  }
  .lf-empty {
    padding: 45px 20px;
    text-align: center;
    color: var(--fl-muted);
  }
  .lf-empty h3 {
    margin-top: 16px;
    color: var(--fl-text);
  }
  .lf-dialog {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: min(32rem, 100%);
    margin-top: 12px;
    font-size: var(--fl-font-small);
  }
  .lf-dialog p {
    color: var(--fl-muted);
    line-height: 1.6;
  }
  .lf-evidence {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 22px;
  }
  .lf-evidence img {
    width: 100%;
    max-height: 400px;
    object-fit: contain;
    background: var(--fl-canvas);
  }
  .lf-evidence dl {
    margin: 0;
    line-height: 1.6;
  }
  .lf-evidence dt {
    font-size: var(--fl-font-micro);
    color: var(--fl-muted);
  }
  .lf-evidence dd {
    margin: 4px 0 16px;
    overflow-wrap: anywhere;
  }
  .lf-review-rows {
    max-height: 50vh;
    overflow: auto;
  }
  .lf-review-rows > div {
    display: flex;
    flex-direction: column;
    gap: 7px;
    padding: 15px 0;
    border-block-start: 1px solid var(--fl-border);
  }
  .lf-review-rows span {
    font-size: var(--fl-font-micro);
    color: var(--fl-muted);
  }
  .lf-dialog-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 8px;
  }
  @media (max-width: 700px) {
    .lf-evidence {
      grid-template-columns: 1fr;
    }
    .lf-toolbar > label {
      min-width: 130px;
      max-width: none;
    }
  }
</style>
