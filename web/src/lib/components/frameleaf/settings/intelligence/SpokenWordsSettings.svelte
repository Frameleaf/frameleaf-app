<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { t } from 'svelte-i18n';
  import {
    SpeechScope,
    AlbumUserRole,
    getSpeechCapabilities,
    getSpeechStatus,
    updateSpeechSettings,
    retrySpeechIndexing,
    deleteSpeechIndex,
    getAllAlbums,
    getMlCapabilities,
    MlWorkload,
    MlDestinationKind,
    type SpeechStatusDto,
    type AlbumResponseDto,
    type MlCapabilityDestinationDto,
  } from '@frameleaf/sdk';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Switch from '$lib/components/frameleaf/settings/kit/Switch.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { onLibraryAccessChange } from '$lib/frameleaf/library-access';

  let supported = $state(false),
    busy = $state(false),
    failed = $state(false),
    conflicted = $state(false),
    confirmPurge = $state(false);
  let status = $state<SpeechStatusDto>();
  let enabled = $state(false),
    scope = $state<SpeechScope>(SpeechScope.Library),
    albumIds = $state<string[]>([]),
    destinationId = $state('');
  let albums = $state<AlbumResponseDto[]>([]),
    workers = $state<MlCapabilityDestinationDto[]>([]);
  let epoch = 0;
  let progressRequest = 0,
    refreshQueued = false;
  let controller: AbortController | undefined;
  const clear = () => {
    epoch++;
    progressRequest++;
    refreshQueued = false;
    controller?.abort();
    status = undefined;
    albums = [];
    workers = [];
    supported = false;
    confirmPurge = false;
  };
  const apply = (value: SpeechStatusDto) => {
    conflicted = false;
    status = value;
    enabled = value.enabled;
    scope = value.scope;
    albumIds = [...value.albumIds];
    destinationId = value.destinationId ?? '';
  };
  const load = async () => {
    clear();
    if (!authManager.authenticated) {
      return;
    }
    const own = epoch,
      valid = authManager.captureSession();
    controller = new AbortController();
    const signal = controller.signal;
    try {
      const capability = await getSpeechCapabilities({ signal });
      if (own !== epoch || !valid() || capability?.version !== 1) {
        return;
      }
      supported = true;
      const [value, choices, capabilities] = await Promise.all([
        getSpeechStatus({ signal }),
        getAllAlbums({ isOwned: true }, { signal }),
        getMlCapabilities({ signal }),
      ]);
      if (own !== epoch || !valid()) {
        return;
      }
      // The server's owner-filtered endpoint is authoritative; editor access never qualifies.
      albums = choices.filter((album) =>
        album.albumUsers.some(
          (member) => member.role === AlbumUserRole.Owner && member.user.id === authManager.user.id,
        ),
      );
      workers =
        capabilities.workloads
          .find((item) => item.workload === MlWorkload.StudioAi)
          ?.destinations.filter(
            (item) => item.kind === MlDestinationKind.Local || item.kind === MlDestinationKind.Lan,
          ) ?? [];
      apply(value);
      failed = false;
    } catch (error) {
      if (own === epoch && valid()) {
        failed = (error as { status?: number }).status !== 404;
      }
    }
  };
  const change = async (action: 'save' | 'retry' | 'purge') => {
    if (!status || busy || conflicted) {
      return;
    }
    const own = epoch,
      valid = authManager.captureSession(),
      expectedGeneration = status.generation;
    busy = true;
    progressRequest++;
    failed = false;
    try {
      const value =
        action === 'save'
          ? await updateSpeechSettings({
              speechSettingsUpdateDto: {
                expectedGeneration,
                enabled,
                scope,
                albumIds: scope === 'albums' ? albumIds : [],
                destinationId: destinationId || null,
              },
            })
          : action === 'retry'
            ? await retrySpeechIndexing({ speechRevisionDto: { expectedGeneration } })
            : await deleteSpeechIndex({ speechRevisionDto: { expectedGeneration } });
      if (own === epoch && valid()) {
        apply(value);
        confirmPurge = false;
      }
    } catch {
      if (own === epoch && valid()) {
        failed = true;
      }
    } finally {
      busy = false;
      if (own === epoch && valid() && refreshQueued) {
        refreshQueued = false;
        void refreshProgress(true);
      }
    }
  };
  const refreshProgress = async (force = false) => {
    if (!status || (!force && !status.enabled)) {
      return;
    }
    if (busy) {
      refreshQueued = true;
      return;
    }
    const own = epoch,
      request = ++progressRequest,
      valid = authManager.captureSession();
    try {
      const value = await getSpeechStatus();
      if (own !== epoch || request !== progressRequest || !valid()) {
        return;
      }
      if (value.generation !== status?.generation) {
        // Keep the user's draft, but require an explicit Refresh before using a newer CAS revision.
        conflicted = true;
        failed = true;
      }
      status = value;
    } catch {
      /* Keep last explicit state; reconnect and retry refresh authority. */
    }
  };
  const stop = onLibraryAccessChange(
    (change) => {
      clear();
      if (change !== 'revoked') {
        void load();
      }
    },
    authManager.authenticated ? authManager.user.id : undefined,
  );
  onMount(() => {
    void load();
    const timer = setInterval(() => void refreshProgress(), 5000);
    return () => clearInterval(timer);
  });
  onDestroy(() => {
    clear();
    stop();
  });
</script>

<OnEvents
  onSpeechIndexChange={() => void refreshProgress(true)}
  onWebsocketConnect={() => void load()}
  onUserPreferencesRemoteUpdate={() => void load()}
/>
{#if supported || failed}
  <Section id="spoken-words" title={$t('frameleaf_speech_title')} description={$t('frameleaf_speech_description')}>
    {#if failed}<p role="alert">
        {$t('frameleaf_speech_failed')}
        <Button disabled={busy} onclick={() => void load()}>{$t('refresh')}</Button>
      </p>{/if}
    {#if status}
      <Row label={$t('frameleaf_speech_enable')}
        ><Switch
          label={$t('frameleaf_speech_enable')}
          checked={enabled}
          held={busy}
          onChange={(value) => (enabled = value)}
        /></Row
      >
      <Row label={$t('frameleaf_speech_worker')}>
        <select bind:value={destinationId} disabled={busy} aria-label={$t('frameleaf_speech_worker')}>
          <option value="">{$t('frameleaf_speech_choose_worker')}</option>
          {#each workers as worker (worker.id)}<option value={worker.id}>{worker.name}</option>{/each}
        </select>
      </Row>
      <Row label={$t('frameleaf_speech_scope')}>
        <select bind:value={scope} disabled={busy} aria-label={$t('frameleaf_speech_scope')}
          ><option value="library">{$t('frameleaf_speech_library')}</option><option value="albums"
            >{$t('frameleaf_speech_albums')}</option
          ></select
        >
      </Row>
      {#if scope === 'albums'}
        <fieldset disabled={busy}>
          <legend>{$t('frameleaf_speech_albums')}</legend>
          {#each albums as album (album.id)}<label
              ><input type="checkbox" value={album.id} bind:group={albumIds} />{album.albumName}</label
            >{/each}
        </fieldset>
      {/if}
      <p role="status">
        {$t('frameleaf_speech_progress', {
          values: { indexed: status.indexed, pending: status.pending, failed: status.failed },
        })}
      </p>
      {#if status.error === 'unavailable'}<p role="status">{$t('frameleaf_speech_unavailable')}</p>{/if}
      <div class="actions">
        <Button
          variant="primary"
          disabled={busy ||
            conflicted ||
            (enabled && (!destinationId || (scope === 'albums' && albumIds.length === 0)))}
          onclick={() => void change('save')}>{$t('save')}</Button
        >
        <Button disabled={busy || conflicted || !status.enabled} onclick={() => void change('retry')}
          >{$t('frameleaf_speech_retry')}</Button
        >
        <Button variant="danger" disabled={busy || conflicted} onclick={() => (confirmPurge = true)}
          >{$t('frameleaf_speech_purge')}</Button
        >
      </div>
    {/if}
  </Section>
{/if}
<Dialog bind:open={confirmPurge} title={$t('frameleaf_speech_purge')} closeLabel={$t('close')}>
  <p>{$t('frameleaf_speech_purge_help')}</p>
  {#snippet actions()}<Button disabled={busy} onclick={() => (confirmPurge = false)}>{$t('cancel')}</Button><Button
      variant="danger"
      disabled={busy || conflicted}
      onclick={() => void change('purge')}>{$t('frameleaf_speech_purge')}</Button
    >{/snippet}
</Dialog>

<style>
  select {
    max-width: 100%;
    padding: 0.5rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    background: var(--fl-raised);
    color: var(--fl-text);
  }
  fieldset {
    max-height: 18rem;
    overflow: auto;
    margin: 1rem 0;
  }
  label {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem;
  }
  p {
    margin: 1rem 0;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    margin: 1rem 0;
  }
</style>
