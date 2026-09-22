<script lang="ts">
  import { t } from 'svelte-i18n';
  import { onDestroy, onMount, untrack } from 'svelte';
  import { onLibraryAccessChange } from '$lib/frameleaf/library-access';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import {
    createArchiveOperation,
    prepareArchiveOperation,
    confirmArchiveOperation,
    type ArchiveOperationPrepareDto,
    getArchiveOperations,
    commandArchiveOperation,
    ArchiveOperationScope,
    ArchiveOperationCommand,
    type ArchiveOperationResponseDto,
  } from '@immich/sdk';
  import { Button, Modal, ModalBody } from '@immich/ui';

  let {
    ids = [],
    matchingQuery,
    currentMatchingQuery,
    onClose,
  }: {
    ids?: string[];
    matchingQuery?: () => ArchiveOperationPrepareDto['query'];
    currentMatchingQuery?: () => ArchiveOperationPrepareDto['query'];
    onClose: () => void;
  } = $props();
  const frozenQuery = untrack(() => (matchingQuery ? structuredClone(matchingQuery()) : undefined));
  $effect(() => {
    let changed: boolean;
    try {
      changed =
        !!matchingQuery && JSON.stringify((currentMatchingQuery ?? matchingQuery)()) !== JSON.stringify(frozenQuery);
    } catch {
      changed = true;
    }
    if (changed) {
      retired = true;
      request.abort();
      onClose();
    }
  });
  // Capture before any asynchronous work. Retries retain both the IDs and request key.
  const selection = untrack(() => [...new Set(ids)]);
  const requestKey = crypto.randomUUID();
  let operations = $state<ArchiveOperationResponseDto[]>([]);
  let busy = $state(false);
  let submitted = $state(false);
  let error = $state('');
  let retired = false;
  const request = new AbortController();
  const stopAccess = onLibraryAccessChange(
    (change) => {
      if (change === 'expanded') {
        return;
      }

      retired = true;
      request.abort();
      operations = [];
      onClose();
    },
    authManager.authenticated ? authManager.user.id : undefined,
  );
  onDestroy(() => {
    retired = true;
    request.abort();
    stopAccess();
  });

  const load = async () => {
    const result = await getArchiveOperations({ signal: request.signal });
    if (!retired) {
      operations = result;
    }
  };
  const run = async (action: () => Promise<unknown>) => {
    if (busy || retired) {
      return;
    }
    busy = true;
    error = '';
    try {
      await action();
    } catch {
      if (!retired) {
        error = $t('archive_operations.error');
      }
    } finally {
      if (!retired) {
        busy = false;
      }
    }
  };
  const submit = async () =>
    run(async () => {
      const operation = await createArchiveOperation(
        {
          archiveOperationCreateDto: {
            ids: selection,
            requestKey,
            scope: ArchiveOperationScope.SelectedOwnedAssets,
          },
        },
        { signal: request.signal },
      );
      if (retired) {
        return;
      }
      submitted = true;
      operations = [operation, ...operations.filter(({ id }) => id !== operation.id)];
    });
  const prepare = async () =>
    run(async () => {
      if (!frozenQuery) {
        return;
      }
      const operation = await prepareArchiveOperation(
        { archiveOperationPrepareDto: { query: frozenQuery, requestKey } },
        { signal: request.signal },
      );
      if (!retired) {
        operations = [operation, ...operations.filter(({ id }) => id !== operation.id)];
      }
    });
  const confirm = async (operation: ArchiveOperationResponseDto) =>
    run(async () => {
      const confirmed = await confirmArchiveOperation(
        { id: operation.id, archiveOperationConfirmDto: { requestKey: operation.requestKey } },
        { signal: request.signal },
      );
      if (!retired) {
        submitted = true;
        operations = [confirmed, ...operations.filter(({ id }) => id !== confirmed.id)];
      }
    });
  const command = async (id: string, command: ArchiveOperationCommand) =>
    run(async () => {
      await commandArchiveOperation({ id, archiveOperationCommandDto: { command } }, { signal: request.signal });
      if (!retired) {
        await load();
      }
    });
  onMount(() => {
    void (frozenQuery ? prepare() : run(load));
  });
</script>

<Modal title={$t('archive_operations.title')} {onClose} size="medium">
  <ModalBody>
    <div class="flex flex-col gap-4" aria-busy={busy}>
      {#if selection.length > 0 && !submitted}
        <p>{$t('archive_operations.selection', { values: { count: selection.length } })}</p>
        <Button disabled={busy} onclick={submit}
          >{$t('archive_operations.submit', { values: { count: selection.length } })}</Button
        >
      {/if}
      {#if frozenQuery && operations.length === 0}
        <p>{$t('archive_operations.matching_scope')}</p>
        <Button disabled={busy} onclick={prepare}>{$t('archive_operations.prepare')}</Button>
      {/if}
      <p>{$t('archive_operations.continuity')}</p>
      {#if error}<p role="alert">{error}</p>{/if}
      <Button disabled={busy} onclick={() => run(load)}>{$t('archive_operations.refresh')}</Button>
      {#if operations.length === 0 && !busy}<p>{$t('archive_operations.empty')}</p>{/if}
      {#each operations as operation (operation.id)}
        <section class="flex flex-col gap-2 border-t border-primary pt-3" aria-label={$t('archive_operations.result')}>
          <p>
            {$t(
              operation.scope === 'matching-owned-timeline'
                ? 'archive_operations.matching_count'
                : 'archive_operations.scope',
              { values: { count: operation.count } },
            )}
          </p>
          {#if operation.prepared}<p>{$t('archive_operations.prepared')}</p>{/if}
          <p aria-live="polite">
            {$t('archive_operations.counts', { values: { ...operation } })}
          </p>
          {#if operation.cancelled}<p>{$t('archive_operations.cancelled')}</p>{/if}
          <div class="flex flex-wrap gap-2">
            {#if operation.prepared && !operation.cancelled}
              <Button disabled={busy || !operation.count} onclick={() => confirm(operation)}
                >{$t('archive_operations.confirm')}</Button
              >
            {/if}
            {#if (operation.prepared || operation.pending) && !operation.cancelled}
              <Button disabled={busy} onclick={() => command(operation.id, ArchiveOperationCommand.Cancel)}
                >{$t('archive_operations.cancel')}</Button
              >
            {/if}
            {#if !operation.prepared && (operation.cancelled || operation.error || operation.revoked)}
              <Button disabled={busy} onclick={() => command(operation.id, ArchiveOperationCommand.Retry)}
                >{$t('archive_operations.retry')}</Button
              >
            {/if}
            {#if !operation.prepared && !operation.undo && operation.succeeded && (!operation.pending || operation.cancelled)}
              <Button disabled={busy} onclick={() => command(operation.id, ArchiveOperationCommand.Undo)}
                >{$t('archive_operations.undo')}</Button
              >
            {/if}
          </div>
        </section>
      {/each}
      <Button onclick={() => location.reload()}>{$t('archive_operations.reload')}</Button>
    </div>
  </ModalBody>
</Modal>
