<script lang="ts">
  import {
    createMediaImport,
    getMediaCreator,
    inspectMedia,
    MediaImportState,
    MediaItemKind,
    MediaQuality,
    MediaReachMode,
    previewMediaSubscription,
    type MediaImportItemResponse,
    type MediaImportResponseDto,
    type MediaSaves,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiCheck,
    mdiClose,
    mdiDownloadOutline,
    mdiEarth,
    mdiHelpCircleOutline,
    mdiImageOutline,
    mdiLinkVariantPlus,
    mdiLockOutline,
    mdiRss,
    mdiVideoOutline,
    mdiWeb,
  } from '@mdi/js';
  import { onDestroy, untrack } from 'svelte';
  import { locale, t, type Translations } from 'svelte-i18n';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import { mediaImportActive, mediaReceiptKey, type MediaInterval } from '$lib/components/frameleaf/media/boards-media';
  import Spinner from '$lib/components/frameleaf/Spinner.svelte';
  import {
    ADDRESS_NOUNS,
    addressLabel,
    buildReach,
    CREATOR_PLATFORMS,
    CREATOR_QUALITIES,
    defaultSaves,
    mediaLength,
    platformName,
  } from '$lib/frameleaf/creators';
  import {
    awaitMediaInspection,
    creatorsStore,
    followAddress,
    followPreview,
    isFollowable,
  } from '$lib/frameleaf/creators-store.svelte';
  import { libraryReferenceUrl } from '$lib/frameleaf/library-reference';
  import { readMediaAddress } from '$lib/frameleaf/media-address';
  import CreatorAvatar from './CreatorAvatar.svelte';
  import PlatformMark from './PlatformMark.svelte';
  import SubscriptionOptions from './SubscriptionOptions.svelte';

  /**
   * The add box (prototype `AddBox` and `AddResult`): one field, and for the address in it one card
   * with every option on it. `readMediaAddress` picks the form at once (a whole account is followed,
   * one post is downloaded); the Library's own reading of the address fills in the real names.
   */
  let {
    address = $bindable(''),
    delay = 400,
    onDone,
  }: {
    address?: string;
    /** How long typing rests before the Library is asked to read the address. */
    delay?: number;
    /** Something started: what to say, and the creator whose page to open when there is one. */
    onDone: (message: string, creatorId?: string) => void;
  } = $props();

  const id = $props.id();
  const receipts = new Map<string, string>();
  const previews = new Map<string, MediaImportResponseDto>();
  let input = $state<HTMLInputElement>();
  let operation = $state<MediaImportResponseDto>();
  let inspectFailed = $state(false);
  let busy = $state(false);
  let error = $state<Translations | ''>('');
  let saves = $state<MediaSaves>({});
  let quality = $state(MediaQuality.Best);
  let reach = $state<MediaReachMode>();
  let since = $state('');
  let interval = $state<MediaInterval>(60);
  let folderId = $state<string | null>(null);
  let followToo = $state(false);
  let collectionId = $state('');
  let selected = $state<string[]>([]);
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const text = $derived(address.trim());
  const read = $derived(text ? readMediaAddress(text) : null);
  const url = $derived(read ? libraryReferenceUrl(text) : undefined);
  const platform = $derived(read?.platform ?? 'other');
  const connection = $derived(creatorsStore.connectionFor(url));
  const site = $derived(platformName(platform, operation?.provider) || $t('frameleaf_creators_platform_website'));
  const what = $derived(read ? $t(ADDRESS_NOUNS[read.what]) : '');
  const ready = $derived(operation?.state === MediaImportState.Ready);
  const stopped = $derived(inspectFailed || (!!operation && !mediaImportActive(operation.state) && !ready));
  const name = $derived(operation?.creator || addressLabel(text));
  const items = $derived(operation?.items ?? []);
  const reachValue = $derived(buildReach(reach, since));
  // The Library files items under their creator; when it found none, a collection has to be chosen.
  const needsCollection = $derived(ready && !operation?.creatorId);
  const hasVideo = $derived(
    items.length > 0
      ? items.some(({ kind }) => kind === MediaItemKind.Video)
      : platform === 'youtube' || platform === 'facebook',
  );
  const kept = $derived(
    hasVideo ? (['thumbnail', 'title', 'tags', 'posted'] as const) : (['words', 'tags', 'posted'] as const),
  );
  const count = (kind: MediaItemKind, list: MediaImportItemResponse[]) =>
    list.filter((item) => item.kind === kind).length;
  /** "1 video and 2 pictures". */
  const found = $derived.by(() => {
    const parts = (
      [
        [MediaItemKind.Video, 'frameleaf_creators_count_videos'],
        [MediaItemKind.Image, 'frameleaf_creators_count_pictures'],
        [MediaItemKind.Audio, 'frameleaf_creators_count_sounds'],
      ] as const
    ).flatMap(([kind, key]) => {
      const total = count(kind, items);
      return total > 0 ? [$t(key, { values: { count: total } })] : [];
    });
    return new Intl.ListFormat($locale ?? undefined, { type: 'conjunction' }).format(parts);
  });

  const stop = () => {
    clearTimeout(timer);
    controller?.abort();
    controller = undefined;
  };
  onDestroy(stop);

  const inspect = async (address: string, follow: boolean, connectionId: string | undefined) => {
    stop();
    const mine = new AbortController();
    controller = mine;
    inspectFailed = false;
    operation = undefined;
    try {
      const start = follow ? previewMediaSubscription : inspectMedia;
      const first = await start({ mediaInspectDto: { urls: [address], connectionId } }, { signal: mine.signal });
      if (mine.signal.aborted) {
        return;
      }
      operation = first;
      const finished = await awaitMediaInspection(first, mine.signal);
      if (!mine.signal.aborted) {
        operation = finished;
        selected = platform === 'other' ? finished.items.slice(0, 1).map(({ id }) => id) : [];
      }
    } catch {
      if (!mine.signal.aborted) {
        inspectFailed = true;
      }
    }
  };

  // A new address (or signing in to its site) starts over: the form is chosen at once, then read.
  $effect(() => {
    const address = url;
    const action = read?.action;
    const connectionId = connection?.id;
    const next = read?.platform ?? 'other';
    const wait = delay;
    untrack(() => {
      stop();
      operation = undefined;
      inspectFailed = false;
      error = '';
      busy = false;
      reach = undefined;
      since = '';
      followToo = false;
      collectionId = '';
      selected = [];
      saves = defaultSaves(next);
      if (address && action) {
        timer = setTimeout(() => void inspect(address, action === 'follow', connectionId), wait);
      }
    });
  });

  $effect(() => {
    if (creatorsStore.focusAdd > 0 && input) {
      input.focus();
      untrack(() => (creatorsStore.focusAdd = 0));
    }
  });

  const options = () => ({
    history: reachValue!,
    intervalMinutes: interval,
    parentId: folderId ?? undefined,
    quality: platform === 'pinterest' ? undefined : quality,
    saves,
  });

  const follow = async () => {
    if (busy || !operation || !isFollowable(operation) || !reachValue) {
      return;
    }
    busy = true;
    error = '';
    try {
      const result = await followPreview(operation, options(), receipts);
      onDone(
        $t(
          reachValue.mode === MediaReachMode.New
            ? 'frameleaf_creators_following_new'
            : 'frameleaf_creators_following_started',
          { values: { name: result.creator || name } },
        ),
        result.mediaCreatorId ?? undefined,
      );
    } catch {
      error = 'frameleaf_creators_follow_error';
    } finally {
      busy = false;
    }
  };

  const download = async () => {
    if (busy || !operation || !ready) {
      return;
    }
    const itemIds = (platform === 'other' ? [...selected] : items.map(({ id }) => id)).sort();
    if (itemIds.length === 0 || (followToo && !reachValue) || (needsCollection && !collectionId)) {
      return;
    }
    busy = true;
    error = '';
    const signal = new AbortController();
    controller = signal;
    try {
      // With a creator no collection is named: the Library files the items under them.
      const draft = {
        inspectionId: operation.id,
        itemIds,
        quality: hasVideo ? quality : undefined,
        ...(needsCollection && { albumId: collectionId }),
      };
      const started = await createMediaImport({
        mediaImportCreateDto: { ...draft, idempotencyKey: mediaReceiptKey(receipts, draft) },
      });
      const creatorId = started.mediaCreatorId ?? undefined;
      if (followToo && reachValue) {
        try {
          const creator = creatorId ? await getMediaCreator({ id: creatorId }) : undefined;
          if (!creator?.url) {
            throw new Error('The creator has no address to follow');
          }
          await followAddress(creator.url, options(), receipts, previews, signal.signal);
        } catch {
          // The download is running; pressing the button again sends the same download and tries the follow.
          creatorsStore.started();
          error = 'frameleaf_creators_follow_too_error';
          return;
        }
      }
      const values = { name: started.creator || name, count: itemIds.length };
      onDone(
        followToo
          ? $t('frameleaf_creators_following_started', { values })
          : $t(creatorId ? 'frameleaf_creators_downloading_creator' : 'frameleaf_creators_downloading_items', {
              values,
            }),
        creatorId,
      );
    } catch {
      error = 'frameleaf_creators_download_error';
    } finally {
      busy = false;
    }
  };
</script>

{#snippet reading()}
  {#if stopped}
    <InlineError
      compact
      message={$t('frameleaf_creators_read_error')}
      onRetry={() => (url && read ? inspect(url, read.action === 'follow', connection?.id) : undefined)}
    />
  {:else if !ready}
    <p class="cr-reading" role="status"><Spinner />{$t('frameleaf_creators_reading')}</p>
  {:else if operation?.limitation}
    <p class="cr-muted cr-pre">{operation.limitation}</p>
  {/if}
{/snippet}

{#snippet qualityChoice()}
  <fieldset disabled={busy}>
    <legend>{$t('frameleaf_creators_video_quality')}</legend>
    <div class="cr-seg">
      {#each CREATOR_QUALITIES as value (value)}
        <label>
          <input type="radio" name="{id}-one-quality" {value} bind:group={quality} />
          <span>{$t(`frameleaf_creators_quality_${value}`)}</span>
        </label>
      {/each}
    </div>
  </fieldset>
{/snippet}

{#snippet collectionChoice()}
  {#if needsCollection}
    <div class="cr-options">
      <label>
        <span>{$t('frameleaf_creators_collection')}</span>
        <select bind:value={collectionId} disabled={busy}>
          <option value="" disabled>{$t('frameleaf_creators_collection_choose')}</option>
          {#each creatorsStore.folders as folder (folder.id)}
            <option value={folder.id}>{folder.albumName}</option>
          {/each}
        </select>
        <small>{$t('frameleaf_creators_collection_hint')}</small>
      </label>
    </div>
  {/if}
{/snippet}

<div class="cr-add">
  <label class="cr-add-field">
    <Icon icon={mdiLinkVariantPlus} size="20" aria-hidden={true} />
    <input
      bind:this={input}
      bind:value={address}
      type="text"
      inputmode="url"
      autocomplete="off"
      spellcheck="false"
      maxlength="8192"
      placeholder={$t('frameleaf_creators_add_placeholder')}
      aria-label={$t('frameleaf_creators_add_label')}
      data-initial-focus
    />
    {#if address}
      <button type="button" class="cr-clear" aria-label={$t('clear')} onclick={() => (address = '')}>
        <Icon icon={mdiClose} size="18" aria-hidden={true} />
      </button>
    {/if}
  </label>

  {#if text && (!read || !url)}
    <p class="cr-unread" role="status">
      <Icon icon={mdiHelpCircleOutline} size="18" aria-hidden={true} />
      {$t('frameleaf_creators_unread')}
    </p>
  {:else if read && platform === 'other'}
    <section class="cr-result" aria-label={$t('frameleaf_creators_found_label')}>
      <header>
        <span class="cr-result-icon"><Icon icon={mdiWeb} size="22" aria-hidden={true} /></span>
        <div>
          <strong>{addressLabel(text)}</strong>
          {#if ready}
            <small>
              {items.length > 0
                ? $t('frameleaf_creators_found', { values: { found } })
                : $t('frameleaf_creators_found_nothing')}
            </small>
          {/if}
        </div>
      </header>
      {@render reading()}
      {#if ready && items.length > 0}
        <ul class="cr-found">
          {#each items as item (item.id)}
            {@const length = mediaLength(item.duration)}
            <li>
              <label>
                <input type="checkbox" value={item.id} bind:group={selected} disabled={busy} />
                <Icon
                  icon={item.kind === MediaItemKind.Image ? mdiImageOutline : mdiVideoOutline}
                  size="20"
                  aria-hidden={true}
                />
                <span>
                  <strong>{item.title || $t(`frameleaf_creators_kind_${item.kind}`)}</strong>
                  <small>{$t(`frameleaf_creators_kind_${item.kind}`)}{length ? ` · ${length}` : ''}</small>
                </span>
              </label>
            </li>
          {/each}
        </ul>
        {#if hasVideo}<div class="cr-options">{@render qualityChoice()}</div>{/if}
      {/if}
      {@render collectionChoice()}
      {#if error}<InlineError compact message={$t(error)} />{/if}
      <footer>
        <small
          >{$t('frameleaf_creators_saved_under', { values: { name: operation?.creator || addressLabel(text) } })}</small
        >
        <Button
          variant="primary"
          disabled={!ready || busy || selected.length === 0 || (needsCollection && !collectionId)}
          onclick={() => void download()}
        >
          <Icon icon={mdiDownloadOutline} size="18" aria-hidden={true} />{$t('frameleaf_creators_download')}
        </Button>
      </footer>
    </section>
  {:else if read?.action === 'follow'}
    {@const signedOut = !connection}
    <section class="cr-result" aria-label={$t('frameleaf_creators_follow_name', { values: { name } })}>
      <header>
        <CreatorAvatar creator={{ name }} size={48} />
        <div>
          <strong>{name} <PlatformMark {platform} provider={operation?.provider} /></strong>
          <small>
            {site}
            {what}{#if ready && items.length > 0}
              · {$t(operation?.complete ? 'frameleaf_creators_about_posts' : 'frameleaf_creators_more_posts', {
                values: { count: items.length },
              })}{/if}
          </small>
        </div>
        <span class="cr-verdict">
          <Icon icon={mdiRss} size="14" aria-hidden={true} />
          {$t('frameleaf_creators_verdict_follow', { values: { what } })}
        </span>
      </header>
      {@render reading()}
      {#if ready && !isFollowable(operation)}
        <InlineError compact message={$t('frameleaf_creators_not_followable')} />
      {/if}
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
      <p class="cr-signin" class:needed={signedOut && CREATOR_PLATFORMS[platform].needsSignIn}>
        <Icon
          icon={signedOut && CREATOR_PLATFORMS[platform].needsSignIn ? mdiLockOutline : mdiEarth}
          size="16"
          aria-hidden={true}
        />
        {#if connection}
          <span>{$t('frameleaf_creators_signed_in', { values: { name: site, label: connection.label } })}</span>
        {:else}
          <span>
            {$t(
              CREATOR_PLATFORMS[platform].needsSignIn
                ? 'frameleaf_creators_signin_needed'
                : 'frameleaf_creators_signin_public',
              { values: { name: site } },
            )}
          </span>
          <Button onclick={() => (creatorsStore.connectionsOpen = true)}>
            {$t('frameleaf_creators_connect', { values: { name: site } })}
          </Button>
        {/if}
      </p>
      {#if error}<InlineError compact message={$t(error)} />{/if}
      <footer>
        <small>
          {reach ? $t('frameleaf_creators_follow_hint', { values: { name } }) : $t('frameleaf_creators_follow_choose')}
          {$t('frameleaf_creators_change_later')}
        </small>
        <Button
          variant="primary"
          disabled={!ready || !isFollowable(operation) || !reachValue || busy}
          onclick={() => void follow()}
        >
          <Icon icon={mdiRss} size="18" aria-hidden={true} />{$t('frameleaf_creators_follow_and_download')}
        </Button>
      </footer>
    </section>
  {:else if read}
    {@const first = items[0]}
    {@const length = mediaLength(first?.duration)}
    <section class="cr-result" aria-label={$t('frameleaf_creators_download_this')}>
      <header>
        <span class="cr-thumb small">
          <Icon icon={hasVideo ? mdiVideoOutline : mdiImageOutline} size="28" aria-hidden={true} />
          {#if length && items.length === 1}<span class="cr-length">{length}</span>{/if}
        </span>
        <div>
          <strong>{first?.title || first?.description || addressLabel(text)}</strong>
          <small>
            <PlatformMark {platform} provider={operation?.provider} />
            {name} · {items.length > 1 ? found : $t('frameleaf_creators_one_what', { values: { what } })}
          </small>
        </div>
        <span class="cr-verdict">
          <Icon icon={mdiDownloadOutline} size="14" aria-hidden={true} />
          {$t('frameleaf_creators_verdict_download', { values: { what } })}
        </span>
      </header>
      {@render reading()}
      <div class="cr-options compact">
        {#if hasVideo && (!followToo || platform === 'pinterest')}{@render qualityChoice()}{/if}
        <fieldset>
          <legend>{$t('frameleaf_creators_comes_with')}</legend>
          <ul class="cr-kept">
            {#each kept as part (part)}
              <li><Icon icon={mdiCheck} size="14" aria-hidden={true} /> {$t(`frameleaf_creators_kept_${part}`)}</li>
            {/each}
          </ul>
        </fieldset>
        {#if !needsCollection}
          <label class="cr-switch">
            <input type="checkbox" role="switch" bind:checked={followToo} disabled={busy} />
            <span>
              {$t('frameleaf_creators_follow_too', { values: { name } })}
              <small>{$t('frameleaf_creators_follow_too_hint')}</small>
            </span>
          </label>
        {/if}
      </div>
      {#if followToo}
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
      {/if}
      {@render collectionChoice()}
      {#if error}<InlineError compact message={$t(error)} />{/if}
      <footer>
        <small>
          {followToo && !reach
            ? $t('frameleaf_creators_follow_choose')
            : $t('frameleaf_creators_download_hint', { values: { name } })}
        </small>
        <Button
          variant="primary"
          disabled={!ready ||
            busy ||
            items.length === 0 ||
            (followToo && !reachValue) ||
            (needsCollection && !collectionId)}
          onclick={() => void download()}
        >
          <Icon icon={mdiDownloadOutline} size="18" aria-hidden={true} />{$t('frameleaf_creators_download')}
        </Button>
      </footer>
    </section>
  {/if}
</div>
