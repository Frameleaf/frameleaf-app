<script lang="ts">
  import {
    getMediaCreatorItems,
    markMediaCreatorSeen,
    MediaCreatorItemSort,
    MediaItemKind,
    MediaQuality,
    MediaReachMode,
    MediaSubscriptionAction,
    updateMediaCreator,
    updateMediaSubscription,
    type MediaCreatorItemResponse,
    type MediaCreatorResponseDto,
    type MediaImportResponseDto,
    type MediaSaves,
    type MediaSubscriptionUpdateDto,
  } from '@frameleaf/sdk';
  import { Icon, toastManager } from '@frameleaf/ui';
  import {
    mdiAlertCircleOutline,
    mdiCheck,
    mdiCheckCircleOutline,
    mdiDownloadOutline,
    mdiEyeOffOutline,
    mdiMagnify,
    mdiPause,
    mdiPauseCircleOutline,
    mdiPlay,
    mdiPlayCircle,
    mdiRefresh,
    mdiRss,
    mdiTune,
  } from '@mdi/js';
  import { debounce } from 'lodash-es';
  import { onDestroy, untrack } from 'svelte';
  import { locale, t, type Translations } from 'svelte-i18n';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import { MEDIA_INTERVALS, type MediaInterval } from '$lib/components/frameleaf/media/boards-media';
  import {
    buildReach,
    CREATOR_PLATFORMS,
    CREATOR_SECTION_LABELS,
    creatorBannerUrl,
    creatorItemImage,
    creatorPlatform,
    creatorSection,
    creatorState,
    creatorStatus,
    defaultSaves,
    groupLists,
    groupPosts,
    mediaLength,
    platformName,
    postedDate,
    reachDate,
    savesFor,
    sectionRequest,
    watchedPercent,
    type CreatorKind,
    type CreatorSectionId,
    type CreatorsLocation,
  } from '$lib/frameleaf/creators';
  import { creatorsStore, followAddress } from '$lib/frameleaf/creators-store.svelte';
  import CreatorAvatar from './CreatorAvatar.svelte';
  import PlatformMark from './PlatformMark.svelte';
  import SubscriptionOptions from './SubscriptionOptions.svelte';

  /**
   * A creator's page (prototype `CreatorPage`): their banner and name, how the subscription is going,
   * and what the Library saved, in the sections their site has. The section, kind, "Not watched yet",
   * sort and search are the Library's own query, a page at a time.
   */
  let {
    creator,
    section,
    kind,
    unwatched,
    settings,
    items = $bindable([]),
    onView,
    onOpenItem,
  }: {
    creator: MediaCreatorResponseDto;
    section: string | null;
    kind: CreatorKind;
    unwatched: boolean;
    settings: boolean;
    items?: MediaCreatorItemResponse[];
    onView: (change: Partial<CreatorsLocation>) => void;
    onOpenItem: (item: MediaCreatorItemResponse) => void;
  } = $props();

  const creatorId = $derived(creator.id);
  const platform = $derived(creatorPlatform(creator.provider, creator.url));
  const site = $derived(platformName(platform, creator.provider) || $t('frameleaf_creators_platform_website'));
  const standing = $derived(creatorState(creator));
  const status = $derived(creatorStatus(creator, $locale));
  /** "@maraellis · 6 saved · Timber framing…" */
  const meta = $derived(
    [creator.handle, $t('frameleaf_creators_saved_count', { values: { count: creator.savedCount } }), creator.about]
      .filter(Boolean)
      .join(' · '),
  );
  const current = $derived(creatorSection(platform, section));
  const request = $derived(sectionRequest(platform, current));
  const layout = $derived(request.layout);
  const apiSection = $derived(request.section);
  const apiKind = $derived(
    request.kind ?? (kind === 'video' ? MediaItemKind.Video : kind === 'image' ? MediaItemKind.Image : undefined),
  );
  const STATE_ICONS = {
    on: mdiCheckCircleOutline,
    paused: mdiPauseCircleOutline,
    attention: mdiAlertCircleOutline,
    saved: mdiDownloadOutline,
  };
  const SORTS = [MediaCreatorItemSort.Newest, MediaCreatorItemSort.Oldest, MediaCreatorItemSort.Longest];
  const KINDS: [CreatorKind, Translations][] = [
    ['all', 'frameleaf_creators_all'],
    ['video', 'frameleaf_creators_kind_videos'],
    ['image', 'frameleaf_creators_kind_pictures'],
  ];

  /* ---- what was saved ---- */
  let query = $state('');
  let search = $state('');
  let sort = $state(MediaCreatorItemSort.Newest);
  let page = $state(1);
  let hasNextPage = $state(false);
  let loading = $state(true);
  let failed = $state(false);
  /** When this account last opened the creator, before this visit: what came after is "New". */
  let seenBefore = $state('');
  let generation = 0;
  const applySearch = debounce((value: string) => (search = value.trim()), 300);
  onDestroy(() => {
    generation++;
    applySearch.cancel();
  });

  const load = async (next: number) => {
    const version = ++generation;
    loading = true;
    failed = false;
    try {
      const result = await getMediaCreatorItems({
        id: creatorId,
        section: apiSection,
        kind: apiKind,
        unwatched: unwatched || undefined,
        q: search || undefined,
        sort,
        page: next,
      });
      if (version !== generation) {
        return;
      }
      // Paging is by offset: items arriving or leaving meanwhile shift the next page, so repeats are dropped.
      const shown = new Set(items.map(({ assetId }) => assetId));
      items = next === 1 ? result.items : [...items, ...result.items.filter(({ assetId }) => !shown.has(assetId))];
      page = result.page;
      hasNextPage = result.hasNextPage;
    } catch {
      if (version === generation) {
        failed = true;
      }
    } finally {
      if (version === generation) {
        loading = false;
      }
    }
  };

  $effect(() => {
    // Everything the Library's query is made of; any change starts again from the first page.
    void [creatorId, apiSection, apiKind, unwatched, search, sort];
    untrack(() => {
      items = [];
      void load(1);
    });
  });

  const markSeen = async (id: string) => {
    try {
      creatorsStore.replace(await markMediaCreatorSeen({ id }));
    } catch {
      // The count beside the creator stays until the next visit.
    }
  };
  $effect(() => {
    const id = creatorId;
    untrack(() => {
      seenBefore = creator.seenAt;
      query = '';
      search = '';
      sort = MediaCreatorItemSort.Newest;
      void markSeen(id);
    });
  });

  const isNew = (item: MediaCreatorItemResponse) => !!seenBefore && item.savedAt > seenBefore;
  const filtered = $derived(kind !== 'all' || unwatched || !!search);
  const posts = $derived(layout === 'timeline' ? groupPosts(items) : []);
  const groups = $derived(layout === 'groups' ? groupLists(items) : []);
  const portrait = $derived(layout === 'shorts');
  const asPins = $derived(
    layout === 'pins' || layout === 'media' || (layout === 'mixed' && items[0]?.kind === MediaItemKind.Image),
  );

  /* ---- the subscription ---- */
  const receipts = new Map<string, string>();
  const previews = new Map<string, MediaImportResponseDto>();
  const controller = new AbortController();
  onDestroy(() => controller.abort());
  let saves = $state<MediaSaves>({});
  let quality = $state(MediaQuality.Best);
  let reach = $state<MediaReachMode>();
  let since = $state('');
  let interval = $state<MediaInterval>(60);
  let folderId = $state<string | null>(null);
  let busy = $state(false);
  let error = $state<Translations | ''>('');

  // Opening the panel shows what was chosen when this creator was followed; following starts unchosen.
  $effect(() => {
    void [creatorId, settings];
    untrack(() => {
      const subscription = creator.following ? creator.subscription : null;
      error = '';
      saves = subscription ? savesFor(platform, subscription.saves) : defaultSaves(platform);
      quality = subscription?.quality ?? MediaQuality.Best;
      reach = subscription?.history.mode;
      since = reachDate(subscription?.history);
      interval = MEDIA_INTERVALS.find((value) => value === subscription?.intervalMinutes) ?? 60;
      folderId = creator.parentAlbumId;
    });
  });

  const act = async (action: MediaSubscriptionAction, message: string) => {
    const subscription = creator.subscription;
    if (busy || !subscription) {
      return;
    }
    busy = true;
    error = '';
    try {
      await updateMediaSubscription({ id: subscription.id, mediaSubscriptionUpdateDto: { action } });
      toastManager.primary(message);
      if (action === MediaSubscriptionAction.Unsubscribe) {
        onView({ settings: false });
      }
      if (action === MediaSubscriptionAction.Check) {
        creatorsStore.started();
      }
      await creatorsStore.refreshCreator(creatorId);
    } catch {
      error = 'frameleaf_creators_action_error';
    } finally {
      busy = false;
    }
  };

  const save = async () => {
    const subscription = creator.subscription;
    const history = buildReach(reach, since);
    if (busy || !subscription || !history) {
      return;
    }
    const change: MediaSubscriptionUpdateDto = {};
    if (JSON.stringify(saves) !== JSON.stringify(savesFor(platform, subscription.saves))) {
      change.saves = saves;
    }
    if (quality !== subscription.quality) {
      change.quality = quality;
    }
    if (interval !== subscription.intervalMinutes) {
      change.intervalMinutes = interval;
    }
    if (history.mode !== subscription.history.mode || since !== reachDate(subscription.history)) {
      change.history = history;
    }
    busy = true;
    error = '';
    try {
      if (Object.keys(change).length > 0) {
        await updateMediaSubscription({ id: subscription.id, mediaSubscriptionUpdateDto: change });
      }
      if (folderId !== creator.parentAlbumId) {
        await updateMediaCreator({ id: creatorId, mediaCreatorUpdateDto: { parentAlbumId: folderId } });
      }
      await creatorsStore.refreshCreator(creatorId);
      onView({ settings: false });
    } catch {
      error = 'frameleaf_creators_save_error';
    } finally {
      busy = false;
    }
  };

  const follow = async () => {
    const history = buildReach(reach, since);
    if (busy || !creator.url || !history) {
      return;
    }
    busy = true;
    error = '';
    try {
      await followAddress(
        creator.url,
        {
          history,
          intervalMinutes: interval,
          parentId: folderId ?? undefined,
          quality: platform === 'pinterest' ? undefined : quality,
          saves,
        },
        receipts,
        previews,
        controller.signal,
      );
      toastManager.primary($t('frameleaf_creators_following', { values: { name: creator.name } }));
      creatorsStore.started();
      await creatorsStore.refreshCreator(creatorId);
      onView({ settings: false });
    } catch {
      if (!controller.signal.aborted) {
        error = 'frameleaf_creators_follow_error';
      }
    } finally {
      busy = false;
    }
  };

  const openGroup = () =>
    onView({ section: (platform === 'pinterest' ? 'pins' : 'videos') satisfies CreatorSectionId });
</script>

{#snippet watched(percent: number)}
  {#if percent >= 100}
    <span class="cr-watched" title={$t('frameleaf_creators_watched')}>
      <Icon icon={mdiCheck} size="12" aria-hidden={true} />
      {$t('frameleaf_creators_watched')}
    </span>
  {:else if percent > 0}
    <span class="cr-progress" role="img" aria-label={$t('frameleaf_creators_watched_percent', { values: { percent } })}>
      <span style:width="{percent}%"></span>
    </span>
  {/if}
{/snippet}

{#snippet pinTile(item: MediaCreatorItemResponse)}
  {@const label = item.title || item.description.slice(0, 40)}
  <li class="cr-pin">
    <button
      type="button"
      onclick={() => onOpenItem(item)}
      aria-label={label || $t(`frameleaf_creators_kind_${item.kind}`)}
    >
      <img src={creatorItemImage(item)} alt="" loading="lazy" />
      {#if isNew(item)}<span class="cr-new">{$t('frameleaf_creators_new')}</span>{/if}
      {#if label}<strong>{label}</strong>{/if}
    </button>
  </li>
{/snippet}

<header class="cr-channel" class:plain={!creator.hasBanner}>
  {#if creator.hasBanner}<img class="cr-banner" src={creatorBannerUrl(creator.id)} alt="" />{/if}
  <div class="cr-channel-row">
    <span class="cr-avatar-wrap"><CreatorAvatar {creator} size={72} /></span>
    <div class="cr-channel-name">
      <h1>{creator.name} <PlatformMark {platform} provider={creator.provider} size={18} /></h1>
      <p>{meta}</p>
      <p class="cr-status {standing}">
        <Icon icon={STATE_ICONS[standing]} size="16" aria-hidden={true} />
        {$t(status.key, { values: status.values })}
      </p>
    </div>
    <div class="cr-channel-actions">
      {#if creator.following && creator.subscription}
        {#if standing === 'attention'}
          <Button variant="primary" onclick={() => (creatorsStore.connectionsOpen = true)}>
            {$t('frameleaf_creators_sign_in_again', { values: { name: site } })}
          </Button>
        {:else}
          <Button
            disabled={busy || standing === 'paused'}
            onclick={() =>
              void act(
                MediaSubscriptionAction.Check,
                $t('frameleaf_creators_checking', { values: { name: creator.name } }),
              )}
          >
            <Icon icon={mdiRefresh} size="18" aria-hidden={true} />{$t('frameleaf_creators_check_now')}
          </Button>
        {/if}
        {#if standing === 'paused'}
          <Button
            disabled={busy}
            onclick={() => void act(MediaSubscriptionAction.Resume, $t('frameleaf_creators_carrying_on'))}
          >
            <Icon icon={mdiPlay} size="18" aria-hidden={true} />{$t('frameleaf_creators_carry_on')}
          </Button>
        {:else}
          <Button
            disabled={busy}
            onclick={() => void act(MediaSubscriptionAction.Pause, $t('frameleaf_creators_paused_note'))}
          >
            <Icon icon={mdiPause} size="18" aria-hidden={true} />{$t('frameleaf_creators_pause')}
          </Button>
        {/if}
        <Button pressed={settings} onclick={() => onView({ settings: !settings })}>
          <Icon icon={mdiTune} size="18" aria-hidden={true} />{$t('frameleaf_creators_subscription')}
        </Button>
      {:else}
        <Button variant="primary" disabled={!creator.url} onclick={() => onView({ settings: !settings })}>
          <Icon icon={mdiRss} size="18" aria-hidden={true} />{$t('frameleaf_creators_follow')}
        </Button>
      {/if}
    </div>
  </div>
  {#if error && !settings}
    <div class="cr-settings"><InlineError compact message={$t(error)} /></div>
  {/if}
  {#if settings && (creator.following ? !!creator.subscription : !!creator.url)}
    <section class="cr-settings" aria-label={$t('frameleaf_creators_subscription')}>
      <SubscriptionOptions
        {platform}
        bind:saves
        bind:quality
        bind:reach
        bind:since
        bind:interval
        bind:folderId
        disabled={busy}
      />
      {#if error}<InlineError compact message={$t(error)} />{/if}
      <div class="cr-settings-foot">
        {#if creator.following}
          <small>{$t('frameleaf_creators_settings_note')}</small>
          <Button
            variant="danger"
            disabled={busy}
            onclick={() =>
              void act(
                MediaSubscriptionAction.Unsubscribe,
                $t('frameleaf_creators_unfollowed', { values: { name: creator.name } }),
              )}>{$t('frameleaf_creators_unfollow')}</Button
          >
          <Button variant="primary" disabled={busy || !buildReach(reach, since)} onclick={() => void save()}>
            {$t('done')}
          </Button>
        {:else}
          <small>
            {reach
              ? $t('frameleaf_creators_follow_hint', { values: { name: creator.name } })
              : $t('frameleaf_creators_follow_choose')}
          </small>
          <Button disabled={busy} onclick={() => onView({ settings: false })}>{$t('cancel')}</Button>
          <Button variant="primary" disabled={busy || !buildReach(reach, since)} onclick={() => void follow()}>
            <Icon icon={mdiRss} size="18" aria-hidden={true} />{$t('frameleaf_creators_follow_and_download')}
          </Button>
        {/if}
      </div>
    </section>
  {/if}
  <nav class="cr-tabs" aria-label={$t('frameleaf_creators_sections', { values: { name: creator.name } })}>
    {#each CREATOR_PLATFORMS[platform].sections as id (id)}
      <button type="button" aria-current={current === id ? 'page' : undefined} onclick={() => onView({ section: id })}>
        {$t(CREATOR_SECTION_LABELS[id])}
      </button>
    {/each}
  </nav>
</header>

<div class="cr-filters" role="toolbar" aria-label={$t('frameleaf_creators_filters')}>
  <div class="cr-chips" role="group" aria-label={$t('frameleaf_creators_kind')}>
    {#each KINDS as [id, label] (id)}
      <button type="button" class="cr-chip" aria-pressed={kind === id} onclick={() => onView({ kind: id })}>
        {$t(label)}
      </button>
    {/each}
  </div>
  <button type="button" class="cr-chip" aria-pressed={unwatched} onclick={() => onView({ unwatched: !unwatched })}>
    <Icon icon={mdiEyeOffOutline} size="16" aria-hidden={true} />
    {$t('frameleaf_creators_not_watched')}
  </button>
  <span class="cr-spacer"></span>
  <label class="cr-sort">
    <span class="sr-only">{$t('frameleaf_creators_sort')}</span>
    <select bind:value={sort}>
      {#each SORTS as value (value)}
        <option {value}>{$t(`frameleaf_creators_sort_${value}`)}</option>
      {/each}
    </select>
  </label>
  <label class="cr-search">
    <Icon icon={mdiMagnify} size="16" aria-hidden={true} />
    <input
      type="search"
      placeholder={$t('frameleaf_creators_search', { values: { name: creator.name } })}
      aria-label={$t('frameleaf_creators_search', { values: { name: creator.name } })}
      bind:value={query}
      oninput={() => applySearch(query)}
    />
  </label>
</div>

<div class="cr-scroll">
  {#if failed && items.length === 0}
    <InlineError compact message={$t('frameleaf_creators_load_error')} onRetry={() => load(1)} />
  {:else if items.length === 0 && loading}
    <p class="cr-empty" role="status">{$t('loading')}</p>
  {:else if items.length === 0 || (layout === 'groups' && groups.length === 0)}
    <p class="cr-empty">{$t(filtered ? 'frameleaf_creators_no_match' : 'frameleaf_creators_nothing_saved')}</p>
  {:else if layout === 'timeline'}
    <ul class="cr-timeline">
      {#each posts as post (post.id)}
        <li class="cr-post">
          <CreatorAvatar {creator} size={36} />
          <div>
            <p class="cr-post-head">
              <strong>{creator.name}</strong>
              {#if creator.handle}<span>{creator.handle}</span>{/if}
              <span>· {postedDate(post.first.publishedAt ?? post.first.savedAt, $locale)}</span>
            </p>
            <p class="cr-post-text cr-pre">{post.first.description || post.first.title}</p>
            {#if post.first.tags.length > 0}
              <p class="cr-tags">
                {#each post.first.tags as tag (tag)}<span>#{tag}</span>{/each}
              </p>
            {/if}
            <div class="cr-post-media" data-count={Math.min(post.media.length, 3)}>
              {#each post.media as item (item.assetId)}
                {@const length = mediaLength(item.duration)}
                <button
                  type="button"
                  onclick={() => onOpenItem(item)}
                  aria-label={$t(
                    item.kind === MediaItemKind.Image
                      ? 'frameleaf_creators_open_picture'
                      : 'frameleaf_creators_play_video',
                  )}
                >
                  <img src={creatorItemImage(item)} alt="" loading="lazy" />
                  {#if item.kind !== MediaItemKind.Image}
                    <Icon icon={mdiPlayCircle} size="36" aria-hidden={true} class="cr-play" />
                    {#if length}<span class="cr-length">{length}</span>{/if}
                  {/if}
                </button>
              {/each}
            </div>
          </div>
        </li>
      {/each}
    </ul>
  {:else if layout === 'groups'}
    <ul class="cr-boards">
      {#each groups as group (group.id)}
        <li class="cr-board">
          <button type="button" onclick={openGroup}>
            <span class="cr-covers">
              {#each group.items.slice(0, 4) as cover (cover.assetId)}
                <img src={creatorItemImage(cover)} alt="" loading="lazy" />
              {/each}
            </span>
            <strong>{group.title}</strong>
            {#if !hasNextPage}
              <small>
                {$t(platform === 'pinterest' ? 'frameleaf_creators_count_pins' : 'frameleaf_creators_count_videos', {
                  values: { count: group.items.length },
                })}
              </small>
            {/if}
          </button>
        </li>
      {/each}
    </ul>
  {:else if asPins}
    <ul class="cr-pins">
      {#each items as item (item.assetId)}{@render pinTile(item)}{/each}
    </ul>
  {:else}
    <ul class="cr-videos" class:shorts={portrait}>
      {#each items as item (item.assetId)}
        {@const percent = watchedPercent(item)}
        {@const length = mediaLength(item.duration)}
        <li class="cr-video" class:short={portrait}>
          <button
            type="button"
            onclick={() => onOpenItem(item)}
            aria-label={item.title || $t(`frameleaf_creators_kind_${item.kind}`)}
          >
            <span class="cr-thumb">
              <img src={creatorItemImage(item)} alt="" loading="lazy" />
              {#if length}<span class="cr-length">{length}</span>{/if}
              {#if isNew(item)}<span class="cr-new">{$t('frameleaf_creators_new')}</span>{/if}
              {#if percent < 100}{@render watched(percent)}{/if}
            </span>
            <strong>{item.title || $t(`frameleaf_creators_kind_${item.kind}`)}</strong>
            <small>
              {postedDate(item.publishedAt ?? item.savedAt, $locale)}{#if percent >= 100}{@render watched(100)}{/if}
            </small>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
  {#if items.length > 0}
    {#if failed}
      <InlineError compact message={$t('frameleaf_creators_load_error')} onRetry={() => load(page + 1)} />
    {:else if hasNextPage}
      <div class="cr-more">
        <Button disabled={loading} onclick={() => void load(page + 1)}>{$t('frameleaf_creators_show_more')}</Button>
      </div>
    {/if}
  {/if}
</div>
