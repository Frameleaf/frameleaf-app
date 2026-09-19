<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { Route } from '$lib/route';
  import { handleError } from '$lib/utils/handle-error';
  import {
    ICloudAuthAction,
    ICloudControlAction,
    MediaHealthStatus,
    authenticateICloudConnection,
    controlICloudConnection,
    createICloudConnection,
    disconnectICloudConnection,
    getAuthStatus,
    getICloudInventory,
    listICloudConnections,
    updateICloudConnection,
    type ICloudAuthDto,
    type ICloudConnectionResponseDto,
    type ICloudConnectionsResponseDto,
    type ICloudControlDto,
    type ICloudInventoryResponseDto,
  } from '@immich/sdk';
  import { Button, Field, Input, NumberInput, Text, toastManager } from '@immich/ui';
  import { t, type Translations } from 'svelte-i18n';

  let { initial }: { initial: ICloudConnectionsResponseDto } = $props();
  let connections = $state(initial.connections);
  let enabled = $state(initial.enabled);
  let selectedId = $state(initial.connections[0]?.id ?? '');
  let draft = $state<ICloudConnectionResponseDto | undefined>(
    initial.connections[0] ? structuredClone(initial.connections[0]) : undefined,
  );
  let inventory = $state<ICloudInventoryResponseDto>();
  let busy = $state(false);
  let newLabel = $state('');
  let appleId = $state('');
  let password = $state('');
  let code = $state('');
  let confirmDisconnect = $state(false);
  let albumSearch = $state('');

  const selected = $derived(connections.find(({ id }) => id === selectedId));
  const visibleAlbums = $derived(
    inventory?.albums
      .filter(
        (album) =>
          (!draft?.config.libraries?.length || draft.config.libraries.includes(album.libraryId)) &&
          album.name.toLocaleLowerCase().includes(albumSearch.toLocaleLowerCase()),
      )
      .slice(0, 200) ?? [],
  );
  const metrics = $derived(
    Object.entries(selected?.counts ?? {}).filter(([key]) => !['logicalAssets', 'resources'].includes(key)),
  );
  const countLabels: Record<string, Translations> = {
    discoveredLogicalAssets: 'icloud_sync.counts.discovered',
    stagingBytes: 'icloud_sync.counts.staging_bytes',
    retainedStagingBytes: 'icloud_sync.counts.retained_staging_bytes',
    staging: 'icloud_sync.counts.downloading',
    committed: 'icloud_sync.counts.committed',
    finalized: 'icloud_sync.counts.completed',
    reused: 'icloud_sync.counts.healthy_reused',
    'repaired-missing': 'icloud_sync.counts.repaired_missing',
    'repaired-corrupt': 'icloud_sync.counts.repaired_corrupt',
    'requires-review': 'icloud_sync.counts.requires_review',
    'needs-review': 'icloud_sync.counts.requires_review',
    review: 'icloud_sync.counts.requires_review',
    pending: 'icloud_sync.counts.pending',
    retry: 'icloud_sync.counts.retry',
    staged: 'icloud_sync.counts.staged',
    imported: 'icloud_sync.counts.imported',
    healthy_reused: 'icloud_sync.counts.healthy_reused',
    repaired_missing: 'icloud_sync.counts.repaired_missing',
    repaired_corrupt: 'icloud_sync.counts.repaired_corrupt',
    metadata_updated: 'icloud_sync.counts.metadata_updated',
    album_updated: 'icloud_sync.counts.album_updated',
    awaiting_auth: 'icloud_sync.counts.awaiting_auth',
    unsupported: 'icloud_sync.counts.unsupported',
    failed: 'icloud_sync.counts.failed',
    requires_review: 'icloud_sync.counts.requires_review',
    removed: 'icloud_sync.counts.removed',
    blocked: 'icloud_sync.counts.blocked',
    completed: 'icloud_sync.counts.completed',
  };
  const controls: ICloudControlDto['action'][] = [
    ICloudControlAction.Run,
    ICloudControlAction.Pause,
    ICloudControlAction.Resume,
    ICloudControlAction.Cancel,
    ICloudControlAction.Retry,
    ICloudControlAction.Rescan,
  ];

  const selectConnection = (connection: ICloudConnectionResponseDto) => {
    selectedId = connection.id;
    draft = structuredClone($state.snapshot(connection));
    inventory = undefined;
    appleId = '';
    password = '';
    code = '';
    confirmDisconnect = false;
  };

  const accept = (connection: ICloudConnectionResponseDto) => {
    connections = [...connections.filter(({ id }) => id !== connection.id), connection];
    selectedId = connection.id;
    draft = structuredClone($state.snapshot(connection));
  };

  const runAction = async (action: () => Promise<void>) => {
    busy = true;
    try {
      await action();
    } catch (error) {
      handleError(error, $t('icloud_sync.action_failed'));
    } finally {
      busy = false;
    }
  };

  const refresh = () =>
    runAction(async () => {
      const response = await listICloudConnections();
      connections = response.connections;
      enabled = response.enabled;
      if (connections.every(({ id }) => id !== selectedId)) {
        if (connections[0]) {
          selectConnection(connections[0]);
        } else {
          selectedId = '';
          draft = undefined;
        }
      }
    });

  const create = (event: SubmitEvent) => {
    event.preventDefault();
    void runAction(async () => {
      const connection = await createICloudConnection({ iCloudConnectionCreateDto: { label: newLabel.trim() } });
      connections = [...connections, connection];
      selectConnection(connection);
      newLabel = '';
    });
  };

  const authenticate = (action: ICloudAuthDto['action']) => {
    const request: ICloudAuthDto =
      action === ICloudAuthAction.Login
        ? { action, appleId, password }
        : action === ICloudAuthAction.TwoFactor
          ? { action, code }
          : { action };
    password = '';
    code = '';
    return runAction(async () =>
      accept(await authenticateICloudConnection({ id: selectedId, iCloudAuthDto: request })),
    );
  };

  const save = (event: SubmitEvent) => {
    event.preventDefault();
    if (!draft) {
      return;
    }
    const update = { label: draft.label, config: structuredClone($state.snapshot(draft.config)) };
    void runAction(async () => {
      if (update.config.includeHidden) {
        const auth = await getAuthStatus();
        if (!auth.isElevated) {
          await goto(Route.pinPrompt({ continue: page.url.pathname }));
          return;
        }
      }
      accept(await updateICloudConnection({ id: selectedId, iCloudConnectionUpdateDto: update }));
      toastManager.primary($t('icloud_sync.saved'));
    });
  };

  const loadInventory = () =>
    runAction(async () => {
      inventory = await getICloudInventory({ id: selectedId });
    });
  const control = (action: ICloudControlDto['action']) =>
    runAction(async () => {
      accept(await controlICloudConnection({ id: selectedId, iCloudControlDto: { action } }));
    });
  const disconnect = () =>
    runAction(async () => {
      await disconnectICloudConnection({ id: selectedId });
      confirmDisconnect = false;
      const response = await listICloudConnections();
      connections = response.connections;
      const connection = connections.find(({ id }) => id === selectedId) ?? connections[0];
      if (connection) {
        selectConnection(connection);
      } else {
        selectedId = '';
        draft = undefined;
      }
    });
</script>

<div class="mx-auto w-full max-w-6xl p-4 pb-16">
  <div class="mb-6 flex items-start justify-between gap-4">
    <div class="max-w-2xl space-y-2">
      <Text>{$t('icloud_sync.intro')}</Text>
      <Text color="muted" size="small">{$t('icloud_sync.background')}</Text>
    </div>
    <Button color="secondary" size="small" onclick={refresh} disabled={busy}>{$t('refresh')}</Button>
  </div>

  {#if !enabled}
    <p role="status" class="rounded-xl bg-gray-100 p-5 dark:bg-immich-dark-gray">{$t('icloud_sync.disabled')}</p>
  {:else}
    <div class="grid items-start gap-8 lg:grid-cols-[16rem_1fr]">
      <aside class="space-y-5">
        <nav aria-label={$t('icloud_sync.connections')} class="space-y-1">
          {#each connections as connection (connection.id)}
            <button
              type="button"
              disabled={busy}
              aria-current={selectedId === connection.id ? 'true' : undefined}
              onclick={() => selectConnection(connection)}
              class="w-full rounded-lg border border-gray-200 px-4 py-3 text-left hover:bg-gray-100 aria-current:border-immich-primary aria-current:bg-gray-100 dark:border-immich-dark-gray dark:hover:bg-immich-dark-gray dark:aria-current:bg-immich-dark-gray"
            >
              <span class="block truncate font-medium">{connection.label}</span>
              <span class="text-sm text-gray-500 dark:text-gray-300">{connection.state}</span>
            </button>
          {/each}
        </nav>
        <form onsubmit={create} class="space-y-3">
          <Field label={$t('icloud_sync.connection_name')} required
            ><Input bind:value={newLabel} required maxlength={100} disabled={busy} /></Field
          >
          <Button type="submit" size="small" disabled={busy || !newLabel.trim()}
            >{$t('icloud_sync.add_connection')}</Button
          >
        </form>
      </aside>

      {#if selected && draft}
        <div class="min-w-0 space-y-8" aria-busy={busy}>
          <section aria-label={$t('icloud_sync.status')} class="space-y-4">
            <div class="flex flex-wrap items-baseline justify-between gap-2">
              <h2 class="text-xl font-medium">{selected.label}</h2>
              <p role="status">{selected.state}</p>
            </div>
            {#if selected.lastError}<p role="alert" class="rounded-lg bg-gray-100 p-3 dark:bg-immich-dark-gray">
                {$t('icloud_sync.safe_error')}: {selected.lastError}
              </p>{/if}
            {#if selected.nextRunAt}<p class="text-sm">
                {$t('icloud_sync.next_run')}: {new Date(selected.nextRunAt).toLocaleString()}
              </p>{/if}
            <dl class="grid grid-cols-2 gap-x-8 gap-y-2 border-y border-gray-200 py-4 dark:border-immich-dark-gray">
              <dt>{$t('icloud_sync.logical_assets')}</dt>
              <dd class="text-right tabular-nums">{(selected.counts.logicalAssets ?? 0).toLocaleString()}</dd>
              <dt>{$t('icloud_sync.resources')}</dt>
              <dd class="text-right tabular-nums">{(selected.counts.resources ?? 0).toLocaleString()}</dd>
              {#each metrics as [key, count] (key)}<dt>
                  {Object.hasOwn(countLabels, key) ? $t(countLabels[key]) : key}
                </dt>
                <dd class="text-right tabular-nums">{count.toLocaleString()}</dd>{/each}
            </dl>
            <p class="text-sm text-gray-500 dark:text-gray-300">{$t('icloud_sync.counts_note')}</p>
            <div class="flex flex-wrap gap-2">
              {#each controls as action (action)}<Button
                  color="secondary"
                  size="small"
                  disabled={busy}
                  onclick={() => control(action)}>{$t(`icloud_sync.controls.${action}`)}</Button
                >{/each}
            </div>
          </section>

          <section aria-labelledby="icloud-auth" class="space-y-4">
            <h3 id="icloud-auth" class="text-lg font-medium">{$t('icloud_sync.authentication')}</h3>
            <p class="text-sm">{$t('icloud_sync.adp_notice')}</p>
            {#if selected.state === 'awaiting-2fa'}
              <form
                onsubmit={(event) => {
                  event.preventDefault();
                  void authenticate(ICloudAuthAction.TwoFactor);
                }}
                class="flex flex-wrap items-end gap-3"
                autocomplete="off"
              >
                <Field label={$t('icloud_sync.verification_code')} required
                  ><Input
                    bind:value={code}
                    inputmode="numeric"
                    pattern={'[0-9]{6}'}
                    maxlength={6}
                    autocomplete="one-time-code"
                    required
                    disabled={busy}
                  /></Field
                >
                <Button type="submit" disabled={busy || !/^\d{6}$/.test(code)}>{$t('icloud_sync.verify')}</Button>
              </form>
            {:else if selected.state === 'awaiting-device-approval'}
              <p role="status">{$t('icloud_sync.device_approval_notice')}</p>
              <Button disabled={busy} onclick={() => authenticate(ICloudAuthAction.DeviceApproval)}
                >{$t('icloud_sync.check_approval')}</Button
              >
            {:else}
              <form
                onsubmit={(event) => {
                  event.preventDefault();
                  void authenticate(ICloudAuthAction.Login);
                }}
                autocomplete="off"
                class="grid gap-4 sm:grid-cols-2"
              >
                <Field label={$t('icloud_sync.apple_id')} required
                  ><Input type="email" bind:value={appleId} autocomplete="username" required disabled={busy} /></Field
                >
                <Field label={$t('password')} required
                  ><Input
                    type="password"
                    bind:value={password}
                    autocomplete="current-password"
                    required
                    disabled={busy}
                  /></Field
                >
                <div class="flex flex-wrap gap-2 sm:col-span-2">
                  <Button type="submit" disabled={busy || !appleId || !password}>{$t('icloud_sync.sign_in')}</Button>
                  <Button color="secondary" disabled={busy} onclick={() => authenticate(ICloudAuthAction.Validate)}
                    >{$t('icloud_sync.check_session')}</Button
                  >
                </div>
              </form>
            {/if}
          </section>

          <form onsubmit={save} class="space-y-6">
            <h3 class="text-lg font-medium">{$t('icloud_sync.settings')}</h3>
            <Field label={$t('icloud_sync.connection_name')} required
              ><Input bind:value={draft.label} required maxlength={100} disabled={busy} /></Field
            >
            <div class="space-y-3">
              <Button color="secondary" size="small" disabled={busy} onclick={loadInventory}
                >{$t('icloud_sync.load_inventory')}</Button
              >
              <p class="text-sm">{$t('icloud_sync.selection_notice')}</p>
              {#if inventory}
                {#if !inventory.complete}<p role="status">{$t('icloud_sync.partial_inventory')}</p>{/if}
                {#if inventory.recent && inventory.recent.length > 0}
                  <section class="space-y-2" aria-label={$t('icloud_sync.recent_results')}>
                    <h4 class="font-medium">{$t('icloud_sync.recent_results')}</h4>
                    <ul class="max-h-48 space-y-1 overflow-y-auto">
                      {#each inventory.recent as receipt (receipt.resourceId)}
                        <li>
                          <a
                            class="text-immich-primary underline dark:text-immich-dark-primary"
                            href={Route.viewAsset({ id: receipt.assetId })}
                            >{$t('icloud_sync.view_asset')} — {Object.hasOwn(countLabels, receipt.outcome)
                              ? $t(countLabels[receipt.outcome])
                              : receipt.outcome}</a
                          >
                        </li>
                      {/each}
                    </ul>
                    <p class="flex gap-4 text-sm">
                      <a class="underline" href={Route.missingMediaUtility({ status: MediaHealthStatus.Resolved })}
                        >{$t('icloud_sync.resolved_missing')}</a
                      ><a class="underline" href={Route.corruptMediaUtility({ status: MediaHealthStatus.Resolved })}
                        >{$t('icloud_sync.resolved_corrupt')}</a
                      >
                    </p>
                  </section>
                {/if}
                <fieldset disabled={busy} class="space-y-2">
                  <legend class="mb-2 font-medium">{$t('icloud_sync.libraries')}</legend>
                  {#each inventory.libraries as library (library.id)}
                    <label class="flex items-center gap-3"
                      ><input
                        type="checkbox"
                        bind:group={draft.config.libraries}
                        value={library.id}
                        disabled={!library.supported}
                      />{library.name}{#if !library.supported}
                        ({$t('icloud_sync.unsupported')}){/if}</label
                    >
                  {/each}
                </fieldset>
                <fieldset disabled={busy} class="space-y-2">
                  <legend class="mb-2 font-medium">{$t('icloud_sync.albums')}</legend>
                  <Field label={$t('icloud_sync.filter_albums')}><Input bind:value={albumSearch} type="search" /></Field
                  >
                  <div class="max-h-64 space-y-2 overflow-y-auto py-2">
                    {#each visibleAlbums as album (album.id)}
                      <label class="flex items-start gap-3"
                        ><input type="checkbox" bind:group={draft.config.albums} value={album.id} class="mt-1" /><span
                          >{album.name}<span class="block text-xs text-gray-500"
                            >{inventory.libraries.find(({ id }) => id === album.libraryId)?.name}{#if album.parentId}
                              / {inventory.albums.find(({ id }) => id === album.parentId)?.name ??
                                album.parentId}{/if}</span
                          ></span
                        ></label
                      >
                    {/each}
                  </div>
                  <p class="text-sm">{$t('icloud_sync.album_limit')}</p>
                </fieldset>
              {/if}
            </div>
            <fieldset disabled={busy} class="space-y-4">
              <legend class="mb-3 font-medium">{$t('icloud_sync.policies')}</legend>
              <label class="flex items-start gap-3"
                ><input type="checkbox" bind:checked={draft.config.includeEdits} class="mt-1" /><span
                  >{$t('icloud_sync.include_edits')}</span
                ></label
              >
              <label class="flex items-start gap-3"
                ><input type="checkbox" bind:checked={draft.config.includeHidden} class="mt-1" /><span
                  >{$t('icloud_sync.include_hidden')}<span class="block text-sm text-gray-500"
                    >{$t('icloud_sync.hidden_notice')}</span
                  ></span
                ></label
              >
              <label class="flex items-start gap-3"
                ><input type="checkbox" bind:checked={draft.config.recoverExternalAsManaged} class="mt-1" /><span
                  >{$t('icloud_sync.external_recovery')}<span class="block text-sm text-gray-500"
                    >{$t('icloud_sync.external_notice')}</span
                  ></span
                ></label
              >
            </fieldset>
            <div class="grid gap-4 sm:grid-cols-3">
              <Field label={$t('icloud_sync.interval')} required
                ><NumberInput
                  bind:value={draft.config.intervalHours}
                  min={1}
                  max={8760}
                  step={1}
                  required
                  disabled={busy}
                /></Field
              >
              <Field label={$t('icloud_sync.concurrency')} required
                ><NumberInput
                  bind:value={draft.config.concurrency}
                  min={1}
                  max={4}
                  step={1}
                  required
                  disabled={busy}
                /></Field
              >
              <Field label={$t('icloud_sync.staging_bytes')} required
                ><NumberInput
                  bind:value={draft.config.stagingBytes}
                  min={1_048_576}
                  max={9_007_199_254_740_991}
                  step={1}
                  required
                  disabled={busy}
                /></Field
              >
            </div>
            <Button type="submit" disabled={busy}>{$t('save')}</Button>
          </form>

          <section class="space-y-3 border-t border-gray-200 pt-5 dark:border-immich-dark-gray">
            <p class="text-sm">{$t('icloud_sync.disconnect_notice')}</p>
            {#if confirmDisconnect}
              <p>{$t('icloud_sync.disconnect_confirm')}</p>
              <div class="flex gap-2">
                <Button color="danger" disabled={busy} onclick={disconnect}>{$t('icloud_sync.disconnect')}</Button
                ><Button
                  color="secondary"
                  disabled={busy}
                  onclick={() => {
                    confirmDisconnect = false;
                  }}>{$t('cancel')}</Button
                >
              </div>
            {:else}
              <Button
                color="secondary"
                disabled={busy}
                onclick={() => {
                  confirmDisconnect = true;
                }}>{$t('icloud_sync.disconnect')}</Button
              >
            {/if}
          </section>
        </div>
      {:else}
        <p class="py-5">{$t('icloud_sync.empty')}</p>
      {/if}
    </div>
  {/if}
</div>
