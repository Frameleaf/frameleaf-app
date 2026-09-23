<script lang="ts">
  /**
   * The item report of one preservation package (FL-74): every original with its state, its last
   * verification and its checksum, and the reason for any that failed or were skipped. A Locked
   * item is counted and shown by state, but named only in an unlocked session.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { asBytes, reasonKey } from '$lib/frameleaf/preservation';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import { handleError } from '$lib/utils/handle-error';
  import {
    getPreservationPackageItems,
    PreservationItemState,
    PreservationVerifyState,
    type PreservationItemsResponseDto,
    type PreservationPackageDto,
  } from '@immich/sdk';
  import { untrack } from 'svelte';
  import { locale, t } from 'svelte-i18n';

  type Props = { open?: boolean; item: PreservationPackageDto | null };

  let { open = $bindable(false), item }: Props = $props();

  const PAGE = 50;
  let filter = $state('');
  let skip = $state(0);
  let report = $state<PreservationItemsResponseDto>({ items: [], total: 0 });
  let loading = $state(false);
  let generation = 0;

  const filters = [
    { value: '', key: 'frameleaf_preservation_items_all' },
    { value: `state:${PreservationItemState.Failed}`, key: 'frameleaf_preservation_items_failed' },
    { value: `state:${PreservationItemState.Skipped}`, key: 'frameleaf_preservation_items_skipped' },
    { value: `verify:${PreservationVerifyState.Missing}`, key: 'frameleaf_preservation_items_missing' },
    { value: `verify:${PreservationVerifyState.Changed}`, key: 'frameleaf_preservation_items_changed' },
  ] as const;

  const load = async () => {
    if (!item) {
      return;
    }
    const request = ++generation;
    loading = true;
    try {
      const [kind, value] = filter.split(':', 2);
      const result = await getPreservationPackageItems({
        id: item.id,
        skip,
        take: PAGE,
        state: kind === 'state' ? (value as PreservationItemState) : undefined,
        verifyState: kind === 'verify' ? (value as PreservationVerifyState) : undefined,
      });
      if (request === generation) {
        report = result;
      }
    } catch (error) {
      handleError(error, $t('frameleaf_preservation_items_error'));
    } finally {
      if (request === generation) {
        loading = false;
      }
    }
  };

  // Loads when the dialog opens on a package; paging and filtering load explicitly.
  $effect(() => {
    if (open && item) {
      untrack(() => {
        skip = 0;
        void load();
      });
    }
  });

  const size = (value: string | null) => {
    const bytes = asBytes(value);
    return bytes === null ? '' : getByteUnitString(bytes, $locale ?? undefined);
  };
  const checksumLabel = (value: string | null) =>
    $t('frameleaf_preservation_items_checksum', { values: { size: size(value) } });
</script>

<Dialog
  bind:open
  title={$t('frameleaf_preservation_items_title', { values: { name: item?.name ?? '' } })}
  closeLabel={$t('close')}
  wide
>
  <div class="report">
    <label class="filter">
      {$t('frameleaf_preservation_items_show')}
      <select
        bind:value={filter}
        onchange={() => {
          skip = 0;
          void load();
        }}
      >
        {#each filters as option (option.value)}
          <option value={option.value}>{$t(option.key)}</option>
        {/each}
      </select>
    </label>

    <div class="table" role="region" aria-live="polite" aria-busy={loading}>
      <table>
        <thead>
          <tr>
            <th scope="col">{$t('frameleaf_preservation_items_original')}</th>
            <th scope="col">{$t('frameleaf_preservation_items_state')}</th>
            <th scope="col">{$t('frameleaf_preservation_items_evidence')}</th>
          </tr>
        </thead>
        <tbody>
          {#each report.items as row (row.id)}
            {@const reason = reasonKey(row.reasonKey)}
            <tr>
              <td>
                {row.name ?? $t('frameleaf_preservation_items_locked_name')}
              </td>
              <td>
                {$t(`frameleaf_preservation_item_state_${row.state}`)}
                {#if row.verifyState}
                  · {$t(`frameleaf_preservation_verify_state_${row.verifyState}`)}
                {/if}
              </td>
              <td>
                {#if reason}
                  <span class="reason">{$t(reason)}</span>
                {:else if row.sha256}
                  <details>
                    <summary>{checksumLabel(row.sizeBytes)}</summary>
                    <code>{row.sha256}</code>
                  </details>
                {:else}
                  <span class="muted">{$t('frameleaf_preservation_items_waiting')}</span>
                {/if}
              </td>
            </tr>
          {:else}
            <tr>
              <td colspan="3" class="muted">{loading ? $t('loading') : $t('frameleaf_preservation_items_empty')}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    <footer>
      <span class="muted">
        {$t('frameleaf_preservation_items_range', {
          values: {
            from: report.total === 0 ? 0 : skip + 1,
            to: Math.min(skip + report.items.length, report.total),
            total: report.total,
          },
        })}
      </span>
      <Button
        disabled={loading || skip === 0}
        onclick={() => {
          skip = Math.max(0, skip - PAGE);
          void load();
        }}
      >
        {$t('previous')}
      </Button>
      <Button
        disabled={loading || skip + report.items.length >= report.total}
        onclick={() => {
          skip += PAGE;
          void load();
        }}
      >
        {$t('next')}
      </Button>
    </footer>
  </div>
</Dialog>

<style>
  .report {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin-top: 1rem;
    font-size: var(--fl-font-small);
  }
  .filter {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--fl-muted);
  }
  select {
    padding: 0.375rem 0.5rem;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .table {
    max-height: 26rem;
    overflow: auto;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  table {
    width: 100%;
    border-collapse: collapse;
  }
  th,
  td {
    padding: 0.5rem 0.75rem;
    text-align: start;
    vertical-align: top;
    border-bottom: 1px solid var(--fl-border);
    overflow-wrap: anywhere;
  }
  th {
    color: var(--fl-muted);
    font-weight: 550;
  }
  code {
    font-size: var(--fl-font-micro);
    word-break: break-all;
  }
  .reason {
    color: var(--fl-danger);
  }
  .muted {
    color: var(--fl-muted);
  }
  footer {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: 0.5rem;
  }
  footer .muted {
    margin-inline-end: auto;
  }
</style>
