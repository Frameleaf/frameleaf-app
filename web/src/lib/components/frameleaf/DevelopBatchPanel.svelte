<script lang="ts">
  import Button from './Button.svelte';
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
  const perform = async (operation: () => Promise<void>) => {
    busy = true;
    error = '';
    try {
      await operation();
    } catch (error_) {
      showError(error_);
    } finally {
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
      polling = true;
      void getDevelopBatch({ id })
        .then((value) => {
          if (!disposed && batch?.id === id && !busy && !uploading) {
            batch = value;
          }
        })
        .catch((error_) => {
          // a poll for a batch no longer shown has nothing to say about the one that is
          if (!disposed && batch?.id === id) {
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
    <div class="buttons">
      {#if assetIds.length > 0}<Button variant="primary" disabled={busy || uploading} onclick={() => void create()}
          >{$t('frameleaf_batch.create', { values: { count: assetIds.length } })}</Button
        >{/if}
      <Button disabled={busy || uploading} onclick={() => void perform(load)}>{$t('refresh')}</Button>
    </div>
    {#if batches.length > 0}
      <label for="editing-batch">{$t('frameleaf_batch.resume')}</label>
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
            >{new Date(entry.createdAt).toLocaleString($locale)} · {entry.itemCount} · {$t(
              `frameleaf_batch.${entry.status}` as Translations,
            )}</option
          >{/each}
      </select>
      {#if nextCursor}<Button disabled={busy || uploading} onclick={() => void perform(loadMore)}
          >{$t('load_more')}</Button
        >{/if}
    {/if}
    {#if batch}
      <p role="status">{$t('frameleaf_batch.prepared_count', { values: { prepared, total: batch.items.length } })}</p>
      {#if prepared < batch.items.length && batch.status !== 'cancelled'}<p>{$t('frameleaf_batch.prepare_help')}</p>
        <Button disabled={busy || uploading} onclick={() => void prepare()}>{$t('frameleaf_batch.prepare')}</Button
        >{/if}
      <p>{$t('frameleaf_batch.export_counts', { values: { included: prepared, skipped: excluded } })}</p>
      {#if excluded > 0}<p>{$t('frameleaf_batch.exclusions_help')}</p>{/if}
      <div class="buttons">
        {#if prepared > 0 && pending === 0 && batch.status !== 'cancelled'}<a
            class="download"
            href={`${getBaseUrl()}/develop-batches/${batch.id}/download`}
            download>{$t('frameleaf_batch.download')}</a
          >{/if}
        <a href={`/develop-batches?batch=${batch.id}`}>{$t('frameleaf_batch.resume_link')}</a>
        {#if batch.status !== 'cancelled'}<Button disabled={busy} onclick={() => void cancel()}
            >{$t('frameleaf_batch.cancel')}</Button
          >{/if}
      </div>
      {#if batch.status !== 'cancelled'}
        <p>{$t('frameleaf_batch.reselect')}</p>
        <label for="returned-files">{$t('frameleaf_batch.files')}</label>
        <input
          id="returned-files"
          type="file"
          multiple
          disabled={busy || uploading}
          onchange={(event) => void matchFiles([...(event.currentTarget.files ?? [])])}
        />
        <label for="returned-folder">{$t('frameleaf_batch.folder')}</label>
        <input
          id="returned-folder"
          type="file"
          multiple
          webkitdirectory
          disabled={busy || uploading}
          onchange={(event) => void matchFiles([...(event.currentTarget.files ?? [])])}
        />
        {#if matches.length > 0}
          <h3>{$t('frameleaf_batch.review')}</h3>
          <p>{$t('frameleaf_batch.review_help')}</p>
          <ul class="review">
            {#each matches as row (row.index)}
              <li>
                <strong>{row.fileName}</strong><span>{$t(`frameleaf_batch.${row.status}` as Translations)}</span>
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
      {/if}
      <h3>{$t('frameleaf_batch.server_status')}</h3>
      <ul aria-live="polite" aria-busy={uploading || busy}>
        {#each batch.items as item (item.id)}
          <li>
            <strong>{item.fileName ?? $t('frameleaf_batch.unavailable_item')}</strong>
            {#if item.returns.length === 0}<span
                >{$t(
                  `frameleaf_batch.${item.preparationStatus === 'prepared' ? 'pending' : item.preparationStatus}` as Translations,
                )}</span
              >{/if}
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
    {/if}
  {/if}
</section>

<style>
  .batch-editor {
    display: grid;
    gap: 1rem;
    color: var(--fl-text);
  }
  p {
    color: var(--fl-muted);
    font-size: 0.875rem;
    margin: 0;
  }
  .buttons {
    display: flex;
    gap: 0.75rem;
    align-items: center;
    flex-wrap: wrap;
  }
  select,
  input {
    max-inline-size: 100%;
    padding: 0.6rem;
    background: var(--fl-raised);
    color: var(--fl-text);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  ul {
    list-style: none;
    padding: 0;
    margin: 0;
    display: grid;
    gap: 0.75rem;
  }
  li,
  .return-state {
    display: grid;
    gap: 0.4rem;
    overflow-wrap: anywhere;
  }
  li {
    border-block-end: 1px solid var(--fl-border);
    padding-block-end: 0.75rem;
  }
  h3 {
    font-size: 1rem;
    margin: 0;
  }
  a {
    color: var(--fl-accent);
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  [role='alert'] {
    color: var(--fl-danger);
  }
</style>
