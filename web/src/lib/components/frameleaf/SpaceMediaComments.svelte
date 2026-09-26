<script lang="ts">
  import SpaceCommentComposer from '$lib/components/frameleaf/SpaceCommentComposer.svelte';
  import Status from '$lib/components/frameleaf/Status.svelte';
  import UserAvatar from '$lib/components/shared-components/UserAvatar.svelte';
  import {
    groupCommentThreads,
    replyPrefill,
    splitMentions,
    threadRootId,
    withoutComment,
    withReply,
  } from '$lib/frameleaf/shared-space';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { handleError } from '$lib/utils/handle-error';
  import {
    createSharedSpaceComment,
    deleteSharedSpaceComment,
    getSharedSpaceComments,
    getSharedSpaceMembers,
    updateSharedSpaceComment,
    type SharedSpaceCommentResponseDto,
    type SharedSpaceMemberResponseDto,
  } from '@immich/sdk';
  import { Icon, modalManager } from '@immich/ui';
  import {
    mdiChevronDown,
    mdiChevronUp,
    mdiClose,
    mdiDeleteOutline,
    mdiHeart,
    mdiHeartOutline,
    mdiPencilOutline,
    mdiReply,
  } from '@mdi/js';
  import { t } from 'svelte-i18n';

  /**
   * The conversation in a shared space (FL-55): about one item, for the viewer's side panel, or
   * about the space itself when no item is given, for the album view of a space.
   *
   * Self-contained on purpose: given a space (and an item) it fetches the comments and the member
   * roster itself, so it can be mounted wherever it is needed. Everything goes through the shared
   * space comment endpoints, which check membership, that the item is in the space and visible to
   * this member, and — for edit and delete — the author and moderation rules. The `canEdit` and
   * `canDelete` flags on each comment are the server's answer; this only offers the controls it
   * says are allowed. Mentions are `@{userId}` tokens rendered as names.
   *
   * Threads are one level deep. Replies sit folded under their comment behind "View N replies".
   * Replying to a reply stays in the same thread and starts with an @mention of the person
   * answered. Threads are ordered by their latest activity, newest next to the composer.
   * Removing a comment that has replies removes them too, after asking.
   */
  interface Props {
    spaceId: string;
    /** The item the conversation is about. Left out, the conversation is about the space itself. */
    assetId?: string;
    /** False when the owner has turned comments off; what is there stays readable. */
    canComment?: boolean;
    /**
     * Likes on the same thing, when the host has them to offer (the album view of a space likes the
     * space itself; the viewer keeps its own like button in its top bar).
     */
    likes?: { count: number; liked: boolean; onToggle: () => void | Promise<void> };
    /** Closes the panel; Escape inside the panel does the same. */
    onClose?: () => void;
  }

  let { spaceId, assetId, canComment = true, likes, onClose }: Props = $props();

  let comments = $state<SharedSpaceCommentResponseDto[]>([]);
  let members = $state<SharedSpaceMemberResponseDto[]>([]);
  let loading = $state(true);
  let failed = $state(false);
  let busy = $state(false);
  let status = $state('');
  let draft = $state('');
  let editingId = $state<string | null>(null);
  let editDraft = $state('');
  let replyingTo = $state<SharedSpaceCommentResponseDto | null>(null);
  let replyDraft = $state('');
  let expanded = $state<ReadonlySet<string>>(new Set());
  let list = $state<HTMLOListElement>();

  const currentUserId = $derived(authManager.user.id);
  const mentionUsers = $derived(members.map(({ user }) => user));
  const threads = $derived(groupCommentThreads(comments));
  const listId = `frameleaf-comments-${Math.random().toString(36).slice(2, 8)}`;

  // Only the latest request may fill the list, so paging quickly through the viewer never shows
  // one item's comments on another.
  let latestLoad = 0;

  const load = async (space: string, asset: string | undefined) => {
    const request = ++latestLoad;
    loading = true;
    failed = false;
    try {
      const [{ comments: loaded }, { members: roster }] = await Promise.all([
        getSharedSpaceComments({ id: space, assetId: asset }),
        getSharedSpaceMembers({ id: space }),
      ]);
      if (request !== latestLoad) {
        return;
      }
      comments = loaded;
      members = roster;
    } catch (error) {
      if (request !== latestLoad) {
        return;
      }
      failed = true;
      handleError(error, $t('frameleaf_spaces_comments_error'));
    } finally {
      if (request === latestLoad) {
        loading = false;
      }
    }
  };

  // Moving the viewer to another item starts afresh: nothing said about one item shows on the next.
  $effect(() => {
    const space = spaceId;
    const asset = assetId;
    comments = [];
    editingId = null;
    replyingTo = null;
    replyDraft = '';
    expanded = new Set();
    void load(space, asset);
  });

  // The newest activity sits at the bottom, as in a conversation, so the list follows it.
  $effect(() => {
    void comments.length;
    if (list) {
      list.scrollTop = list.scrollHeight;
    }
  });

  const setExpanded = (rootId: string, open: boolean) => {
    const next = new Set(expanded);
    if (open) {
      next.add(rootId);
    } else {
      next.delete(rootId);
    }
    expanded = next;
  };

  const post = async (text: string) => {
    busy = true;
    try {
      const created = await createSharedSpaceComment({
        id: spaceId,
        sharedSpaceCommentCreateDto: { assetId, comment: text },
      });
      comments = [...comments, created];
      draft = '';
      status = $t('frameleaf_spaces_comments_posted');
    } catch (error) {
      handleError(error, $t('frameleaf_spaces_comments_error_send'));
    } finally {
      busy = false;
    }
  };

  const startReply = (comment: SharedSpaceCommentResponseDto) => {
    editingId = null;
    replyingTo = comment;
    replyDraft = replyPrefill(comment, currentUserId, members);
    setExpanded(threadRootId(comment), true);
  };

  const cancelReply = () => {
    replyingTo = null;
    replyDraft = '';
  };

  const postReply = async (text: string) => {
    const target = replyingTo;
    if (!target) {
      return;
    }
    busy = true;
    try {
      // The server files a reply to a reply under the thread's top-level comment.
      const created = await createSharedSpaceComment({
        id: spaceId,
        sharedSpaceCommentCreateDto: { assetId, comment: text, parentId: target.id },
      });
      comments = withReply(comments, created);
      setExpanded(threadRootId(created), true);
      cancelReply();
      status = $t('frameleaf_spaces_comments_reply_posted');
    } catch (error) {
      handleError(error, $t('frameleaf_spaces_comments_error_send'));
    } finally {
      busy = false;
    }
  };

  const startEdit = (comment: SharedSpaceCommentResponseDto) => {
    cancelReply();
    editingId = comment.id;
    editDraft = comment.comment;
  };

  const saveEdit = async (text: string) => {
    if (!editingId) {
      return;
    }
    busy = true;
    try {
      const updated = await updateSharedSpaceComment({
        id: spaceId,
        commentId: editingId,
        sharedSpaceCommentUpdateDto: { comment: text },
      });
      comments = comments.map((comment) => (comment.id === updated.id ? updated : comment));
      editingId = null;
      status = $t('frameleaf_spaces_comments_saved');
    } catch (error) {
      handleError(error, $t('frameleaf_spaces_comments_error_send'));
    } finally {
      busy = false;
    }
  };

  const remove = async (comment: SharedSpaceCommentResponseDto) => {
    const replyCount = comment.parentId ? 0 : comments.filter(({ parentId }) => parentId === comment.id).length;
    if (replyCount > 0) {
      const confirmed = await modalManager.showDialog({
        prompt: $t('frameleaf_spaces_comments_delete_thread_confirm', { values: { count: replyCount } }),
      });
      if (!confirmed) {
        return;
      }
    }

    busy = true;
    try {
      await deleteSharedSpaceComment({ id: spaceId, commentId: comment.id });
      comments = withoutComment(comments, comment);
      const gone = (id: string | undefined | null) => id === comment.id;
      if (replyingTo && (gone(replyingTo.id) || (!comment.parentId && gone(replyingTo.parentId)))) {
        cancelReply();
      }
      if (editingId && comments.every(({ id }) => id !== editingId)) {
        editingId = null;
      }
      status =
        replyCount > 0
          ? $t('frameleaf_spaces_comments_deleted_thread', { values: { count: replyCount } })
          : $t('frameleaf_spaces_comments_deleted');
    } catch (error) {
      handleError(error, $t('errors.unable_to_remove_reaction'));
    } finally {
      busy = false;
    }
  };

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

  const wasEdited = (comment: SharedSpaceCommentResponseDto) => comment.updatedAt !== comment.createdAt;
</script>

{#snippet entry(comment: SharedSpaceCommentResponseDto)}
  <div class="entry">
    <UserAvatar user={comment.user} size="sm" noTitle />
    <div class="body">
      <p class="meta">
        <strong>{comment.user.name}</strong>
        <time datetime={comment.createdAt} title={new Date(comment.createdAt).toLocaleString($locale)}>
          {timeAgo(comment.createdAt)}
        </time>
        {#if wasEdited(comment)}
          <span class="edited">{$t('frameleaf_spaces_comments_edited')}</span>
        {/if}
      </p>
      {#if editingId === comment.id}
        <SpaceCommentComposer
          {members}
          {currentUserId}
          bind:value={editDraft}
          {busy}
          submitLabel={$t('save')}
          autofocus
          onSubmit={saveEdit}
          onCancel={() => (editingId = null)}
        />
      {:else}
        <p class="text">
          {#each splitMentions(comment.comment, [...mentionUsers, ...comment.mentions]) as segment, index (index)}
            {#if segment.kind === 'mention'}
              <span class="mention">@{segment.user?.name ?? $t('frameleaf_spaces_comments_unknown_member')}</span>
            {:else}
              {segment.text}
            {/if}
          {/each}
        </p>
        {#if canComment || comment.canEdit || comment.canDelete}
          <div class="actions">
            {#if canComment}
              <button
                type="button"
                disabled={busy}
                aria-label={$t('frameleaf_spaces_comments_reply_to', { values: { name: comment.user.name } })}
                onclick={() => startReply(comment)}
              >
                <Icon icon={mdiReply} size="14" aria-hidden={true} />
                {$t('frameleaf_spaces_comments_reply')}
              </button>
            {/if}
            {#if comment.canEdit}
              <button type="button" disabled={busy} onclick={() => startEdit(comment)}>
                <Icon icon={mdiPencilOutline} size="14" aria-hidden={true} />
                {$t('frameleaf_spaces_comments_edit')}
              </button>
            {/if}
            {#if comment.canDelete}
              <button type="button" class="danger" disabled={busy} onclick={() => remove(comment)}>
                <Icon icon={mdiDeleteOutline} size="14" aria-hidden={true} />
                {$t('frameleaf_spaces_comments_delete')}
              </button>
            {/if}
          </div>
        {/if}
      {/if}
    </div>
  </div>
{/snippet}

<!-- svelte-ignore a11y_no_noninteractive_element_interactions (Escape from any control inside closes the panel) -->
<aside
  class="comments"
  aria-label={$t('frameleaf_spaces_comments_title')}
  aria-busy={loading}
  onkeydown={(event) => {
    // A composer that is replying or editing handles Escape itself first.
    if (!(event.key === 'Escape' && onClose)) {
      return;
    }

    event.stopPropagation();
    onClose();
  }}
>
  <header>
    <h2>{$t('frameleaf_spaces_comments_title')}</h2>
    {#if onClose}
      <button type="button" class="icon" aria-label={$t('close')} onclick={onClose}>
        <Icon icon={mdiClose} size="18" aria-hidden={true} />
      </button>
    {/if}
  </header>

  {#if likes}
    <div class="likes">
      <button
        type="button"
        class="like"
        class:on={likes.liked}
        aria-pressed={likes.liked}
        disabled={!canComment}
        onclick={() => void likes?.onToggle()}
      >
        <Icon icon={likes.liked ? mdiHeart : mdiHeartOutline} size="18" aria-hidden={true} />
        <span>{likes.liked ? $t('frameleaf_album_activity_liked_label') : $t('frameleaf_album_activity_like')}</span>
      </button>
      <span class="count">
        {likes.count === 0
          ? $t('frameleaf_album_activity_no_likes')
          : $t('frameleaf_album_activity_like_count', { values: { count: likes.count } })}
      </span>
    </div>
  {/if}

  {#if failed}
    <p class="muted">{$t('frameleaf_spaces_comments_error')}</p>
  {:else if !loading && comments.length === 0}
    <p class="muted">
      {assetId ? $t('frameleaf_spaces_comments_empty') : $t('frameleaf_spaces_comments_empty_space')}
    </p>
  {:else}
    <ol class="threads" bind:this={list}>
      {#each threads as thread (thread.comment.id)}
        {@const rootId = thread.comment.id}
        {@const open = expanded.has(rootId)}
        {@const repliesId = `${listId}-${rootId}`}
        <li class="thread">
          {@render entry(thread.comment)}

          {#if thread.replies.length > 0}
            <button
              type="button"
              class="toggle"
              aria-expanded={open}
              aria-controls={open ? repliesId : undefined}
              onclick={() => setExpanded(rootId, !open)}
            >
              <Icon icon={open ? mdiChevronUp : mdiChevronDown} size="16" aria-hidden={true} />
              {open
                ? $t('frameleaf_spaces_comments_hide_replies')
                : $t('frameleaf_spaces_comments_view_replies', { values: { count: thread.replies.length } })}
            </button>
          {/if}

          {#if open && thread.replies.length > 0}
            <ol
              class="replies"
              id={repliesId}
              aria-label={$t('frameleaf_spaces_comments_replies_to', { values: { name: thread.comment.user.name } })}
            >
              {#each thread.replies as reply (reply.id)}
                <li>{@render entry(reply)}</li>
              {/each}
            </ol>
          {/if}

          {#if replyingTo && threadRootId(replyingTo) === rootId}
            <div class="reply-box">
              <p class="replying">
                {$t('frameleaf_spaces_comments_replying_to', { values: { name: replyingTo.user.name } })}
              </p>
              <!-- Re-created for each comment answered, so focus and the caret follow a new @mention. -->
              {#key replyingTo.id}
                <SpaceCommentComposer
                  {members}
                  {currentUserId}
                  bind:value={replyDraft}
                  {busy}
                  placeholder={$t('frameleaf_spaces_comments_reply_placeholder')}
                  submitLabel={$t('frameleaf_spaces_comments_reply_send')}
                  autofocus
                  onSubmit={postReply}
                  onCancel={cancelReply}
                />
              {/key}
            </div>
          {/if}
        </li>
      {/each}
    </ol>
  {/if}

  <Status message={status} {busy} />

  <footer>
    <SpaceCommentComposer
      {members}
      {currentUserId}
      bind:value={draft}
      {busy}
      disabled={!canComment}
      placeholder={canComment ? $t('frameleaf_spaces_comments_placeholder') : $t('comments_are_disabled')}
      onSubmit={post}
    />
  </footer>
</aside>

<style>
  .comments {
    display: flex;
    flex-direction: column;
    block-size: 100%;
    min-block-size: 0;
    background: var(--fl-panel);
    color: var(--fl-text);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1rem;
    border-block-end: 1px solid var(--fl-border);
  }
  h2 {
    margin: 0;
    font-size: 1rem;
    font-weight: 700;
  }
  .icon {
    display: inline-flex;
    padding: 0.375rem;
    border: 0;
    border-radius: 999px;
    background: transparent;
    color: var(--fl-text);
  }
  .likes {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 1rem;
    border-block-end: 1px solid var(--fl-border);
  }
  .like {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0 0.75rem;
    min-height: 36px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    background: var(--fl-raised);
    color: var(--fl-text);
    font-size: 0.8125rem;
    font-weight: 600;
  }
  .like.on {
    border-color: var(--fl-accent);
    color: var(--fl-accent);
  }
  .like:disabled {
    opacity: 0.6;
  }
  .likes .count {
    color: var(--fl-muted);
    font-size: 0.8125rem;
  }
  ol {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .threads {
    flex: 1;
    padding: 0.75rem 1rem;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
  }
  .thread {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }
  .entry {
    display: flex;
    gap: 0.625rem;
    align-items: flex-start;
  }
  .replies,
  .toggle,
  .reply-box {
    margin-inline-start: 2.5rem;
  }
  .replies {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    padding-inline-start: 0.75rem;
    border-inline-start: 2px solid var(--fl-border);
  }
  .toggle {
    align-self: flex-start;
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.125rem 0.375rem;
    border: 0;
    border-radius: var(--fl-radius);
    background: transparent;
    color: var(--fl-accent);
    font-size: 0.75rem;
    font-weight: 600;
  }
  .reply-box {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .replying {
    margin: 0;
    color: var(--fl-muted);
    font-size: 0.75rem;
  }
  .body {
    flex: 1;
    min-inline-size: 0;
  }
  .meta {
    margin: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
    align-items: baseline;
    font-size: 0.8125rem;
  }
  .meta time,
  .edited {
    color: var(--fl-muted);
    font-size: 0.75rem;
  }
  .text {
    margin: 0.125rem 0 0;
    font-size: 0.875rem;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .mention {
    color: var(--fl-accent);
    font-weight: 600;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    margin-block-start: 0.25rem;
  }
  .actions button {
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
  .actions button.danger {
    color: var(--fl-danger, #c0392b);
  }
  .actions button:disabled,
  .toggle:disabled {
    opacity: 0.6;
  }
  .muted {
    flex: 1;
    margin: 0;
    padding: 1rem;
    color: var(--fl-muted);
    font-size: 0.875rem;
  }
  footer {
    padding: 0.75rem 1rem;
    border-block-start: 1px solid var(--fl-border);
  }
</style>
