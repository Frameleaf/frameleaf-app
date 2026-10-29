<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import { t } from 'svelte-i18n';
  import { getSpeechCapabilities, getSpeechStatus, searchSpokenWords, type SpeechSearchItem } from '@frameleaf/sdk';
  import { type DiscoveryQuery } from '$lib/components/discovery/query';
  import { paletteSearchBody } from '$lib/frameleaf/search-palette';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { onLibraryAccessChange } from '$lib/frameleaf/library-access';
  import { formatMomentTime } from '$lib/frameleaf/enrichment';
  import { videoSeek } from '$lib/frameleaf/video-seek.svelte';
  import { navigate } from '$lib/utils/navigation';

  let { query }: { query: DiscoveryQuery } = $props();
  let items = $state<SpeechSearchItem[]>([]);
  let total = $state(0);
  let nextCursor = $state<string | null>(null);
  let loading = $state(false);
  let viewState = $state<'ready' | 'disabled' | 'unsupported' | 'invalid' | 'failed'>('ready');
  let epoch = 0;
  let controller: AbortController | undefined;
  let validSession = authManager.captureSession();
  const request = () => ({
    query: query.text,
    filter: paletteSearchBody(query, !!authManager.preferences.search?.includeArchived).filter,
    imageEnrichment: query.imageEnrichment,
    size: 25,
  });
  const clear = () => {
    epoch++;
    controller?.abort();
    items = [];
    total = 0;
    nextCursor = null;
    loading = false;
  };
  const load = async (more = false) => {
    if (!authManager.authenticated) {
      clear();
      return;
    }
    if (!more) {
      clear();
      viewState = 'ready';
    }
    const own = epoch,
      session = authManager.captureSession();
    validSession = session;
    controller = new AbortController();
    const signal = controller.signal;
    loading = true;
    const live = () => own === epoch && session() && !signal.aborted;
    try {
      if (!more) {
        let capability;
        try {
          capability = await getSpeechCapabilities({ signal });
        } catch (error) {
          if (live()) {
            viewState = (error as { status?: number }).status === 404 ? 'unsupported' : 'failed';
          }
          return;
        }
        if (!live()) {
          return;
        }
        if (capability.version !== 1) {
          viewState = 'unsupported';
          return;
        }
        const status = await getSpeechStatus({ signal });
        if (!live()) {
          return;
        }
        if (!status.enabled) {
          viewState = 'disabled';
          return;
        }
      }
      const response = await searchSpokenWords(
        { speechSearchDto: { ...request(), ...(more && nextCursor && { cursor: nextCursor }) } },
        { signal },
      );
      if (!live()) {
        return;
      }
      viewState = 'ready';
      items = more ? [...items, ...response.items] : response.items;
      total = response.total;
      nextCursor = response.nextCursor;
    } catch (error) {
      if (live()) {
        clear();
        // The server rejects malformed queries (open quote, too many or too long words); retrying cannot help.
        viewState = (error as { status?: number }).status === 400 ? 'invalid' : 'failed';
      }
    } finally {
      if (live()) {
        loading = false;
      }
    }
  };
  const moreHits = async (item: SpeechSearchItem) => {
    if (!item.nextHitCursor || loading) {
      return;
    }
    const own = epoch,
      session = authManager.captureSession();
    loading = true;
    try {
      const result = await searchSpokenWords({
        speechSearchDto: { ...request(), assetId: item.asset.id, hitCursor: item.nextHitCursor },
      });
      if (own !== epoch || !session()) {
        return;
      }
      const next = result.items[0];
      if (!next || next.transcriptId !== item.transcriptId) {
        invalidate();
        return;
      }
      items = items.map((value) =>
        value.asset.id === item.asset.id ? { ...next, hits: [...value.hits, ...next.hits] } : value,
      );
    } catch {
      if (own === epoch && session()) {
        clear();
        viewState = 'failed';
      }
    } finally {
      if (own === epoch && session()) {
        loading = false;
      }
    }
  };
  const open = async (item: SpeechSearchItem, startMs: number) => {
    const own = epoch,
      session = authManager.captureSession();
    try {
      // Reapply the complete live predicate before handing a cached quote to the viewer.
      const answer = await searchSpokenWords({ speechSearchDto: { ...request(), assetId: item.asset.id } });
      if (own !== epoch || !session()) {
        return;
      }
      if (answer.items.every((value) => value.asset.id !== item.asset.id || value.transcriptId !== item.transcriptId)) {
        invalidate();
        return;
      }
      videoSeek.request(item.asset.id, startMs, true);
      await navigate({ targetRoute: 'current', assetId: item.asset.id });
    } catch {
      if (own === epoch && session()) {
        clear();
        viewState = 'failed';
      }
    }
  };
  const invalidate = () => {
    clear();
    if (validSession() && authManager.authenticated) {
      void load();
    }
  };
  const stop = onLibraryAccessChange(
    (change) => {
      clear();
      if (change !== 'revoked' && authManager.authenticated) {
        void load();
      }
    },
    authManager.authenticated ? authManager.user.id : undefined,
  );
  $effect(() => {
    JSON.stringify(query);
    untrack(() => void load());
    return clear;
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
  onSessionLockedRemote={clear}
  onAssetsDelete={invalidate}
  onAssetUpdate={invalidate}
  onAlbumRemoteUpdate={invalidate}
  onUserPreferencesRemoteUpdate={invalidate}
/>
<section class="speech-results" aria-label={$t('frameleaf_speech_title')} aria-busy={loading}>
  <p>{$t('frameleaf_speech_literal')}</p>
  <p class="muted">{$t('frameleaf_speech_integrations')}</p>
  {#if viewState === 'unsupported'}<p role="status">{$t('frameleaf_speech_unsupported')}</p>
  {:else if viewState === 'disabled'}<p role="status">{$t('frameleaf_speech_disabled')}</p>
    <a href="/user-settings?section=feature#spoken-words">{$t('frameleaf_speech_settings')}</a>
  {:else if viewState === 'invalid'}<p role="alert">{$t('frameleaf_speech_invalid')}</p>
  {:else if viewState === 'failed'}<p role="alert">{$t('frameleaf_speech_failed')}</p>
    <Button onclick={() => void load()}>{$t('retry')}</Button>
  {:else}
    <p role="status">
      {loading && items.length === 0 ? $t('loading') : $t('frameleaf_speech_results', { values: { count: total } })}
    </p>
    {#each items as item (item.asset.id)}
      <article>
        <h2>{item.asset.originalFileName}</h2>
        <p class="muted">{$t('frameleaf_speech_hits', { values: { count: item.hitsTotal } })}</p>
        <ul>
          {#each item.hits as hit (`${hit.startMs}:${hit.endMs}`)}
            <li>
              <button
                type="button"
                onclick={() => void open(item, hit.startMs)}
                aria-label={$t('frameleaf_moments_play_from', { values: { time: formatMomentTime(hit.startMs) } })}
                >{formatMomentTime(hit.startMs)}</button
              ><q>{hit.text}</q>
            </li>
          {/each}
        </ul>
        {#if item.nextHitCursor}<Button disabled={loading} onclick={() => void moreHits(item)}
            >{$t('frameleaf_speech_more_hits')}</Button
          >{/if}
      </article>
    {/each}
    {#if nextCursor}<Button disabled={loading} onclick={() => void load(true)}
        >{$t('frameleaf_speech_more_videos')}</Button
      >{/if}
  {/if}
</section>

<style>
  .speech-results {
    max-width: 70rem;
    margin: 1rem auto;
    padding: 1rem;
    color: var(--fl-text);
  }
  article {
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    padding: 1rem;
    margin: 1rem 0;
    background: var(--fl-panel);
  }
  h2 {
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .muted {
    color: var(--fl-muted);
    font-size: 0.875rem;
  }
  ul {
    list-style: none;
    padding: 0;
  }
  li {
    display: flex;
    align-items: baseline;
    gap: 1rem;
    margin: 0.75rem 0;
  }
  q {
    overflow-wrap: anywhere;
  }
  li button {
    flex-shrink: 0;
    color: var(--fl-accent);
    text-decoration: underline;
    min-height: 2.75rem;
  }
  button:focus-visible,
  a:focus-visible {
    outline: 2px solid var(--fl-accent);
    outline-offset: 3px;
  }
</style>
