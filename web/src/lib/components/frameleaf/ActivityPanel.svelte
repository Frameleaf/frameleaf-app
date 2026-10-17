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
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
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

  /** ActivityPanel.jsx `likeLabel`: one like names who ("Jamie likes this"), more are counted. */
  const likeLabel = $derived.by(() => {
    if (likeCount === 0) {
      return $t('frameleaf_album_activity_no_likes');
    }
    if (likeCount === 1 && likers.length === 1) {
      const [only] = likers;
      return only.user.id === currentUserId
        ? $t('frameleaf_album_activity_you_like')
        : $t('frameleaf_album_activity_one_like', { values: { name: only.user.name } });
    }
    return $t('frameleaf_album_activity_like_count', { values: { count: likeCount } });
  });
  /** Who liked it is worth opening when there are several, or when the owner may remove a like. */
  const canOpenLikers = $derived(likers.length > 1 || (likers.length === 1 && isAlbumOwner));

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
  aria-label={$t('frameleaf_album_comments_title')}
  onkeydown={(event) => {
    if (event.key !== 'Escape') {
      return;
    }

    event.stopPropagation();
    onClose();
  }}
>
  <header>
    <h2>{$t('frameleaf_album_comments_title')}</h2>
    <button type="button" aria-label={$t('frameleaf_album_comments_close')} onclick={onClose}>
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
    {#if canOpenLikers}
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
      <span class="avatar" aria-hidden="true"><UserAvatar user={authManager.user} size="sm" noTitle /></span>
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
  /* collections.css `.activity-panel` (SHARING-P2): a 320px sheet in bands, head, likes, list, comment box. */
  .activity {
    display: flex;
    flex-direction: column;
    inline-size: 320px;
    max-inline-size: 100vw;
    block-size: 100%;
    min-block-size: 0;
    color: var(--fl-text);
    background: var(--fl-panel);
    border-inline-start: 1px solid var(--fl-border);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--fl-space-3);
    padding: var(--fl-space-2) var(--fl-space-3) var(--fl-space-2) var(--fl-space-4);
    border-block-end: 1px solid var(--fl-border);
  }
  h2 {
    margin: 0;
    font-size: var(--fl-font-size);
    font-weight: 600;
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
    border-radius: var(--fl-radius-control);
  }
  header button:hover {
    background: var(--fl-raised);
  }
  .likes {
    display: flex;
    align-items: center;
    gap: var(--fl-space-3);
    padding: var(--fl-space-2) var(--fl-space-4);
    border-block-end: 1px solid var(--fl-border);
  }
  .like {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0 var(--fl-space-3) 0 9px;
    min-height: 44px;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-pill);
    font: inherit;
    font-size: var(--fl-font-callout);
  }
  .like.on {
    color: var(--fl-danger);
    border-color: var(--fl-danger);
  }
  .like:disabled {
    color: var(--fl-muted);
    background: var(--fl-canvas);
  }
  .count {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
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
    margin: var(--fl-space-2) var(--fl-space-4) 0;
    padding: 0.375rem;
    list-style: none;
    max-height: 10rem;
    overflow-y: auto;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
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
    gap: var(--fl-space-3);
    margin: 0;
    padding: 18px var(--fl-space-4);
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
    line-height: 1.5;
  }
  .list {
    flex: 1;
    min-block-size: 0;
    overflow-y: auto;
    list-style: none;
    margin: 0;
    padding: var(--fl-space-3) var(--fl-space-4);
    display: flex;
    flex-direction: column;
    gap: var(--fl-space-3);
  }
  .empty {
    padding: var(--fl-space-6) 0;
    text-align: center;
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
  }
  .item {
    display: flex;
    gap: 10px;
    align-items: flex-start;
  }
  .avatar {
    display: inline-flex;
    flex-shrink: 0;
  }
  .bubble {
    flex: 1;
    min-inline-size: 0;
    padding: var(--fl-space-2) 10px;
    background: var(--fl-raised);
    border-radius: var(--fl-radius-card);
  }
  .item.own .bubble {
    background: color-mix(in srgb, var(--fl-teal), transparent 84%);
  }
  .meta {
    display: flex;
    align-items: center;
    gap: var(--fl-space-2);
    font-size: var(--fl-font-micro);
    color: var(--fl-muted);
  }
  .meta strong {
    color: var(--fl-text);
    font-size: var(--fl-font-small);
  }
  /* `.ap-delete`: a 24px glyph button whose 44px target (48px on touch) is an invisible box around it. */
  .delete {
    position: relative;
    margin-inline-start: auto;
    display: grid;
    place-items: center;
    inline-size: 24px;
    block-size: 24px;
    min-height: 0;
    min-width: 0;
    padding: 0;
    color: var(--fl-muted);
    background: transparent;
    border: 0;
    border-radius: var(--fl-radius-xs);
  }
  .delete::after {
    content: '';
    position: absolute;
    inset: -10px;
  }
  .delete:hover {
    color: var(--fl-danger);
    background: var(--fl-panel);
  }
  @media (pointer: coarse) {
    .delete {
      min-height: 0;
      min-width: 0;
    }
    .delete::after {
      inset: -12px;
    }
  }
  .bubble p {
    margin: var(--fl-space-1) 0 0;
    font-size: var(--fl-font-callout);
    line-height: 1.45;
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
    border-radius: var(--fl-radius-control);
  }
  .subject img {
    inline-size: 100%;
    block-size: 100%;
    object-fit: cover;
  }
  /* `.ap-composer`: one line that grows with the text, up to five lines, with the send button beside it. */
  .composer {
    display: flex;
    align-items: flex-end;
    gap: var(--fl-space-2);
    padding: 10px var(--fl-space-3) var(--fl-space-3);
    border-block-start: 1px solid var(--fl-border);
  }
  .composer .avatar {
    align-self: center;
  }
  .composer textarea {
    flex: 1;
    min-inline-size: 0;
    min-block-size: 44px;
    max-block-size: 120px;
    field-sizing: content;
    resize: none;
    padding: 11px var(--fl-space-3);
    font: inherit;
    font-size: var(--fl-font-callout);
    line-height: 1.4;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
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
    border-radius: var(--fl-radius-control);
  }
  .send:disabled {
    color: var(--fl-muted);
    background: var(--fl-canvas);
    border-color: var(--fl-border);
  }
  .note {
    margin: 0;
    padding: 0 var(--fl-space-4) var(--fl-space-2);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  /* Kept in the page for the announcement, without a band of its own while there is nothing to say. */
  .note:empty {
    padding: 0;
  }
</style>
