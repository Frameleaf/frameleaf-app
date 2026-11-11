<script lang="ts">
  import Button from '$lib/components/frameleaf/Button.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import { libraryReferenceUrl } from '$lib/frameleaf/library-reference';
  import { Route } from '$lib/route';
  import {
    getMediaConnections,
    getMediaSubscriptions,
    MediaConnectionStatus,
    MediaHistoryMode,
    MediaSubscriptionAction,
    MediaSubscriptionState,
    updateMediaSubscription,
    type MediaConnectionResponseDto,
    type MediaSubscriptionResponseDto,
    type MediaSubscriptionUpdateDto,
  } from '@frameleaf/sdk';
  import { onMount, tick } from 'svelte';
  import { locale, t } from 'svelte-i18n';
  import { MEDIA_INTERVALS, mediaDate, type MediaInterval } from './boards-media';
  import MediaImportHistory from './MediaImportHistory.svelte';

  let {
    initialId,
    onOpenResult,
    onSaved,
  }: {
    initialId?: string;
    onOpenResult: () => void;
    onSaved: (assetIds: string[], albumId: string) => void;
  } = $props();

  const controller = new AbortController();
  let subscriptions = $state<MediaSubscriptionResponseDto[]>([]);
  let connections = $state<MediaConnectionResponseDto[]>([]);
  let loading = $state(true);
  let loadFailed = $state(false);
  let connectionsFailed = $state(false);
  let updateFailed = $state(false);
  let pending = $state(false);
  let currentId = $state('');
  let interval = $state<MediaInterval>(60);
  let connectionId = $state('');
  let confirmUnsubscribe = $state(false);
  let historyOpen = $state(false);
  let heading: HTMLHeadingElement;
  let lastTrigger: HTMLElement | undefined;
  let revision = 0;
  let timer: ReturnType<typeof setTimeout>;
  const subscription = $derived(subscriptions.find(({ id }) => id === currentId));
  const matchingConnections = $derived.by(() => {
    const source = libraryReferenceUrl(subscription?.url);
    const hostname = source ? new URL(source).hostname : '';
    return connections.filter(
      ({ id, domains, status }) =>
        id === subscription?.connectionId ||
        (status === MediaConnectionStatus.Connected &&
          domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))),
    );
  });
  const settingsChanged = $derived(
    !!subscription &&
      (interval !== subscription.intervalMinutes || (connectionId || null) !== subscription.connectionId),
  );
  const connectionMissing = $derived(!!connectionId && !connections.some(({ id }) => id === connectionId));

  const readConnections = async () => {
    connectionsFailed = false;
    try {
      ({ connections } = await getMediaConnections({ signal: controller.signal }));
    } catch {
      connectionsFailed = true;
    }
  };

  const load = async () => {
    const generation = revision;
    try {
      const { subscriptions: result } = await getMediaSubscriptions({ signal: controller.signal });
      if (!pending && generation === revision && !controller.signal.aborted) {
        subscriptions = result;
        loadFailed = false;
        if (loading && initialId) {
          const initial = result.find(({ id }) => id === initialId);
          if (initial) {
            void open(initial);
          }
        }
      }
    } catch {
      loadFailed = true;
    } finally {
      if (!controller.signal.aborted) {
        loading = false;
        timer = setTimeout(() => void load(), 6000);
      }
    }
  };

  onMount(() => {
    void load();
    void readConnections();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  });

  const open = async (value: MediaSubscriptionResponseDto, event?: MouseEvent) => {
    lastTrigger = event?.currentTarget as HTMLElement | undefined;
    currentId = value.id;
    interval = MEDIA_INTERVALS.find((minutes) => minutes === value.intervalMinutes) ?? 60;
    connectionId = value.connectionId ?? '';
    updateFailed = false;
    confirmUnsubscribe = false;
    historyOpen = false;
    await tick();
    heading?.focus();
  };

  const back = async () => {
    currentId = '';
    await tick();
    lastTrigger?.focus();
  };

  const update = async (mediaSubscriptionUpdateDto: MediaSubscriptionUpdateDto) => {
    if (!subscription || pending) {
      return;
    }
    const id = subscription.id;
    pending = true;
    revision++;
    updateFailed = false;
    try {
      const updated = await updateMediaSubscription({ id, mediaSubscriptionUpdateDto });
      subscriptions = subscriptions.map((value) => (value.id === id ? updated : value));
      confirmUnsubscribe = false;
    } catch {
      updateFailed = true;
    } finally {
      revision++;
      pending = false;
    }
  };

  const save = () => {
    if (!subscription || !settingsChanged) {
      return;
    }
    void update({
      ...(interval !== subscription.intervalMinutes && { intervalMinutes: interval }),
      ...((connectionId || null) !== subscription.connectionId && { connectionId: connectionId || null }),
    });
  };
</script>

{#if loading}
  <p role="status">{$t('loading')}</p>
{:else if subscription}
  <div class="media-fields">
    {@const source = libraryReferenceUrl(subscription.url)}
    <div><Button disabled={pending} onclick={() => void back()}>{$t('back')}</Button></div>
    <h3 tabindex="-1" bind:this={heading}>{subscription.creator} · {subscription.provider}</h3>
    <p role="status">{$t(`frameleaf_boards_media_subscription_${subscription.status}`)}</p>
    <p class="media-secondary">
      {$t('frameleaf_boards_media_subscription_counts', {
        values: {
          discovered: subscription.discovered,
          saved: subscription.saved,
          skipped: subscription.skipped,
          failed: subscription.failed,
        },
      })}
    </p>
    <p>
      {$t('frameleaf_boards_media_history_choice')} · {$t(
        `frameleaf_boards_media_history_${subscription.history.mode}`,
      )}
      {#if subscription.history.mode === MediaHistoryMode.Since && subscription.history.since}
        <time datetime={subscription.history.since}>{mediaDate(subscription.history.since, $locale)}</time>
      {/if}
    </p>
    <p class="media-secondary">
      {$t('frameleaf_boards_media_last_success')} ·
      {#if subscription.lastSuccessAt}
        <time datetime={subscription.lastSuccessAt}>{mediaDate(subscription.lastSuccessAt, $locale)}</time>
      {:else}
        {$t('frameleaf_boards_media_never')}
      {/if}
    </p>
    {#if subscription.status === MediaSubscriptionState.Active}
      <p class="media-secondary">
        {$t('frameleaf_boards_media_next_check')} ·
        <time datetime={subscription.nextCheckAt}>{mediaDate(subscription.nextCheckAt, $locale)}</time>
      </p>
    {/if}
    {#if subscription.limitation}
      <p class="media-secondary">{subscription.limitation}</p>
    {:else if !subscription.historyComplete}
      <p class="media-secondary">{$t('frameleaf_boards_media_incomplete_history')}</p>
    {/if}
    {#if subscription.error}<p role="alert">{subscription.error}</p>{/if}
    {#if loadFailed}<p role="status">{$t('frameleaf_boards_media_progress_reconnecting')}</p>{/if}
    {#if updateFailed}<InlineError compact message={$t('frameleaf_boards_media_action_error')} />{/if}
    <div class="media-actions">
      {#if subscription.albumId}
        <a href={Route.viewAlbum({ id: subscription.albumId })} onclick={onOpenResult}>
          {$t('frameleaf_boards_media_open_collection')}
        </a>
      {/if}
      {#if source}
        <a href={source} target="_blank" rel="noopener noreferrer">{$t('frameleaf_boards_media_open_source')}</a>
      {/if}
    </div>
    {#if subscription.status !== MediaSubscriptionState.Unsubscribed}
      <div class="media-fields">
        <label class="media-field">
          {$t('frameleaf_boards_media_interval')}
          <select bind:value={interval} disabled={pending}>
            {#each MEDIA_INTERVALS as value (value)}
              <option {value}>{$t(`frameleaf_boards_media_interval_${value}`)}</option>
            {/each}
          </select>
        </label>
        {#if connectionsFailed}
          <InlineError compact message={$t('frameleaf_boards_media_connections_error')} onRetry={readConnections} />
        {/if}
        <label class="media-field">
          {$t('frameleaf_boards_media_change_connection')}
          <select bind:value={connectionId} disabled={pending || connectionsFailed}>
            <option value="">{$t('frameleaf_boards_media_public_access')}</option>
            {#if connectionMissing}
              <option value={connectionId} disabled>{$t('frameleaf_boards_media_missing_connection')}</option>
            {/if}
            {#each matchingConnections as connection (connection.id)}
              <option value={connection.id} disabled={connection.status !== MediaConnectionStatus.Connected}>
                {connection.label} · {$t(`frameleaf_boards_media_connection_${connection.status}`)}
              </option>
            {/each}
          </select>
        </label>
        <div class="media-actions">
          <Button disabled={pending || !settingsChanged} onclick={save}
            >{$t('frameleaf_boards_media_save_settings')}</Button
          >
          {#if subscription.status === MediaSubscriptionState.Active}
            <Button disabled={pending} onclick={() => void update({ action: MediaSubscriptionAction.Check })}>
              {$t('frameleaf_boards_media_check_now')}
            </Button>
            <Button disabled={pending} onclick={() => void update({ action: MediaSubscriptionAction.Pause })}>
              {$t('frameleaf_boards_media_pause')}
            </Button>
          {:else}
            <Button disabled={pending} onclick={() => void update({ action: MediaSubscriptionAction.Resume })}>
              {$t('frameleaf_boards_media_resume')}
            </Button>
          {/if}
        </div>
      </div>
      {#if confirmUnsubscribe}
        <p>{$t('frameleaf_boards_media_unsubscribe_hint')}</p>
        <div class="media-actions">
          <Button
            disabled={pending}
            variant="danger"
            onclick={() => void update({ action: MediaSubscriptionAction.Unsubscribe })}
          >
            {$t('frameleaf_boards_media_unsubscribe')}
          </Button>
          <Button disabled={pending} onclick={() => (confirmUnsubscribe = false)}>{$t('cancel')}</Button>
        </div>
      {:else}
        <div>
          <Button disabled={pending} onclick={() => (confirmUnsubscribe = true)}
            >{$t('frameleaf_boards_media_unsubscribe')}</Button
          >
        </div>
      {/if}
    {/if}
    <details bind:open={historyOpen}>
      <summary>{$t('frameleaf_boards_media_check_history')}</summary>
      {#if historyOpen}
        <MediaImportHistory subscriptionId={subscription.id} {onOpenResult} {onSaved} />
      {/if}
    </details>
  </div>
{:else if loadFailed && subscriptions.length === 0}
  <p role="status">{$t('frameleaf_boards_media_subscriptions_error')}</p>
{:else if subscriptions.length}
  <ul class="media-list">
    {#each subscriptions as value (value.id)}
      <li>
        <strong>{value.creator} · {value.provider}</strong>
        <span class="media-secondary">{$t(`frameleaf_boards_media_subscription_${value.status}`)}</span>
        <div>
          <Button
            label={$t('frameleaf_boards_media_manage_creator', { values: { name: value.creator } })}
            onclick={(event) => void open(value, event)}
          >
            {$t('frameleaf_boards_media_manage')}
          </Button>
        </div>
      </li>
    {/each}
  </ul>
{:else}
  <p>{$t('frameleaf_boards_media_subscriptions_empty')}</p>
{/if}
