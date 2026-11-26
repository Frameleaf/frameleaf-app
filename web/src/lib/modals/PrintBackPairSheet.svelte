<script lang="ts">
  /**
   * FL-967: "Pair fronts with backs". The order is an assumption from the upload, so each row can be swapped or
   * left out, and nothing is paired until the owner confirms. A row the server refuses stays here with the reason.
   */
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { swapPair, type PrintPair } from '$lib/frameleaf/print-pairs';
  import { setPrintBack } from '$lib/services/print-back.service.svelte';
  import { getAssetMediaUrl } from '$lib/utils';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import { AssetMediaSize } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiLinkVariant, mdiSwapHorizontal } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = { pairs: PrintPair[]; onClose: (count?: number) => void };
  const { pairs: offered, onClose }: Props = $props();

  type Row = { key: string; pair: PrintPair; error?: string };
  // the sheet edits its own copy of what it was offered
  // svelte-ignore state_referenced_locally
  let rows = $state<Row[]>(offered.map((pair) => ({ key: pair.front.assetId, pair })));
  let open = $state(true);
  let busy = $state(false);
  let done = 0;

  const thumb = (id: string) => getAssetMediaUrl({ id, size: AssetMediaSize.Thumbnail });

  const swap = (row: Row) => {
    row.pair = swapPair(row.pair);
    row.error = undefined;
  };
  const leaveOut = (key: string) => {
    rows = rows.filter((row) => row.key !== key);
  };

  const submit = async () => {
    busy = true;
    for (const row of rows) {
      try {
        await setPrintBack(row.pair.front.assetId, row.pair.back.assetId);
        done++;
        leaveOut(row.key);
      } catch (error) {
        row.error = getServerErrorMessage(error) ?? $t('frameleaf_print_back_pair_failed');
      }
    }
    busy = false;
    if (rows.length === 0) {
      open = false;
    }
  };
</script>

<Dialog
  title={$t('frameleaf_print_back_pair_title')}
  closeLabel={$t('close')}
  size="wide"
  bind:open
  onClosed={() => onClose(done)}
>
  <p class="intro">{$t('frameleaf_print_back_pair_body', { values: { count: offered.length * 2 } })}</p>
  <ul class="rows">
    {#each rows as row (row.key)}
      <li>
        <div class="row">
          <div class="side">
            <img src={thumb(row.pair.front.assetId)} alt="" />
            <span><strong>{$t('frameleaf_print_back_front')}</strong><small>{row.pair.front.name}</small></span>
          </div>
          <Icon icon={mdiLinkVariant} size="18" aria-hidden="true" />
          <div class="side">
            <img src={thumb(row.pair.back.assetId)} alt="" />
            <span><strong>{$t('frameleaf_print_back_back')}</strong><small>{row.pair.back.name}</small></span>
          </div>
          <div class="actions">
            <button
              type="button"
              class="fl-button"
              disabled={busy}
              aria-label={$t('frameleaf_print_back_swap_named', { values: { name: row.pair.front.name } })}
              onclick={() => swap(row)}
            >
              <Icon icon={mdiSwapHorizontal} size="16" aria-hidden="true" />
              {$t('frameleaf_print_back_swap')}
            </button>
            <button
              type="button"
              class="fl-button"
              disabled={busy}
              aria-label={$t('frameleaf_print_back_dont_pair_named', { values: { name: row.pair.front.name } })}
              onclick={() => leaveOut(row.key)}
            >
              {$t('frameleaf_print_back_dont_pair')}
            </button>
          </div>
        </div>
        {#if row.error}<p class="error" role="alert">{row.error}</p>{/if}
      </li>
    {/each}
  </ul>
  <footer>
    <button type="button" class="fl-button" disabled={busy} onclick={() => (open = false)}>{$t('cancel')}</button>
    <button
      type="button"
      class="fl-button fl-button-primary"
      disabled={busy || rows.length === 0}
      onclick={() => void submit()}
    >
      {$t('frameleaf_print_back_pair_action', { values: { count: rows.length } })}
    </button>
  </footer>
</Dialog>

<style>
  .intro {
    margin: 0 0 1rem;
    color: var(--fl-muted);
    font-size: 0.875rem;
  }
  .rows {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem;
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  .side {
    display: flex;
    flex: 1 1 10rem;
    align-items: center;
    gap: 0.75rem;
    min-width: 0;
  }
  .side img {
    flex-shrink: 0;
    width: 4.5rem;
    height: 3rem;
    object-fit: cover;
    border-radius: 0.25rem;
  }
  .side span {
    display: flex;
    flex-direction: column;
    min-width: 0;
    font-size: 0.875rem;
  }
  .side small {
    overflow: hidden;
    color: var(--fl-muted);
    font-size: 0.75rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .error {
    margin: 0.25rem 0 0;
    color: var(--fl-danger);
    font-size: 0.75rem;
  }
  footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-block-start: 1rem;
    padding-block-start: 1rem;
    border-block-start: 1px solid var(--fl-border);
  }
</style>
