<script lang="ts">
  import SpaceCommentComposer from '$lib/components/frameleaf/SpaceCommentComposer.svelte';
  import Status from '$lib/components/frameleaf/Status.svelte';
  import UserAvatar from '$lib/components/shared-components/UserAvatar.svelte';
  import {
    canReplyToEvent,
    EVENT_THUMBNAILS,
    eventReplyPrefill,
    isNewSpaceEvent,
    spaceEventMessageKey,
    splitMentions,
  } from '$lib/frameleaf/shared-space';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { getAssetMediaUrl } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import {
    createSharedSpaceComment,
    getSharedSpaceActivity,
    markSharedSpaceVisited,
    type AlbumResponseDto,
    type SharedSpaceActivityResponseDto,
    type SharedSpaceEventResponseDto,
    type SharedSpaceMemberResponseDto,
  } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiCheckAll, mdiClose, mdiHistory, mdiReply } from '@mdi/js';
  import { t } from 'svelte-i18n';

  /**
   * What happened in a shared space, by everyone (FL-55).
   *
   * The feed is the server's durable record — items added and removed, albums and people linked,
   * members joining, leaving or changing role, comments and likes — already narrowed to this member:
   * an item they cannot see is never named, and an event with nothing left to show is not sent at
   * all. This only lays it out, newest first, marks what is new since this member last marked the
   * space seen, and offers the same explicit "mark as seen" the photos panel does, because opening
   * the panel is not the same as having read it.
   *
   * A comment on the space itself is written here, with @mentions; comments on an item belong to
   * that item's viewer. A picture in the feed opens the item in the space's own viewer.
   *
   * A comment or reply in the feed can be answered from here: the reply joins that comment's thread
   * (the server files it under the thread's top-level comment and on the same item), and answering
   * a reply starts with an @mention of its author.
   */
  interface Props {
    space: AlbumResponseDto;
    members?: SharedSpaceMemberResponseDto[];
    /** The loader's first page. Null means fetch it here. */
    feed?: SharedSpaceActivityResponseDto | null;
    onClose: () => void;
    /** Open an item an event is about, in the space's viewer. */
    onOpenAsset?: (assetId: string) => void;
    /** The server's answer after marking the space seen, so the page can update its badge. */
    onMarked?: (feed: SharedSpaceActivityResponseDto) => void;
  }

  let { space, members = [], feed = null, onClose, onOpenAsset, onMarked }: Props = $props();

  let events = $state<SharedSpaceEventResponseDto[]>([]);
  let hasMore = $state(false);
  let lastVisitedAt = $state<string | null>(null);
  let unreadCount = $state(0);
  let loading = $state(false);
  let failed = $state(false);
  let busy = $state(false);
  let status = $state('');
  let draft = $state('');
  let replyTarget = $state<SharedSpaceEventResponseDto | null>(null);

  const currentUserId = $derived(authManager.user.id);
  const mentionUsers = $derived(members.map(({ user }) => user));

  const apply = (next: SharedSpaceActivityResponseDto) => {
    events = next.events;
    hasMore = next.hasMore;
    lastVisitedAt = next.lastVisitedAt;
    unreadCount = next.unreadCount;
  };

  const refresh = async (spaceId: string) => {
    loading = true;
    failed = false;
    try {
      apply(await getSharedSpaceActivity({ id: spaceId }));
    } catch (error) {
      failed = true;
      handleError(error, $t('frameleaf_spaces_activity_error'));
    } finally {
      loading = false;
    }
  };

  // The loader's page when there is one; otherwise ask now.
  $effect(() => {
    if (feed) {
      apply(feed);
    } else {
      void refresh(space.id);
    }
  });

  const loadOlder = async () => {
    const oldest = events.at(-1);
    if (!oldest || loading) {
      return;
    }
    loading = true;
    try {
      const page = await getSharedSpaceActivity({ id: space.id, before: oldest.createdAt });
      events = [...events, ...page.events];
      hasMore = page.hasMore;
    } catch (error) {
      handleError(error, $t('frameleaf_spaces_activity_error'));
    } finally {
      loading = false;
    }
  };

  const markSeen = async () => {
    busy = true;
    try {
      await markSharedSpaceVisited({ id: space.id });
      const next = await getSharedSpaceActivity({ id: space.id });
      apply(next);
      onMarked?.(next);
      status = $t('frameleaf_spaces_new_marked');
    } catch (error) {
      handleError(error, $t('frameleaf_spaces_error_new'));
    } finally {
      busy = false;
    }
  };

  const startReply = (event: SharedSpaceEventResponseDto) => {
    replyTarget = event;
    draft = eventReplyPrefill(event, currentUserId, members);
  };

  const cancelReply = () => {
    replyTarget = null;
    draft = '';
  };

  const post = async (text: string) => {
    busy = true;
    const parentId = replyTarget?.activityId ?? undefined;
    try {
      await createSharedSpaceComment({
        id: space.id,
        sharedSpaceCommentCreateDto: parentId ? { comment: text, parentId } : { comment: text },
      });
      draft = '';
      replyTarget = null;
      status = parentId ? $t('frameleaf_spaces_comments_reply_posted') : $t('frameleaf_spaces_comments_posted');
      await refresh(space.id);
    } catch (error) {
      handleError(error, $t('frameleaf_spaces_comments_error_send'));
    } finally {
      busy = false;
    }
  };

  const someone = () => $t('frameleaf_spaces_activity_someone');
  const sentence = (event: SharedSpaceEventResponseDto) =>
    $t(spaceEventMessageKey(event), {
      values: {
        name: event.actor?.name ?? someone(),
        target: event.targetUser?.name ?? someone(),
        subject: event.subject ?? '',
        count: event.assetCount,
        role: $t(event.subject === 'editor' ? 'role_editor' : 'role_viewer'),
      },
    });

  const relative = $derived(new Intl.RelativeTimeFormat($locale, { numeric: 'auto' }));
  const UNITS: Intl.RelativeTimeFormatUnit[] = ['year', 'month', 'day', 'hour', 'minute'];
  const SECONDS: Record<string, number> = { year: 31_536_000, month: 2_592_000, day: 86_400, hour: 3600, minute: 60 };

  const timeAgo = (iso: string) => {
    const elapsed = (Date.now() - new Date(iso).getTime()) / 1000;
    for (const unit of UNITS) {
      const size = SECONDS[unit];
      if (Math.abs(elapsed) >= size) {
        return relative.format(-Math.trunc(elapsed / size), unit);
      }
    }
    return relative.format(-Math.trunc(elapsed), 'second');
  };
</script>

<section class="feed" aria-labelledby="frameleaf-space-activity" aria-busy={loading}>
  <header>
    <div>
      <h2 id="frameleaf-space-activity">{$t('frameleaf_spaces_activity_title')}</h2>
      <p class="hint">{$t('frameleaf_spaces_activity_hint')}</p>
    </div>
    <div class="head-actions">
      {#if unreadCount > 0}
        <button type="button" disabled={busy} onclick={markSeen}>
          <Icon icon={mdiCheckAll} size="16" aria-hidden={true} />
          {$t('frameleaf_spaces_new_mark_seen')}
        </button>
      {/if}
      <button type="button" class="icon" aria-label={$t('close')} onclick={onClose}>
        <Icon icon={mdiClose} size="18" aria-hidden={true} />
      </button>
    </div>
  </header>

  {#if unreadCount > 0}
    <p class="unread" role="status">{$t('frameleaf_spaces_activity_unread', { values: { count: unreadCount } })}</p>
  {/if}

  {#if failed}
    <p class="muted">{$t('frameleaf_spaces_activity_error')}</p>
  {:else if !loading && events.length === 0}
    <p class="muted">{$t('frameleaf_spaces_activity_empty')}</p>
  {:else}
    <ol>
      {#each events as event (event.id)}
        {@const fresh = isNewSpaceEvent(event, currentUserId, lastVisitedAt)}
        <li class:fresh>
          {#if event.actor}
            <UserAvatar user={event.actor} size="sm" noTitle />
          {:else}
            <span class="avatar-gap" aria-hidden="true"></span>
          {/if}
          <div class="body">
            <p class="line">
              {sentence(event)}
              {#if fresh}
                <span class="badge">{$t('frameleaf_spaces_activity_new')}</span>
              {/if}
            </p>
            {#if event.comment}
              <blockquote class="text">
                {#each splitMentions(event.comment, [...mentionUsers, ...event.mentions]) as segment, index (index)}
                  {#if segment.kind === 'mention'}
                    <span class="mention">@{segment.user?.name ?? $t('frameleaf_spaces_comments_unknown_member')}</span>
                  {:else}
                    {segment.text}
                  {/if}
                {/each}
              </blockquote>
            {/if}
            {#if event.assetIds.length > 0}
              <ul class="thumbs">
                {#each event.assetIds.slice(0, EVENT_THUMBNAILS) as assetId (assetId)}
                  <li>
                    <button
                      type="button"
                      aria-label={$t('frameleaf_spaces_activity_open_item')}
                      disabled={!onOpenAsset}
                      onclick={() => onOpenAsset?.(assetId)}
                    >
                      <img src={getAssetMediaUrl({ id: assetId })} alt="" loading="lazy" />
                    </button>
                  </li>
                {/each}
                {#if event.assetIds.length > EVENT_THUMBNAILS}
                  <li class="more">
                    {$t('frameleaf_spaces_activity_more_items', {
                      values: { count: event.assetIds.length - EVENT_THUMBNAILS },
                    })}
                  </li>
                {/if}
              </ul>
            {/if}
            <time datetime={event.createdAt} title={new Date(event.createdAt).toLocaleString($locale)}>
              {timeAgo(event.createdAt)}
            </time>
            {#if space.isActivityEnabled && canReplyToEvent(event)}
              <button
                type="button"
                class="reply"
                disabled={busy}
                aria-label={$t('frameleaf_spaces_comments_reply_to', {
                  values: { name: event.actor?.name ?? someone() },
                })}
                onclick={() => startReply(event)}
              >
                <Icon icon={mdiReply} size="14" aria-hidden={true} />
                {$t('frameleaf_spaces_comments_reply')}
              </button>
            {/if}
          </div>
        </li>
      {/each}
    </ol>
    {#if hasMore}
      <button type="button" class="older" disabled={loading} onclick={loadOlder}>
        <Icon icon={mdiHistory} size="16" aria-hidden={true} />
        {$t('frameleaf_spaces_activity_load_more')}
      </button>
    {/if}
  {/if}

  <Status message={status} {busy} />

  <footer>
    {#if replyTarget}
      <p class="replying">
        {$t('frameleaf_spaces_comments_replying_to', { values: { name: replyTarget.actor?.name ?? someone() } })}
      </p>
    {/if}
    <!-- Re-created when the reply target changes, so the box takes focus with the caret after any @mention. -->
    {#key replyTarget?.id}
      <SpaceCommentComposer
        {members}
        {currentUserId}
        bind:value={draft}
        {busy}
        disabled={!space.isActivityEnabled}
        placeholder={space.isActivityEnabled
          ? replyTarget
            ? $t('frameleaf_spaces_comments_reply_placeholder')
            : $t('frameleaf_spaces_comments_placeholder')
          : $t('comments_are_disabled')}
        submitLabel={replyTarget ? $t('frameleaf_spaces_comments_reply_send') : undefined}
        autofocus={!!replyTarget}
        onSubmit={post}
        onCancel={replyTarget ? cancelReply : undefined}
      />
    {/key}
  </footer>
</section>

<style>
  .feed {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    inline-size: min(48rem, 100%);
    padding: 1rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    background: var(--fl-raised);
    color: var(--fl-text);
  }
  header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.75rem;
  }
  h2 {
    margin: 0;
    font-size: 1rem;
    font-weight: 700;
  }
  .hint {
    margin: 0.125rem 0 0;
    color: var(--fl-muted);
    font-size: 0.8125rem;
  }
  .head-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .head-actions button,
  .older {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0 0.75rem;
    min-height: 36px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    background: var(--fl-panel);
    color: var(--fl-text);
    font-size: 0.75rem;
    font-weight: 600;
  }
  .head-actions .icon {
    padding: 0.375rem;
    border: 0;
    border-radius: 999px;
    background: transparent;
  }
  .older {
    align-self: center;
  }
  button:disabled {
    opacity: 0.6;
  }
  .unread {
    margin: 0;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--fl-accent);
    border-radius: var(--fl-radius);
    font-size: 0.8125rem;
    font-weight: 600;
  }
  ol {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  li {
    display: flex;
    gap: 0.625rem;
    align-items: flex-start;
  }
  .avatar-gap {
    inline-size: 2rem;
    block-size: 2rem;
    border-radius: 999px;
    background: var(--fl-border);
    flex: none;
  }
  .body {
    flex: 1;
    min-inline-size: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .line {
    margin: 0;
    font-size: 0.875rem;
  }
  .badge {
    display: inline-block;
    margin-inline-start: 0.375rem;
    padding: 0 0.375rem;
    border-radius: 999px;
    background: var(--fl-accent);
    color: var(--fl-accent-text);
    font-size: 0.6875rem;
    font-weight: 700;
    text-transform: uppercase;
    vertical-align: middle;
  }
  .text {
    margin: 0;
    padding: 0.375rem 0.625rem;
    border-inline-start: 3px solid var(--fl-border);
    background: var(--fl-panel);
    font-size: 0.875rem;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .mention {
    color: var(--fl-accent);
    font-weight: 600;
  }
  .thumbs {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.25rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .thumbs li {
    display: block;
  }
  .thumbs button {
    display: block;
    padding: 0;
    border: 0;
    border-radius: calc(var(--fl-radius) - 2px);
    overflow: hidden;
    background: var(--fl-border);
  }
  .thumbs img {
    display: block;
    inline-size: 4.5rem;
    block-size: 4.5rem;
    object-fit: cover;
  }
  .thumbs .more {
    padding-inline: 0.5rem;
    color: var(--fl-muted);
    font-size: 0.8125rem;
  }
  time {
    color: var(--fl-muted);
    font-size: 0.75rem;
  }
  .reply {
    align-self: flex-start;
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.125rem 0.375rem;
    border: 0;
    border-radius: var(--fl-radius);
    background: transparent;
    color: var(--fl-muted);
    font-size: 0.75rem;
  }
  .replying {
    margin: 0 0 0.25rem;
    color: var(--fl-muted);
    font-size: 0.75rem;
  }
  .muted {
    margin: 0;
    color: var(--fl-muted);
    font-size: 0.875rem;
  }
  footer {
    padding-block-start: 0.5rem;
    border-block-start: 1px solid var(--fl-border);
  }
</style>
