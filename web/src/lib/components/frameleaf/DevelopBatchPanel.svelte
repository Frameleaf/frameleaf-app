<script lang="ts">
  import Button from './Button.svelte';
  import { Icon } from '@frameleaf/ui';
  import { mdiImageEditOutline } from '@mdi/js';
  import {
    cancelDevelopBatch,
    confirmDevelopBatchReturns,
    createDevelopBatch,
    getBaseUrl,
    getDevelopBatch,
    getDevelopBatches,
    prepareDevelopBatchItem,
    importDevelopBatchReturn,
    matchDevelopBatchReturns,
    type DevelopBatchResponseDto,
    type DevelopBatchSummaryDto,
    type DevelopBatchItemResponseDto,
    type DevelopBatchMatchResponseDto,
  } from '@frameleaf/sdk';
  import { hasDevelopBatches, batchErrorCode, batchReason } from '$lib/frameleaf/develop-batches';
  import { hashFile } from '$lib/workers/hash-file';
  import { locale } from '$lib/stores/preferences.store';
  import { onMount } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';
  let { assetIds = [], initialBatchId }: { assetIds?: string[]; initialBatchId?: string } = $props();
  let batches = $state<DevelopBatchSummaryDto[]>([]),
    nextCursor = $state<string | null>(null),
    batch = $state<DevelopBatchResponseDto | null>(null),
    files = $state<File[]>([]),
    matches = $state<DevelopBatchMatchResponseDto[]>([]);
  let busy = $state(false),
    uploading = $state(false),
    supported = $state(true),
    error = $state(''),
    currentFile = $state(''),
    localErrors = $state<Record<number, string>>({}),
    completed = $state(0);
  let stop = false;
  let disposed = false;
  // only an imported return changes on its own (the server renders it); a confirmed one waits for its file
  const rendering = (value: DevelopBatchResponseDto) =>
    value.status === 'open' &&
    value.items.some((item) => item.returns.some((returned) => returned.status === 'imported'));
  const reason = (code: string | null | undefined) => $t(`frameleaf_batch.reason_${batchReason(code)}` as Translations);
  const prepared = $derived(
    batch?.items.filter((item) => item.available && item.preparationStatus === 'prepared').length ?? 0,
  );
  const pending = $derived(
    batch?.items.filter((item) => item.available && item.preparationStatus === 'pending').length ?? 0,
  );
  const excluded = $derived(
    batch?.items.filter((item) => !item.available || item.preparationStatus === 'failed').length ?? 0,
  );
  const canImport = $derived(
    matches.some((row) => row.status === 'matched' && row.itemId) &&
      matches.every((row) => row.status === 'skipped' || row.status === 'matched'),
  );
  const failedFiles = $derived(matches.filter((row) => typeof localErrors[row.index] === 'string'));
  const showError = (error_: unknown) => {
    error = reason(batchErrorCode(error_));
  };
  const load = async () => {
    const page = await getDevelopBatches({});
    batches = page.items;
    nextCursor = page.nextCursor;
    if (batch) {
      batch = await getDevelopBatch({ id: batch.id });
    }
  };
  // Bumped by every operation: a poll that started before one (a cancel, say) is older than its answer.
  let operations = 0;
  const perform = async (operation: () => Promise<void>) => {
    operations++;
    busy = true;
    error = '';
    try {
      await operation();
    } catch (error_) {
      showError(error_);
    } finally {
      operations++;
      busy = false;
    }
  };
  const loadMore = async () => {
    if (!nextCursor) {
      return;
    }
    const page = await getDevelopBatches({ cursor: nextCursor });
    batches = [...batches, ...page.items];
    nextCursor = page.nextCursor;
  };
  const selectBatch = async (id: string) => {
    batch = await getDevelopBatch({ id });
    files = [];
    matches = [];
    localErrors = {};
    completed = 0;
  };
  onMount(() => {
    void perform(async () => {
      supported = await hasDevelopBatches();
      if (!supported) {
        return;
      }
      await load();
      if (initialBatchId) {
        await selectBatch(initialBatchId);
      }
    });
    // Only returns the server is still rendering change on their own; a settled, hidden or
    // already-refreshing batch is not polled, so an idle page makes no requests.
    let polling = false;
    const timer = setInterval(() => {
      if (!batch || busy || uploading || polling || document.hidden || !rendering(batch)) {
        return;
      }
      const id = batch.id;
      const operation = operations;
      polling = true;
      void getDevelopBatch({ id })
        .then((value) => {
          if (!disposed && batch?.id === id && operation === operations && !uploading) {
            batch = value;
          }
        })
        .catch((error_) => {
          // a poll for a batch no longer shown, or overtaken by an operation, has nothing to say about it
          if (!disposed && batch?.id === id && operation === operations) {
            showError(error_);
          }
        })
        .finally(() => (polling = false));
    }, 2500);
    return () => {
      stop = true;
      disposed = true;
      clearInterval(timer);
    };
  });
  const create = () =>
    perform(async () => {
      batch = await createDevelopBatch({ developBatchCreateDto: { assetIds, includeSidecars: true } });
      files = [];
      matches = [];
      await load();
    });
  const mergeItem = (item: DevelopBatchItemResponseDto) => {
    if (batch) {
      batch = { ...batch, items: batch.items.map((existing) => (existing.id === item.id ? item : existing)) };
    }
  };
  const prepare = () =>
    perform(async () => {
      if (!batch) {
        return;
      }
      stop = false;
      for (const item of batch.items) {
        if (stop) {
          break;
        }
        if (item.available && item.preparationStatus !== 'prepared') {
          try {
            mergeItem(await prepareDevelopBatchItem({ id: batch.id, itemId: item.id }));
          } catch (error_) {
            showError(error_);
          }
        }
      }
      await load();
    });
  const matchFiles = async (selected: File[]) => {
    if (!batch) {
      return;
    }
    files = selected;
    matches = [];
    localErrors = {};
    completed = 0;
    await perform(async () => {
      const metadata = [];
      for (const file of selected) {
        metadata.push({ fileName: file.webkitRelativePath || file.name, checksum: await hashFile(file) });
      }
      matches = await matchDevelopBatchReturns({ id: batch!.id, developBatchMatchDto: { files: metadata } });
    });
  };
  const mapFile = (index: number, itemId: string) =>
    perform(async () => {
      if (!batch) {
        return;
      }
      const metadata = matches.map((row) => ({
        fileName: row.fileName,
        checksum: row.checksum,
        ...(((row.index === index && itemId === 'skip') || (row.index !== index && row.status === 'skipped')) && {
          skip: true,
        }),
        ...((row.index === index ? itemId : row.itemId) &&
          (row.index !== index || itemId !== 'skip') && { itemId: (row.index === index ? itemId : row.itemId)! }),
      }));
      matches = await matchDevelopBatchReturns({ id: batch.id, developBatchMatchDto: { files: metadata } });
    });
  const importFiles = async (retry = false) => {
    if (!batch || !canImport || uploading) {
      return;
    }
    uploading = true;
    stop = false;
    error = '';
    const selected = matches.filter(
      (row) => row.status === 'matched' && row.itemId && (!retry || localErrors[row.index]),
    );
    try {
      batch = await confirmDevelopBatchReturns({
        id: batch.id,
        developBatchConfirmDto: {
          files: selected.map((row) => ({ fileName: row.fileName, checksum: row.checksum, itemId: row.itemId! })),
        },
      });
      for (const row of selected) {
        if (stop) {
          break;
        }
        const returned = batch.items
          .find((item) => item.id === row.itemId)
          ?.returns.find((returned) => returned.checksum === row.checksum);
        if (!returned) {
          throw new Error($t('frameleaf_batch.review_again'));
        }
        currentFile = row.fileName;
        try {
          mergeItem(
            await importDevelopBatchReturn({
              id: batch.id,
              itemId: row.itemId!,
              developBatchImportDto: {
                file: files[row.index],
                confirmationId: returned.confirmationId,
                renditionChecksum: row.checksum,
              },
            }),
          );
          const next = { ...localErrors };
          delete next[row.index];
          localErrors = next;
          completed++;
        } catch (error_) {
          localErrors = { ...localErrors, [row.index]: reason(batchErrorCode(error_)) };
        }
      }
    } catch (error_) {
      showError(error_);
    } finally {
      uploading = false;
      currentFile = '';
      await load().catch(showError);
    }
  };
  const cancel = async () => {
    if (!batch) {
      return;
    }
    stop = true;
    await perform(async () => {
      batch = await cancelDevelopBatch({ id: batch!.id });
    });
  };
  const retryReturn = (itemId: string, confirmationId: string, checksum: string) =>
    perform(async () => {
      if (batch) {
        mergeItem(
          await importDevelopBatchReturn({
            id: batch.id,
            itemId,
            developBatchImportDto: { confirmationId, renditionChecksum: checksum },
          }),
        );
      }
    });
</script>

<section class="batch-editor" aria-label={$t('frameleaf_batch.title')}>
  <p>{$t('frameleaf_batch.help')}</p>
  {#if error}<p role="alert">{error}</p>{/if}
  {#if !supported}
    <p>{$t('frameleaf_batch.old_server')}</p>
  {:else}
    {#if assetIds.length === 0 && batches.length === 0 && !batch && !busy}
      <!-- Opened on its own with nothing exported yet: say how a batch starts. -->
      <div class="empty">
        <Icon icon={mdiImageEditOutline} size="2rem" aria-hidden={true} />
        <h2>{$t('frameleaf_batch.empty_title')}</h2>
        <p>{$t('frameleaf_batch.empty_body')}</p>
        <div class="buttons">
          <a class="button" href="/photos">{$t('frameleaf_batch.empty_open_library')}</a>
          <Button disabled={busy || uploading} onclick={() => void perform(load)}>{$t('refresh')}</Button>
        </div>
      </div>
    {:else if assetIds.length > 0 || batches.length === 0}<div class="buttons">
        {#if assetIds.length > 0}<Button variant="primary" disabled={busy || uploading} onclick={() => void create()}
            >{$t('frameleaf_batch.create', { values: { count: assetIds.length } })}</Button
          >{/if}
        <!-- With batches to resume, Refresh sits at the end of their picker's row instead. -->
        {#if batches.length === 0}<Button disabled={busy || uploading} onclick={() => void perform(load)}
            >{$t('refresh')}</Button
          >{/if}
      </div>{/if}
    {#if batches.length > 0}
      <div class="field">
        <label for="editing-batch">{$t('frameleaf_batch.resume')}</label>
        <div class="select-row">
          <select
            id="editing-batch"
            value={batch?.id ?? ''}
            disabled={busy || uploading}
            onchange={(event) => {
              const id = event.currentTarget.value;
              if (id) {
                void perform(() => selectBatch(id));
              }
            }}
          >
            <option value="">{$t('frameleaf_batch.choose')}</option>
            {#each batches as entry (entry.id)}<option value={entry.id}
                >{new Date(entry.createdAt).toLocaleString($locale)} · {$t('frameleaf_batch.photo_count', {
                  values: { count: entry.itemCount },
                })} · {$t(`frameleaf_batch.${entry.status}` as Translations)}</option
              >{/each}
          </select>
          <Button disabled={busy || uploading} onclick={() => void perform(load)}>{$t('refresh')}</Button>
        </div>
      </div>
      {#if nextCursor}<Button disabled={busy || uploading} onclick={() => void perform(loadMore)}
          >{$t('load_more')}</Button
        >{/if}
    {/if}
    {#if batch}
      <!-- Step 1: the originals go out as a ZIP. -->
      <div class="step">
        <div class="step-head">
          <h3>{$t('frameleaf_batch.step_export')}</h3>
          <span class="pill" data-tone={batch.status}>{$t(`frameleaf_batch.${batch.status}` as Translations)}</span>
        </div>
        <p role="status">
          {$t('frameleaf_batch.prepared_count', { values: { prepared, total: batch.items.length } })}
        </p>
        <progress max={batch.items.length || 1} value={prepared}></progress>
        {#if prepared < batch.items.length && batch.status !== 'cancelled'}<p>
            {$t('frameleaf_batch.prepare_help')}
          </p>{/if}
        <p>{$t('frameleaf_batch.export_counts', { values: { included: prepared, skipped: excluded } })}</p>
        {#if excluded > 0}<p>{$t('frameleaf_batch.exclusions_help')}</p>{/if}
        <div class="buttons">
          {#if prepared < batch.items.length && batch.status !== 'cancelled'}<Button
              variant={prepared > 0 && pending === 0 ? 'default' : 'primary'}
              disabled={busy || uploading}
              onclick={() => void prepare()}>{$t('frameleaf_batch.prepare')}</Button
            >{/if}
          {#if prepared > 0 && pending === 0 && batch.status !== 'cancelled'}<a
              class="button"
              href={`${getBaseUrl()}/develop-batches/${batch.id}/download`}
              download>{$t('frameleaf_batch.download')}</a
            >{/if}
        </div>
      </div>
      {#if batch.status !== 'cancelled'}
        <!-- Step 2: the edited files come back and are matched to their originals. -->
        <div class="step">
          <div class="step-head"><h3>{$t('frameleaf_batch.step_return')}</h3></div>
          <p>{$t('frameleaf_batch.reselect')}</p>
          <div class="buttons">
            <label class="file-button" for="returned-files"
              >{$t('frameleaf_batch.files')}<input
                id="returned-files"
                type="file"
                multiple
                disabled={busy || uploading}
                onchange={(event) => void matchFiles([...(event.currentTarget.files ?? [])])}
              /></label
            >
            <label class="file-button" for="returned-folder"
              >{$t('frameleaf_batch.folder')}<input
                id="returned-folder"
                type="file"
                multiple
                webkitdirectory
                disabled={busy || uploading}
                onchange={(event) => void matchFiles([...(event.currentTarget.files ?? [])])}
              /></label
            >
          </div>
          {#if matches.length > 0}
            <h4>{$t('frameleaf_batch.review')}</h4>
            <p>{$t('frameleaf_batch.review_help')}</p>
            <ul class="rows">
              {#each matches as row (row.index)}
                <li>
                  <div class="row-head">
                    <strong>{row.fileName}</strong><span class="pill" data-tone={row.status}
                      >{$t(`frameleaf_batch.${row.status}` as Translations)}</span
                    >
                  </div>
                  <label for={`batch-map-${row.index}`}
                    >{$t('frameleaf_batch.map_file', { values: { file: row.fileName } })}</label
                  >
                  <select
                    id={`batch-map-${row.index}`}
                    value={row.status === 'skipped' ? 'skip' : (row.itemId ?? '')}
                    disabled={busy || uploading}
                    onchange={(event) => void mapFile(row.index, event.currentTarget.value)}
                  >
                    <option value="">{$t('frameleaf_batch.choose_photo')}</option><option value="skip"
                      >{$t('frameleaf_batch.skip_file')}</option
                    >
                    {#each batch.items.filter((item) => item.available && item.preparationStatus === 'prepared') as item (item.id)}<option
                        value={item.id}>{item.fileName} · {item.exportId?.slice(0, 8)}</option
                      >{/each}
                  </select>
                  {#if localErrors[row.index]}<p role="alert">{localErrors[row.index]}</p>{/if}
                </li>
              {/each}
            </ul>
            <div class="buttons">
              <Button variant="primary" disabled={!canImport || busy || uploading} onclick={() => void importFiles()}
                >{$t('frameleaf_batch.confirm')}</Button
              >
              {#if failedFiles.length > 0}<Button
                  disabled={!canImport || busy || uploading}
                  onclick={() => void importFiles(true)}>{$t('frameleaf_batch.retry_failed')}</Button
                >{/if}
            </div>
            <p role="status">
              {$t('frameleaf_batch.progress', {
                values: { completed, total: matches.filter((row) => row.status === 'matched').length },
              })}
              {currentFile}
            </p>
          {/if}
        </div>
      {/if}
      <!-- Each photo: where it stands, and the versions its edits made. -->
      <div class="step">
        <div class="step-head"><h3>{$t('frameleaf_batch.server_status')}</h3></div>
        <ul class="rows" aria-live="polite" aria-busy={uploading || busy}>
          {#each batch.items as item (item.id)}
            <li>
              <div class="row-head">
                <strong>{item.fileName ?? $t('frameleaf_batch.unavailable_item')}</strong>
                {#if item.returns.length === 0}<span class="pill" data-tone={item.preparationStatus}
                    >{$t(
                      `frameleaf_batch.${item.preparationStatus === 'prepared' ? 'pending' : item.preparationStatus === 'pending' ? 'not_prepared' : item.preparationStatus}` as Translations,
                    )}</span
                  >{/if}
              </div>
              {#if item.errorCode}<p>{reason(item.errorCode)}</p>{/if}
              {#each item.returns as returned (returned.id)}
                <div class="return-state">
                  <span
                    >{returned.checksum.slice(0, 8)} · {$t(`frameleaf_batch.${returned.status}` as Translations)} · {returned.progress}%</span
                  >
                  {#if returned.errorCode}<p>{reason(returned.errorCode)}</p>{/if}
                  {#if returned.status === 'failed' && returned.revisionId && batch.status !== 'cancelled'}<Button
                      disabled={busy || uploading}
                      onclick={() => void retryReturn(item.id, returned.confirmationId, returned.checksum)}
                      >{$t('retry')}</Button
                    >{/if}
                </div>
              {/each}
            </li>
          {/each}
        </ul>
      </div>
      <div class="buttons footer">
        <a href={`/develop-batches?batch=${batch.id}`}>{$t('frameleaf_batch.resume_link')}</a>
        {#if batch.status !== 'cancelled'}<Button variant="danger" disabled={busy} onclick={() => void cancel()}
            >{$t('frameleaf_batch.cancel')}</Button
          >{/if}
      </div>
    {/if}
  {/if}
</section>

<style>
  .batch-editor {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--fl-space-4);
    color: var(--fl-text);
  }
  /* A long batch name in the picker never pushes the page wider than the window. */
  .field select {
    inline-size: 100%;
    text-overflow: ellipsis;
  }
  /* The batch picker and its Refresh, one row of equal-height controls 8px apart. */
  .select-row {
    display: flex;
    align-items: stretch;
    gap: var(--fl-space-2);
  }
  .select-row select {
    flex: 1;
    min-inline-size: 0;
  }
  @media (max-width: 700px) {
    .step {
      padding: var(--fl-space-4);
    }
  }
  p {
    color: var(--fl-muted);
    font-size: var(--fl-font-size);
    line-height: 1.6;
    margin: 0;
  }
  .buttons {
    display: flex;
    gap: var(--fl-space-3);
    align-items: center;
    flex-wrap: wrap;
  }
  /* A label sits 8px over its own control, not a section's gap away. */
  .field {
    display: grid;
    gap: var(--fl-space-2);
  }
  .empty {
    display: grid;
    justify-items: center;
    gap: var(--fl-space-3);
    margin-block-start: var(--fl-space-2);
    padding: var(--fl-space-10) var(--fl-space-6);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
    color: var(--fl-muted);
    text-align: center;
  }
  .empty h2 {
    margin: 0;
    color: var(--fl-text);
    font: var(--fl-type-headline);
  }
  .empty p {
    max-inline-size: 32rem;
  }
  .empty .buttons {
    align-items: stretch;
    justify-content: center;
    margin-block-start: var(--fl-space-2);
  }
  a.button {
    display: inline-flex;
    align-items: center;
    min-block-size: var(--fl-control-height);
    padding-inline: var(--fl-space-4);
    border-radius: var(--fl-radius-control);
    background: var(--fl-accent);
    color: var(--fl-accent-text);
    font-weight: 600;
    text-decoration: none;
  }
  select,
  input {
    font-size: var(--fl-font-size);
    max-inline-size: 100%;
    padding: 10px var(--fl-space-3);
    background: var(--fl-raised);
    color: var(--fl-text);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  /* Each step of the batch is a card: export, bring back, where each photo stands. */
  .step {
    display: grid;
    gap: var(--fl-space-3);
    padding: var(--fl-space-6);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
  }
  .step-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--fl-space-3);
  }
  h3 {
    margin: 0;
    font: var(--fl-type-headline);
  }
  h4 {
    margin: var(--fl-space-2) 0 0;
    font-weight: 600;
  }
  .pill {
    flex-shrink: 0;
    padding: 2px var(--fl-space-2);
    border-radius: var(--fl-radius-pill);
    background: var(--fl-raised);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .pill:is([data-tone='prepared'], [data-tone='matched'], [data-tone='completed'], [data-tone='confirmed']) {
    background: color-mix(in srgb, var(--fl-accent) 16%, transparent);
    color: var(--fl-accent);
  }
  .pill:is([data-tone='failed'], [data-tone='unmatched'], [data-tone='ambiguous']) {
    background: color-mix(in srgb, var(--fl-danger) 14%, transparent);
    color: var(--fl-danger);
  }
  progress {
    inline-size: 100%;
    block-size: 6px;
    overflow: hidden;
    border: 0;
    border-radius: var(--fl-radius-pill);
    background: var(--fl-raised);
    appearance: none;
  }
  progress::-webkit-progress-bar {
    background: var(--fl-raised);
  }
  progress::-webkit-progress-value {
    background: var(--fl-accent);
  }
  progress::-moz-progress-bar {
    background: var(--fl-accent);
  }
  .buttons:empty {
    display: none;
  }
  /* The browser's file inputs, as buttons that say what they choose. */
  .file-button {
    position: relative;
    display: inline-flex;
    align-items: center;
    min-block-size: var(--fl-control-height);
    padding-inline: var(--fl-space-4);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    background: var(--fl-raised);
    font-size: var(--fl-font-size);
    cursor: pointer;
  }
  .file-button:has(input:disabled) {
    opacity: 0.5;
    cursor: default;
  }
  .file-button:has(input:focus-visible) {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
  .file-button input {
    position: absolute;
    inset: 0;
    opacity: 0;
    cursor: inherit;
  }
  .footer {
    justify-content: space-between;
  }
  ul {
    list-style: none;
    padding: 0;
    margin: 0;
    display: grid;
  }
  .rows li {
    display: grid;
    gap: var(--fl-space-2);
    padding-block: var(--fl-space-3);
    border-block-start: 1px solid var(--fl-border);
    overflow-wrap: anywhere;
  }
  .rows li:first-child {
    border-block-start: 0;
    padding-block-start: 0;
  }
  .row-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--fl-space-3);
  }
  .row-head strong {
    font-weight: 500;
  }
  .rows label {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .return-state {
    display: grid;
    gap: var(--fl-space-1);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  a:not(.button) {
    color: var(--fl-accent);
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  [role='alert'] {
    color: var(--fl-danger);
  }
</style>
