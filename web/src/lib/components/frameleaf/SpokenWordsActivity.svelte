<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { t } from 'svelte-i18n';
  import { getSpeechStatus, retrySpeechIndexing, type SpeechStatusDto } from '@frameleaf/sdk';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { onLibraryAccessChange } from '$lib/frameleaf/library-access';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  let status = $state<SpeechStatusDto>();
  let busy = $state(false),
    failed = $state(false),
    epoch = 0;
  const clear = () => {
    epoch++;
    status = undefined;
  };
  const refresh = async () => {
    if (!authManager.authenticated) {
      clear();
      return;
    }
    const own = epoch,
      valid = authManager.captureSession();
    try {
      const value = await getSpeechStatus();
      if (own === epoch && valid()) {
        status = value;
        failed = false;
      }
    } catch {
      if (own === epoch && valid()) {
        clear();
      }
    }
  };
  const invalidate = () => {
    clear();
    void refresh();
  };
  const retry = async () => {
    if (!status || busy) {
      return;
    }
    const own = epoch,
      valid = authManager.captureSession();
    busy = true;
    failed = false;
    try {
      const value = await retrySpeechIndexing({ speechRevisionDto: { expectedGeneration: status.generation } });
      if (own === epoch && valid()) {
        status = value;
      }
    } catch {
      if (own === epoch && valid()) {
        failed = true;
      }
    } finally {
      busy = false;
    }
  };
  const stop = onLibraryAccessChange(
    (change) => {
      clear();
      if (change !== 'revoked') {
        void refresh();
      }
    },
    authManager.authenticated ? authManager.user.id : undefined,
  );
  onMount(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  });
  onDestroy(() => {
    clear();
    stop();
  });
</script>

<OnEvents
  onSpeechIndexChange={invalidate}
  onWebsocketConnect={invalidate}
  onWebsocketDisconnect={clear}
  onUserPreferencesRemoteUpdate={invalidate}
/>
{#if status?.enabled}
  <section aria-label={$t('frameleaf_speech_title')} class="speech-activity">
    <h2>{$t('frameleaf_speech_title')}</h2>
    <p role="status">
      {$t('frameleaf_speech_progress', {
        values: { indexed: status.indexed, pending: status.pending, failed: status.failed },
      })}
    </p>
    {#if status.error === 'unavailable'}<p role="status">{$t('frameleaf_speech_unavailable')}</p>{/if}
    {#if failed}<p role="alert">{$t('frameleaf_speech_failed')}</p>{/if}
    <div>
      <a href="/user-settings?section=feature#spoken-words">{$t('frameleaf_speech_settings')}</a>
      <Button disabled={busy} onclick={() => void retry()}>{$t('frameleaf_speech_retry')}</Button>
    </div>
  </section>
{/if}

<style>
  .speech-activity {
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
    padding: 1rem;
    margin: 1rem 0;
  }
  h2 {
    font-weight: 600;
  }
  p {
    margin: 0.5rem 0;
  }
  div {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 1rem;
  }
  a {
    color: var(--fl-accent);
    text-decoration: underline;
  }
</style>
