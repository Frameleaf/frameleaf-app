<script lang="ts">
  import UserAvatar from '$lib/components/shared-components/UserAvatar.svelte';
  import { activityManager } from '$lib/managers/activity-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { getAssetMediaUrl } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import {
    AlbumUserRole,
    AssetMediaSize,
    ReactionType,
    type ActivityResponseDto,
    type AlbumResponseDto,
  } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import {
    mdiArrowUp,
    mdiChevronDown,
    mdiChevronUp,
    mdiClose,
    mdiCommentOutline,
    mdiDeleteOutline,
    mdiHeart,
    mdiHeartOutline,
  } from '@mdi/js';
  import { t } from 'svelte-i18n';

  /**
   * Likes and comments for an album, a collection or a shared space (FL-53), ported from
   * `design/frameleaf/template/src/ActivityPanel.jsx`.
   *
   * Everything is the existing activity API, through the production `activityManager`:
   * `GET /activities`, `GET /activities/statistics`, `POST /activities` and
   * `DELETE /activities/{id}`. The panel never keeps its own list. Liking and commenting are
   * disabled — and said to be disabled — when the owner has turned activity off under
   * Options; existing entries stay readable, as the source behaviour does. A comment may be
   * deleted by its author and by the album owner, which is what the server allows.
   */
  interface Props {
    album: AlbumResponseDto;
    onClose: () => void;
    /**
     * FL-55: open the photo a comment is about. A shared space opens its own viewer; where this is
     * absent, a comment on a photo shows no picture to open.
     */
    onOpenAsset?: (assetId: string) => void;
    /**
     * One item's likes and comments in the viewer (AL-18). The caller has initialised
     * `activityManager` for this album and item, so the list and the like are the item's.
     */
    assetId?: string;
  }

  let { album, onClose, onOpenAsset, assetId }: Props = $props();

  let draft = $state('');
  let sending = $state(false);
  let note = $state('');
  let list = $state<HTMLOListElement>();
  let composer = $state<HTMLTextAreaElement>();

  const currentUserId = $derived(authManager.user.id);
  const isAlbumOwner = $derived(
    album.albumUsers.some(({ user, role }) => user.id === currentUserId && role === AlbumUserRole.Owner),
  );
  const enabled = $derived(album.isActivityEnabled);

  const comments = $derived(
    activityManager.activities
      .filter((entry) => entry.type === ReactionType.Comment)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  );
  const likeCount = $derived(activityManager.likeCount);
  /** Who liked this album, or this item in the viewer: the likes at this panel's level only. */
  const likers = $derived(
    activityManager.activities.filter(
      (entry) => entry.type === ReactionType.Like && (assetId ? entry.assetId === assetId : !entry.assetId),
    ),
  );
  let likersOpen = $state(false);
  const liked = $derived(!!activityManager.isLiked);

  const likeLabel = $derived(
    likeCount === 0
      ? $t('frameleaf_album_activity_no_likes')
      : $t('frameleaf_album_activity_like_count', { values: { count: likeCount } }),
  );

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

  // Newest comments sit at the bottom, as in a conversation, so the list follows them.
  $effect(() => {
    void comments.length;
    if (list) {
      list.scrollTop = list.scrollHeight;
    }
  });

  const toggleLike = async () => {
    try {
      await activityManager.toggleLike();
      note = liked ? $t('frameleaf_album_activity_liked') : $t('frameleaf_album_activity_unliked');
    } catch (error) {
      handleError(error, $t('errors.cant_change_asset_favorite'));
    }
  };

  const send = async () => {
    const comment = draft.trim();
    if (!comment || !enabled || sending) {
      return;
    }
    sending = true;
    try {
      await activityManager.addActivity({ albumId: album.id, assetId, type: ReactionType.Comment, comment });
      draft = '';
      note = $t('frameleaf_album_activity_comment_added');
      composer?.focus();
    } catch (error) {
      handleError(error, $t('errors.unable_to_add_comment'));
    } finally {
      sending = false;
    }
  };

  const remove = async (activity: ActivityResponseDto) => {
    try {
      await activityManager.deleteActivity(activity);
      note =
        activity.type === ReactionType.Like
          ? $t('frameleaf_album_activity_unliked')
          : $t('frameleaf_album_activity_comment_deleted');
    } catch (error) {
      handleError(error, $t('errors.unable_to_remove_reaction'));
    }
  };
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions (Escape from any control inside closes the panel) -->
<aside
  class="activity"
  aria-label={$t('frameleaf_album_activity_title')}
  onkeydown={(event) => {
    if (event.key !== 'Escape') {
      return;
    }

    event.stopPropagation();
    onClose();
  }}
>
  <header>
    <h2>{$t('frameleaf_album_activity_title')}</h2>
    <button type="button" aria-label={$t('frameleaf_album_activity_close')} onclick={onClose}>
      <Icon icon={mdiClose} size="18" />
    </button>
  </header>

  <div class="likes">
    <button
      type="button"
      class="like"
      class:on={liked}
      aria-pressed={liked}
      disabled={!enabled}
      onclick={() => void toggleLike()}
    >
      <Icon icon={liked ? mdiHeart : mdiHeartOutline} size="18" />
      <span>{liked ? $t('frameleaf_album_activity_liked_label') : $t('frameleaf_album_activity_like')}</span>
    </button>
    {#if likers.length > 0}
      <button
        type="button"
        class="count likers-toggle"
        aria-expanded={likersOpen}
        aria-controls="activity-likers"
        onclick={() => (likersOpen = !likersOpen)}
      >
        {likeLabel}
        <Icon icon={likersOpen ? mdiChevronUp : mdiChevronDown} size="16" />
      </button>
    {:else}
      <span class="count">{likeLabel}</span>
    {/if}
  </div>

  {#if likersOpen && likers.length > 0}
    <!-- Who liked it, as the legacy activity list showed; the owner may remove someone's like. -->
    <ul id="activity-likers" class="likers" aria-label={$t('frameleaf_album_activity_likers')}>
      {#each likers as entry (entry.id)}
        {@const own = entry.user.id === currentUserId}
        <li>
          <span class="avatar" aria-hidden="true"><UserAvatar user={entry.user} size="sm" /></span>
          <span class="liker-name">{own ? $t('frameleaf_album_you') : entry.user.name}</span>
          {#if own || isAlbumOwner}
            <button
              type="button"
              class="delete"
              aria-label={own
                ? $t('frameleaf_album_activity_delete_own_like')
                : $t('frameleaf_album_activity_delete_like', { values: { name: entry.user.name } })}
              title={own
                ? $t('frameleaf_album_activity_delete_own_like')
                : $t('frameleaf_album_activity_delete_like', { values: { name: entry.user.name } })}
              onclick={() => void remove(entry)}
            >
              <Icon icon={mdiDeleteOutline} size="16" />
            </button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if !enabled}
    <p class="off">
      <span aria-hidden="true"><Icon icon={mdiCommentOutline} size="18" /></span>
      {$t('frameleaf_album_activity_disabled')}
    </p>
  {/if}

  <ol bind:this={list} class="list" aria-label={$t('frameleaf_album_activity_comments')}>
    {#if comments.length === 0}
      <li class="empty">{$t('frameleaf_album_activity_empty')}</li>
    {/if}
    {#each comments as entry (entry.id)}
      {@const own = entry.user.id === currentUserId}
      <li class="item" class:own>
        <span class="avatar" aria-hidden="true"><UserAvatar user={entry.user} size="sm" /></span>
        <div class="bubble">
          <div class="meta">
            <strong>{own ? $t('frameleaf_album_you') : entry.user.name}</strong>
            <time datetime={entry.createdAt}>{timeAgo(entry.createdAt)}</time>
            {#if own || isAlbumOwner}
              <button
                type="button"
                class="delete"
                aria-label={own
                  ? $t('frameleaf_album_activity_delete_comment')
                  : $t('frameleaf_album_activity_delete_comment_by', { values: { name: entry.user.name } })}
                onclick={() => void remove(entry)}
              >
                <Icon icon={mdiDeleteOutline} size="16" />
              </button>
            {/if}
          </div>
          <p>{entry.comment}</p>
          {#if onOpenAsset && entry.assetId}
            {@const assetId = entry.assetId}
            <button
              type="button"
              class="subject"
              aria-label={$t('frameleaf_spaces_viewer_open_comment_photo')}
              title={$t('frameleaf_spaces_viewer_open_comment_photo')}
              onclick={() => onOpenAsset?.(assetId)}
            >
              <img
                src={getAssetMediaUrl({ id: assetId, size: AssetMediaSize.Thumbnail })}
                alt=""
                loading="lazy"
                draggable="false"
              />
            </button>
          {/if}
        </div>
      </li>
    {/each}
  </ol>

  {#if enabled}
    <form
      class="composer"
      onsubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <textarea
        bind:this={composer}
        bind:value={draft}
        rows="1"
        maxlength="2000"
        placeholder={$t('frameleaf_album_activity_write')}
        aria-label={$t('frameleaf_album_activity_write')}
        onkeydown={(event) => {
          if (event.key !== 'Enter' || event.shiftKey) {
            return;
          }

          event.preventDefault();
          void send();
        }}></textarea>
      <button
        type="submit"
        class="send"
        aria-label={$t('frameleaf_album_activity_send')}
        disabled={sending || !draft.trim()}
      >
        <Icon icon={mdiArrowUp} size="18" />
      </button>
    </form>
  {/if}

  <p class="note" role="status" aria-live="polite">{note}</p>
</aside>

<style>
  .activity {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    inline-size: min(22rem, 100vw);
    block-size: 100%;
    padding: 0.875rem;
    color: var(--fl-text);
    background: var(--fl-panel);
    border-inline-start: 1px solid var(--fl-border);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  h2 {
    margin: 0;
    font-size: 1rem;
  }
  header button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 44px;
    min-height: 44px;
    color: var(--fl-text);
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--fl-radius);
  }
  header button:hover {
    background: var(--fl-raised);
  }
  .likes {
    display: flex;
    align-items: center;
    gap: 0.625rem;
  }
  .like {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0 0.75rem;
    min-height: 44px;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    font: inherit;
  }
  .like.on {
    color: var(--fl-accent);
    border-color: var(--fl-accent);
  }
  .like:disabled {
    color: var(--fl-muted);
    background: var(--fl-canvas);
  }
  .count {
    color: var(--fl-muted);
    font-size: 0.875rem;
  }
  .likers-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    min-height: 44px;
    padding: 0 0.25rem;
    border: 0;
    background: none;
    cursor: pointer;
  }
  .likers {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    margin: 0;
    padding: 0.375rem;
    list-style: none;
    max-height: 10rem;
    overflow-y: auto;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    background: var(--fl-raised);
  }
  .likers li {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.875rem;
  }
  .liker-name {
    flex: 1;
    min-width: 0;
  }
  .off {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    margin: 0;
    padding: 0.625rem;
    color: var(--fl-muted);
    background: var(--fl-raised);
    border-radius: var(--fl-radius);
    font-size: 0.875rem;
  }
  .list {
    flex: 1;
    min-block-size: 0;
    overflow-y: auto;
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
  }
  .empty {
    color: var(--fl-muted);
    font-size: 0.875rem;
  }
  .item {
    display: flex;
    gap: 0.5rem;
    align-items: flex-start;
  }
  .avatar {
    display: inline-flex;
    flex-shrink: 0;
  }
  .bubble {
    flex: 1;
    min-inline-size: 0;
    padding: 0.5rem 0.625rem;
    background: var(--fl-raised);
    border-radius: var(--fl-radius);
  }
  .item.own .bubble {
    background: var(--fl-accent-soft);
  }
  .meta {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.75rem;
    color: var(--fl-muted);
  }
  .meta strong {
    color: var(--fl-text);
  }
  .delete {
    margin-inline-start: auto;
    display: inline-flex;
    color: var(--fl-muted);
    background: transparent;
    border: 0;
  }
  .bubble p {
    margin: 0.25rem 0 0;
    font-size: 0.875rem;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }
  .subject {
    display: block;
    margin-block-start: 0.375rem;
    inline-size: 4.5rem;
    block-size: 4.5rem;
    padding: 0;
    overflow: hidden;
    background: var(--fl-canvas);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
  }
  .subject img {
    inline-size: 100%;
    block-size: 100%;
    object-fit: cover;
  }
  .composer {
    display: flex;
    align-items: flex-end;
    gap: 0.5rem;
  }
  .composer textarea {
    flex: 1;
    min-inline-size: 0;
    resize: vertical;
    padding: 0.5rem 0.625rem;
    font: inherit;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
  }
  .send {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 44px;
    min-height: 44px;
    color: var(--fl-accent-text);
    background: var(--fl-accent);
    border: 1px solid var(--fl-accent);
    border-radius: var(--fl-radius);
  }
  .send:disabled {
    color: var(--fl-muted);
    background: var(--fl-canvas);
    border-color: var(--fl-border);
  }
  .note {
    margin: 0;
    min-block-size: 1rem;
    color: var(--fl-muted);
    font-size: 0.75rem;
  }
</style>
