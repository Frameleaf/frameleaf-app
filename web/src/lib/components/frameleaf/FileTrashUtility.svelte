<script lang="ts">
  /**
   * Library Care → File trash (universal storage; prototype FileTrash.jsx). The server keeps one file per
   * content; an original no library references any more waits here until an administrator restores it to
   * the library it was last in or deletes it permanently. Nothing here is deleted automatically.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import ConfirmDialog from '$lib/components/frameleaf/ConfirmDialog.svelte';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import { handleError } from '$lib/utils/handle-error';
  import {
    deleteFileTrashItem,
    restoreFileTrashItem,
    type FileTrashItemResponseDto,
    type FileTrashResponseDto,
  } from '@frameleaf/sdk';
  import { modalManager, toastManager } from '@frameleaf/ui';
  import { DateTime } from 'luxon';
  import { locale, t } from 'svelte-i18n';

  let { initial }: { initial: FileTrashResponseDto } = $props();

  // the server's page, kept locally as entries leave it
  let items = $state<FileTrashItemResponseDto[]>([]);
  let removed = $state({ count: 0, bytes: 0 });
  let busy = $state<string | null>(null);
  $effect.pre(() => {
    items = [...initial.items];
    removed = { count: 0, bytes: 0 };
  });

  const total = $derived(initial.total - removed.count);
  const totalBytes = $derived(initial.totalBytes - removed.bytes);
  const size = (bytes: number) => getByteUnitString(bytes, $locale ?? undefined);
  const date = (value: string) =>
    DateTime.fromISO(value, { locale: $locale ?? undefined }).toLocaleString(DateTime.DATE_MED);

  const drop = (item: FileTrashItemResponseDto) => {
    items = items.filter(({ id }) => id !== item.id);
    removed = { count: removed.count + 1, bytes: removed.bytes + item.sizeInBytes };
  };

  const restore = async (item: FileTrashItemResponseDto) => {
    busy = item.id;
    try {
      await restoreFileTrashItem({ id: item.id });
      drop(item);
      toastManager.primary(
        $t('frameleaf_file_trash_restored', { values: { name: item.originalFileName, owner: item.lastOwnerName } }),
      );
    } catch (error) {
      handleError(error, $t('frameleaf_file_trash_error'));
    } finally {
      busy = null;
    }
  };

  const remove = async (item: FileTrashItemResponseDto) => {
    const confirmed = await modalManager.show(ConfirmDialog, {
      title: $t('frameleaf_file_trash_delete_title'),
      prompt: $t('frameleaf_file_trash_delete_prompt', {
        values: { name: item.originalFileName, size: size(item.sizeInBytes) },
      }),
      confirmText: $t('frameleaf_file_trash_delete'),
      danger: true,
    });
    if (!confirmed) {
      return;
    }
    busy = item.id;
    try {
      await deleteFileTrashItem({ id: item.id });
      drop(item);
      toastManager.primary($t('frameleaf_file_trash_deleted', { values: { name: item.originalFileName } }));
    } catch (error) {
      handleError(error, $t('frameleaf_file_trash_error'));
    } finally {
      busy = null;
    }
  };
</script>

<section class="file-trash">
  <p class="muted">{$t('frameleaf_file_trash_explainer')}</p>
  <p>
    <strong>{$t('frameleaf_file_trash_summary', { values: { count: total, size: size(totalBytes) } })}</strong>
  </p>
  {#if items.length === 0}
    <p class="muted" role="status">{$t('frameleaf_file_trash_empty')}</p>
  {:else}
    <table>
      <thead>
        <tr>
          <th scope="col">{$t('frameleaf_file_trash_file')}</th>
          <th scope="col">{$t('frameleaf_file_trash_size')}</th>
          <th scope="col">{$t('frameleaf_file_trash_last_in')}</th>
          <th scope="col">{$t('frameleaf_file_trash_trashed_at')}</th>
          <th scope="col"><span class="sr-only">{$t('actions')}</span></th>
        </tr>
      </thead>
      <tbody>
        {#each items as item (item.id)}
          <tr>
            <td class="name">{item.originalFileName}</td>
            <td>{size(item.sizeInBytes)}</td>
            <td>{item.lastOwnerName ?? $t('frameleaf_file_trash_removed_account')}</td>
            <td>{date(item.trashedAt)}</td>
            <td class="actions">
              <Button disabled={!item.lastOwnerName || busy !== null} onclick={() => void restore(item)}>
                {$t('frameleaf_file_trash_restore')}
              </Button>
              <Button variant="danger" disabled={busy !== null} onclick={() => void remove(item)}>
                {$t('frameleaf_file_trash_delete')}
              </Button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</section>

<style>
  .file-trash {
    display: grid;
    gap: 0.75rem;
  }
  .muted {
    color: var(--fl-muted);
    margin: 0;
  }
  table {
    width: 100%;
    border-collapse: collapse;
  }
  th,
  td {
    text-align: start;
    padding: 0.5rem 0.75rem 0.5rem 0;
    border-bottom: 1px solid var(--fl-border);
    vertical-align: middle;
  }
  .name {
    overflow-wrap: anywhere;
  }
  .actions {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
    flex-wrap: wrap;
  }
  @media (max-width: 640px) {
    thead {
      display: none;
    }
    tr {
      display: grid;
      padding: 0.5rem 0;
      border-bottom: 1px solid var(--fl-border);
    }
    td {
      border: 0;
      padding: 0.15rem 0;
    }
    .actions {
      justify-content: flex-start;
    }
  }
</style>
