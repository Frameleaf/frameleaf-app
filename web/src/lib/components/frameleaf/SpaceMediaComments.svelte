<script lang="ts">
  import SpaceCommentComposer from '$lib/components/frameleaf/SpaceCommentComposer.svelte';
  import Status from '$lib/components/frameleaf/Status.svelte';
  import UserAvatar from '$lib/components/shared-components/UserAvatar.svelte';
  import { splitMentions } from '$lib/frameleaf/shared-space';
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
  import { Icon } from '@immich/ui';
  import { mdiClose, mdiDeleteOutline, mdiPencilOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  /**
   * The conversation about one item in a shared space (FL-55), for the space's viewer side panel.
   *
   * Self-contained on purpose: given a space and an item it fetches the comments and the member
   * roster itself, so it can be mounted wherever the viewer is. Everything goes through the
   * shared space comment endpoints, which check membership, that the item is in the space and
   * visible to this member, and — for edit and delete — the author and moderation rules. The
   * `canEdit` and `canDelete` flags on each comment are the server's answer; this only offers the
   * controls it says are allowed. Mentions are `@{userId}` tokens rendered as names.
   */
  interface Props {
    spaceId: string;
    assetId: string;
    onClose?: () => void;
  }

  let { spaceId, assetId, onClose }: Props = $props();

  let comments = $state<SharedSpaceCommentResponseDto[]>([]);
  let members = $state<SharedSpaceMemberResponseDto[]>([]);
  let loading = $state(true);
  let failed = $state(false);
  let busy = $state(false);
  let status = $state('');
  let draft = $state('');
  let editingId = $state<string | null>(null);
  let editDraft = $state('');
  let list = $state<HTMLOListElement>();

  const currentUserId = $derived(authManager.user.id);
  const mentionUsers = $derived(members.map(({ user }) => user));

  const load = async (space: string, asset: string) => {
    loading = true;
    failed = false;
    try {
      const [{ comments: loaded }, { members: roster }] = await Promise.all([
        getSharedSpaceComments({ id: space, assetId: asset }),
        getSharedSpaceMembers({ id: space }),
      ]);
      comments = loaded;
      members = roster;
    } catch (error) {
      failed = true;
      handleError(error, $t('frameleaf_spaces_comments_error'));
    } finally {
      loading = false;
    }
  };

  // Moving the viewer to another item starts afresh: nothing said about one item shows on the next.
  $effect(() => {
    const space = spaceId;
    const asset = assetId;
    editingId = null;
    void load(space, asset);
  });

  // Newest comments sit at the bottom, as in a conversation, so the list follows them.
  $effect(() => {
    void comments.length;
    if (list) {
      list.scrollTop = list.scrollHeight;
    }
  });

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

  const startEdit = (comment: SharedSpaceCommentResponseDto) => {
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
    busy = true;
    try {
      await deleteSharedSpaceComment({ id: spaceId, commentId: comment.id });
      comments = comments.filter(({ id }) => id !== comment.id);
      status = $t('frameleaf_spaces_comments_deleted');
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

<aside class="comments" aria-label={$t('frameleaf_spaces_comments_title')} aria-busy={loading}>
  <header>
    <h2>{$t('frameleaf_spaces_comments_title')}</h2>
    {#if onClose}
      <button type="button" class="icon" aria-label={$t('close')} onclick={onClose}>
        <Icon icon={mdiClose} size="18" aria-hidden={true} />
      </button>
    {/if}
  </header>

  {#if failed}
    <p class="muted">{$t('frameleaf_spaces_comments_error')}</p>
  {:else if !loading && comments.length === 0}
    <p class="muted">{$t('frameleaf_spaces_comments_empty')}</p>
  {:else}
    <ol bind:this={list}>
      {#each comments as comment (comment.id)}
        <li>
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
              {#if comment.canEdit || comment.canDelete}
                <div class="actions">
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
      placeholder={$t('frameleaf_spaces_comments_placeholder')}
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
  ol {
    flex: 1;
    margin: 0;
    padding: 0.75rem 1rem;
    list-style: none;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  li {
    display: flex;
    gap: 0.625rem;
    align-items: flex-start;
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
  .actions button:disabled {
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
