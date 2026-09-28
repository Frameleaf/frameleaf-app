<script lang="ts">
  /**
   * History and review for a Studio project (FL-89, `STU-202`).
   *
   * Two paged lists over the session's own calls: the revision history, newest first, with an
   * explicit "Restore" that appends a new revision rather than rewinding; and the review
   * comments pinned to exact timeline instants, which a reviewer without the lease may add and
   * the author or the owner may resolve. Both lists are rebuilt whenever the head revision
   * changes, so nothing cached for an earlier state survives a reload or a restore.
   */
  import { t } from 'svelte-i18n';
  import { toastManager } from '@immich/ui';
  import type { StudioCommentDto, StudioProjectRevisionDto } from '@immich/sdk';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import type { StudioProjectSession } from '$lib/frameleaf/studio/project-session';
  import { coerceRational, toDisplaySeconds, type Rational } from '$lib/frameleaf/studio/rational-time';

  const PAGE = 20;

  let {
    session,
    revision,
    userId,
    access,
    canRestore,
    playhead = null,
    onClose,
  }: {
    session: StudioProjectSession;
    /** The head revision; a change rebuilds both lists. */
    revision: number;
    userId: string;
    access: 'owner' | 'reviewer' | null;
    /** True when this instance holds the lease and may append a restore. */
    canRestore: boolean;
    /** Where a new comment is pinned; the start of the sequence when the engine reports none. */
    playhead?: Rational | null;
    onClose: () => void;
  } = $props();

  let revisions = $state<StudioProjectRevisionDto[]>([]);
  let revisionTotal = $state(0);
  let comments = $state<StudioCommentDto[]>([]);
  let commentTotal = $state(0);
  let loading = $state(false);
  let failed = $state(false);
  let busyRevision = $state<number | null>(null);
  let commentText = $state('');
  let posting = $state(false);

  /** Responses from before the latest reload are dropped, never merged into the fresh lists. */
  let generation = 0;

  const load = async () => {
    const gen = ++generation;
    loading = true;
    failed = false;
    try {
      const [history, review] = await Promise.all([session.history(0, PAGE), session.comments(0, PAGE)]);
      if (gen !== generation) {
        return;
      }
      revisions = history.items;
      revisionTotal = history.total;
      comments = review.items;
      commentTotal = review.total;
    } catch {
      if (gen === generation) {
        failed = true;
      }
    } finally {
      if (gen === generation) {
        loading = false;
      }
    }
  };

  const moreRevisions = async () => {
    const gen = generation;
    const page = await session.history(revisions.length, PAGE);
    if (gen === generation) {
      revisions = [...revisions, ...page.items];
      revisionTotal = page.total;
    }
  };

  const moreComments = async () => {
    const gen = generation;
    const page = await session.comments(comments.length, PAGE);
    if (gen === generation) {
      comments = [...comments, ...page.items];
      commentTotal = page.total;
    }
  };

  const restore = async (target: number) => {
    busyRevision = target;
    try {
      const ok = await session.restore(target);
      if (ok) {
        toastManager.primary($t('frameleaf_studio_restored', { values: { revision: target } }));
      } else {
        toastManager.danger($t('frameleaf_studio_restore_failed'));
      }
    } finally {
      busyRevision = null;
    }
  };

  const addComment = async () => {
    const text = commentText.trim();
    if (!text) {
      return;
    }
    posting = true;
    try {
      const time = playhead ?? { num: 0, den: 1 };
      const created = await session.addComment({ revision, time: { num: time.num, den: time.den }, text });
      comments = [...comments, created];
      commentTotal += 1;
      commentText = '';
    } catch {
      toastManager.danger($t('frameleaf_studio_command_failed'));
    } finally {
      posting = false;
    }
  };

  const setResolved = async (comment: StudioCommentDto, resolved: boolean) => {
    try {
      const updated = await session.updateComment(comment.id, { resolved });
      comments = comments.map((item) => (item.id === updated.id ? updated : item));
    } catch {
      toastManager.danger($t('frameleaf_studio_command_failed'));
    }
  };

  const canResolve = (comment: StudioCommentDto) => access === 'owner' || comment.authorId === userId;

  const timeLabel = (comment: StudioCommentDto) => {
    const time = coerceRational(comment.time);
    return time ? `${toDisplaySeconds(time, 3)} s` : '';
  };

  const summaryCount = (item: StudioProjectRevisionDto) => item.summary.total;

  // The head changing means the lists are stale: rebuild rather than patch.
  $effect(() => {
    void revision;
    void load();
  });
</script>

<aside class="fl-studio-history" aria-label={$t('frameleaf_studio_history_title')}>
  <header>
    <h2>{$t('frameleaf_studio_history_title')}</h2>
    <Button variant="quiet" onclick={onClose}>{$t('close')}</Button>
  </header>

  {#if failed}
    <p class="muted">{$t('frameleaf_studio_command_failed')}</p>
    <Button variant="quiet" onclick={load}>{$t('frameleaf_studio_retry')}</Button>
  {:else if loading && revisions.length === 0}
    <p class="muted">{$t('loading')}</p>
  {:else if revisions.length === 0}
    <p class="muted">{$t('frameleaf_studio_history_empty')}</p>
  {:else}
    <ol class="fl-studio-revisions">
      {#each revisions as item (item.id)}
        <li>
          <div class="fl-studio-revision-head">
            <strong>{$t('frameleaf_studio_history_version', { values: { revision: item.revision } })}</strong>
            {#if item.revision === revision}
              <span class="fl-studio-tag">{$t('frameleaf_studio_history_current')}</span>
            {:else if canRestore}
              <Button variant="quiet" disabled={busyRevision !== null} onclick={() => restore(item.revision)}>
                {$t('frameleaf_studio_history_restore')}
              </Button>
            {/if}
          </div>
          <div class="muted fl-studio-revision-meta">
            <time datetime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time>
            <span>{$t('frameleaf_studio_history_command_count', { values: { count: summaryCount(item) } })}</span>
            {#if item.restoredFromRevision !== null}
              <span
                >{$t('frameleaf_studio_history_restored_from', {
                  values: { revision: item.restoredFromRevision },
                })}</span
              >
            {/if}
          </div>
        </li>
      {/each}
    </ol>
    {#if revisions.length < revisionTotal}
      <Button variant="quiet" onclick={moreRevisions}>{$t('frameleaf_studio_history_show_more')}</Button>
    {/if}
  {/if}

  <h3>{$t('frameleaf_studio_comments_title')}</h3>
  {#if !failed && !loading && comments.length === 0}
    <p class="muted">{$t('frameleaf_studio_comments_empty')}</p>
  {/if}
  <ul class="fl-studio-comments">
    {#each comments as comment (comment.id)}
      <li class:resolved={comment.resolvedAt !== null}>
        <div class="fl-studio-comment-head">
          <span class="fl-studio-tag">{timeLabel(comment)}</span>
          {#if comment.resolvedAt}
            <span class="muted">{$t('frameleaf_studio_comment_resolved')}</span>
          {/if}
          {#if canResolve(comment)}
            <Button variant="quiet" onclick={() => setResolved(comment, comment.resolvedAt === null)}>
              {comment.resolvedAt ? $t('frameleaf_studio_comment_reopen') : $t('frameleaf_studio_comment_resolve')}
            </Button>
          {/if}
        </div>
        <p>{comment.text}</p>
      </li>
    {/each}
  </ul>
  {#if comments.length < commentTotal}
    <Button variant="quiet" onclick={moreComments}>{$t('frameleaf_studio_history_show_more')}</Button>
  {/if}

  {#if access !== null && revision > 0}
    <form
      class="fl-studio-comment-form"
      onsubmit={(event) => {
        event.preventDefault();
        void addComment();
      }}
    >
      <label>
        <span class="sr-only">{$t('frameleaf_studio_comment_add')}</span>
        <textarea
          rows="2"
          maxlength="2000"
          placeholder={$t('frameleaf_studio_comment_placeholder')}
          bind:value={commentText}
          disabled={posting}></textarea>
      </label>
      <Button type="submit" disabled={posting || commentText.trim().length === 0}>
        {$t('frameleaf_studio_comment_add')}
      </Button>
    </form>
  {/if}
</aside>

<style>
  .fl-studio-history {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    width: min(22rem, 100%);
    height: 100%;
    padding: 0.75rem;
    overflow: auto;
    background: var(--fl-panel);
    border-left: 1px solid var(--fl-border);
    color: var(--fl-text);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  h2,
  h3 {
    margin: 0;
    font-size: 0.9375rem;
    font-weight: 600;
  }
  h3 {
    margin-top: 0.5rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--fl-border);
  }
  ol,
  ul {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  li {
    padding: 0.5rem 0.625rem;
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  li.resolved {
    opacity: 0.7;
  }
  li p {
    margin: 0.25rem 0 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .fl-studio-revision-head,
  .fl-studio-comment-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .fl-studio-revision-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-top: 0.25rem;
    font-size: 0.8125rem;
  }
  .muted {
    color: var(--fl-muted);
    margin: 0;
  }
  .fl-studio-tag {
    padding: 0.125rem 0.4375rem;
    font-size: var(--fl-font-micro);
    font-weight: 600;
    color: var(--fl-text);
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-pill);
  }
  .fl-studio-comment-form {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .fl-studio-comment-form label {
    display: block;
  }
  textarea {
    width: 100%;
    resize: vertical;
    padding: 0.4375rem 0.625rem;
    color: var(--fl-text);
    background: var(--fl-canvas);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    font: inherit;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
</style>
