<script lang="ts" module>
  import type { StudioCommentDto } from '@frameleaf/sdk';
  import { studioTimecode } from '$lib/frameleaf/studio/chrome';
  import { coerceRational } from '$lib/frameleaf/studio/rational-time';

  const PAGE = 20;
  /** How long a comment that was just posted keeps its tint before it settles into the list. */
  const FRESH_MS = 60;

  /** The moment of the film a comment is pinned to, as a clock. */
  const timeOf = (comment: StudioCommentDto) => studioTimecode(coerceRational(comment.time));
</script>

<script lang="ts">
  import { locale } from '$lib/stores/preferences.store';
  /**
   * Review for a Studio project (FL-89, `STU-202`): its comments and its versions.
   *
   * The drawer carries the name of the header button that opens it, Review, and holds two views over
   * the session's own calls. Comments come first: each is pinned to a moment of the film, a reviewer
   * without the lease may add one and its author or the owner may resolve it, and the field at the
   * foot says which moment the next one will be pinned to. Versions is the saved history, newest
   * first and grouped by day, with "Go back to this version", which appends a new version rather than
   * rewinding, so nothing is lost and it can be undone. Both lists are rebuilt whenever the head
   * version changes, so nothing cached for an earlier state survives a reload or a step back.
   */
  import { tick } from 'svelte';
  import { t } from 'svelte-i18n';
  import { Icon, toastManager } from '@frameleaf/ui';
  import { mdiCheck, mdiClose } from '@mdi/js';
  import type { StudioProjectRevisionDto } from '@frameleaf/sdk';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import IconButton from '$lib/components/frameleaf/IconButton.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import Skeleton from '$lib/components/frameleaf/Skeleton.svelte';
  import { dock, motionScrollBehavior } from '$lib/frameleaf/motion';
  import { rovingFocus } from '$lib/frameleaf/roving-focus';
  import { groupStudioByDay, studioRelativeTime } from '$lib/frameleaf/studio/chrome';
  import type { StudioProjectSession } from '$lib/frameleaf/studio/project-session';
  import type { Rational } from '$lib/frameleaf/studio/rational-time';
  import { toastUndo } from '$lib/frameleaf/toast';
  import { ICON_SIZE } from '$lib/frameleaf/tokens';

  type Tab = 'comments' | 'versions';

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

  const tabs: { id: Tab; label: 'frameleaf_studio_tab_comments' | 'frameleaf_studio_tab_versions' }[] = [
    { id: 'comments', label: 'frameleaf_studio_tab_comments' },
    { id: 'versions', label: 'frameleaf_studio_tab_versions' },
  ];

  let tab = $state<Tab>('comments');
  let revisions = $state<StudioProjectRevisionDto[]>([]);
  let revisionTotal = $state(0);
  let comments = $state<StudioCommentDto[]>([]);
  let commentTotal = $state(0);
  let loading = $state(false);
  let failed = $state(false);
  let busyRevision = $state<number | null>(null);
  let commentText = $state('');
  let posting = $state(false);
  let freshId = $state<string | null>(null);
  let scroller = $state<HTMLElement>();
  const fieldId = $props.id();

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

  /**
   * Going back appends a new version that copies the chosen one, so the version the person leaves is
   * still in the list. That makes it safe to do at once, with Undo: undoing goes back to the version
   * they were on, the same way.
   */
  const goBackTo = async (target: number, undoTo: number | null) => {
    busyRevision = target;
    try {
      const ok = await session.restore(target);
      if (!ok) {
        toastManager.danger($t('frameleaf_studio_restore_failed'));
        return;
      }
      const message = $t('frameleaf_studio_restored', { values: { revision: target } });
      if (undoTo === null) {
        toastManager.primary(message);
      } else {
        toastUndo(message, () => void goBackTo(undoTo, null));
      }
      scroller?.scrollTo({ top: 0, behavior: motionScrollBehavior() });
    } finally {
      busyRevision = null;
    }
  };

  const pinTime = $derived(studioTimecode(playhead));

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
      // The new row arrives tinted and lets the tint go, so the eye finds it at the end of the list.
      freshId = created.id;
      await tick();
      const list = scroller;
      list?.scrollTo({ top: list.scrollHeight, behavior: motionScrollBehavior() });
      setTimeout(() => {
        if (freshId === created.id) {
          freshId = null;
        }
      }, FRESH_MS);
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

  const days = $derived(groupStudioByDay(revisions, (item) => item.createdAt));
  const dayFormat = $derived(
    new Intl.DateTimeFormat($locale ?? undefined, { weekday: 'long', month: 'long', day: 'numeric' }),
  );
  const clockFormat = $derived(new Intl.DateTimeFormat($locale ?? undefined, { timeStyle: 'short' }));
  const dayLabel = (group: { daysAgo: number; date: Date }) =>
    group.daysAgo === 0
      ? $t('frameleaf_studio_history_today')
      : group.daysAgo === 1
        ? $t('frameleaf_studio_history_yesterday')
        : dayFormat.format(group.date);

  // The head changing means the lists are stale: rebuild rather than patch.
  $effect(() => {
    void revision;
    void load();
  });
</script>

<aside class="fl-studio-history" aria-label={$t('frameleaf_studio_review')} data-testid="studio-review-panel">
  <header>
    <h2 tabindex="-1" data-drawer-focus>{$t('frameleaf_studio_review')}</h2>
    <IconButton label={$t('close')} onclick={onClose}>
      <Icon icon={mdiClose} size={ICON_SIZE.lg} />
    </IconButton>
  </header>

  <div class="fl-studio-tabs" role="radiogroup" use:rovingFocus aria-label={$t('frameleaf_studio_review_tabs')}>
    {#each tabs as item (item.id)}
      <button type="button" role="radio" aria-checked={tab === item.id} onclick={() => (tab = item.id)}>
        {$t(item.label)}
      </button>
    {/each}
  </div>

  <div class="fl-studio-scroll" bind:this={scroller} aria-busy={loading}>
    {#if failed}
      <InlineError compact message={$t('frameleaf_studio_command_failed')} onRetry={load} />
    {:else if tab === 'comments'}
      {#if loading && comments.length === 0}
        <Skeleton variant="text" lines={4} />
      {:else if comments.length === 0}
        <p class="fl-studio-quiet">{$t('frameleaf_studio_comments_empty')}</p>
      {:else}
        <ul class="fl-studio-comments">
          {#each comments as comment (comment.id)}
            <li class:resolved={comment.resolvedAt !== null} class:fresh={comment.id === freshId} in:dock={{ y: 6 }}>
              <div class="fl-studio-row-head">
                <span class="fl-studio-tag">{timeOf(comment)}</span>
                <span class="fl-studio-quiet">
                  {#if comment.authorId === userId}{$t('frameleaf_studio_comment_you')} ·{/if}
                  <time datetime={comment.createdAt}>{studioRelativeTime(comment.createdAt, $locale)}</time>
                  {#if comment.resolvedAt}· {$t('frameleaf_studio_comment_resolved')}{/if}
                </span>
                {#if canResolve(comment)}
                  <IconButton
                    label={comment.resolvedAt
                      ? $t('frameleaf_studio_comment_reopen')
                      : $t('frameleaf_studio_comment_resolve')}
                    pressed={comment.resolvedAt !== null}
                    onclick={() => setResolved(comment, comment.resolvedAt === null)}
                  >
                    <Icon icon={mdiCheck} size={ICON_SIZE.md} />
                  </IconButton>
                {/if}
              </div>
              <p>{comment.text}</p>
            </li>
          {/each}
        </ul>
        {#if comments.length < commentTotal}
          <Button variant="quiet" onclick={moreComments}>{$t('frameleaf_studio_history_show_more')}</Button>
        {/if}
      {/if}
    {:else if loading && revisions.length === 0}
      <Skeleton variant="text" lines={4} />
    {:else if revisions.length === 0}
      <p class="fl-studio-quiet">{$t('frameleaf_studio_history_empty')}</p>
    {:else}
      {#each days as group (group.day)}
        <section class="fl-studio-day" aria-labelledby="{fieldId}-{group.day}">
          <h3 id="{fieldId}-{group.day}">{dayLabel(group)}</h3>
          <ol class="fl-studio-revisions">
            {#each group.items as item (item.id)}
              <li in:dock={{ y: -8 }}>
                <div class="fl-studio-row-head">
                  <time class="fl-studio-clock" datetime={item.createdAt}
                    >{clockFormat.format(new Date(item.createdAt))}</time
                  >
                  {#if item.revision === revision}
                    <span class="fl-studio-tag">{$t('frameleaf_studio_history_current')}</span>
                  {/if}
                </div>
                <div class="fl-studio-quiet fl-studio-revision-meta">
                  <strong>{$t('frameleaf_studio_history_version', { values: { revision: item.revision } })}</strong>
                  <span>{$t('frameleaf_studio_history_command_count', { values: { count: item.summary.total } })}</span>
                  {#if item.restoredFromRevision !== null}
                    <span
                      >{$t('frameleaf_studio_history_restored_from', {
                        values: { revision: item.restoredFromRevision },
                      })}</span
                    >
                  {/if}
                </div>
                {#if item.revision !== revision && canRestore}
                  <Button
                    variant="quiet"
                    disabled={busyRevision !== null}
                    onclick={() => goBackTo(item.revision, revision)}
                  >
                    {$t('frameleaf_studio_history_restore')}
                  </Button>
                {/if}
              </li>
            {/each}
          </ol>
        </section>
      {/each}
      {#if revisions.length < revisionTotal}
        <Button variant="quiet" onclick={moreRevisions}>{$t('frameleaf_studio_history_show_more')}</Button>
      {/if}
    {/if}
  </div>

  {#if tab === 'comments' && access !== null && revision > 0}
    <!-- Pinned to the foot of the drawer, and it says which moment of the film the comment lands on. -->
    <form
      class="fl-studio-comment-form"
      data-studio-drawer-foot
      onsubmit={(event) => {
        event.preventDefault();
        void addComment();
      }}
    >
      <label for="{fieldId}-comment">{$t('frameleaf_studio_comment_at', { values: { time: pinTime } })}</label>
      <textarea
        id="{fieldId}-comment"
        rows="2"
        maxlength="2000"
        placeholder={$t('frameleaf_studio_comment_placeholder')}
        bind:value={commentText}
        disabled={posting}></textarea>
      <Button type="submit" variant="primary" disabled={posting || commentText.trim().length === 0}>
        {$t('frameleaf_studio_comment_post_at', { values: { time: pinTime } })}
      </Button>
    </form>
  {/if}
</aside>

<style>
  .fl-studio-history {
    display: flex;
    flex-direction: column;
    width: min(22rem, 100vw);
    height: 100%;
    background: var(--fl-panel);
    border-inline-start: 1px solid var(--fl-border);
    color: var(--fl-text);
    font-size: var(--fl-font-size);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--fl-space-2);
    padding: var(--fl-space-2) var(--fl-space-2) var(--fl-space-2) var(--fl-space-4);
  }
  h2 {
    margin: 0;
    font: var(--fl-type-headline);
    font-size: var(--fl-font-size);
    font-weight: 600;
  }
  /* The heading takes focus when the drawer opens, for the keyboard's sake; it is not a control. */
  h2:focus {
    outline: none;
  }
  /* studio.css `.fls-segmented`: one view at a time. */
  .fl-studio-tabs {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--fl-space-half);
    margin: 0 var(--fl-space-4) var(--fl-space-2);
    padding: var(--fl-space-half);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-pill);
    background: var(--fl-canvas);
  }
  .fl-studio-tabs button {
    padding: 0 var(--fl-space-3);
    border: 0;
    border-radius: var(--fl-radius-pill);
    background: transparent;
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
    cursor: pointer;
  }
  .fl-studio-tabs button[aria-checked='true'] {
    background: var(--fl-panel);
    color: var(--fl-text);
    box-shadow: var(--fl-shadow-1);
  }
  .fl-studio-scroll {
    display: flex;
    flex-direction: column;
    gap: var(--fl-space-3);
    flex: 1 1 auto;
    min-height: 0;
    padding: var(--fl-space-2) var(--fl-space-4) var(--fl-space-4);
    overflow: auto;
  }
  h3 {
    margin: 0 0 var(--fl-space-2);
    font: var(--fl-type-caption);
    font-weight: 600;
    color: var(--fl-muted);
  }
  ol,
  ul {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: var(--fl-space-2);
  }
  li {
    padding: var(--fl-space-2) var(--fl-space-3);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    transition:
      opacity var(--fl-motion-slow) var(--fl-ease),
      background-color var(--fl-duration-hero) var(--fl-ease);
  }
  li.resolved {
    opacity: 0.7;
  }
  li.fresh {
    background: var(--fl-accent-soft);
    transition-duration: 0s;
  }
  li p {
    margin: var(--fl-space-1) 0 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .fl-studio-row-head {
    display: flex;
    align-items: center;
    gap: var(--fl-space-2);
    min-height: var(--fl-control-height-compact);
  }
  .fl-studio-row-head > :global(:last-child:not(:first-child)) {
    margin-inline-start: auto;
  }
  .fl-studio-clock {
    font-weight: 600;
    font-variant-numeric: var(--fl-numeric);
  }
  .fl-studio-revision-meta {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-1) var(--fl-space-2);
  }
  .fl-studio-revision-meta strong {
    font-weight: inherit;
  }
  .fl-studio-revisions :global(button) {
    margin: var(--fl-space-1) 0 0 calc(var(--fl-space-3) * -1);
  }
  .fl-studio-quiet {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
  }
  .fl-studio-tag {
    padding: var(--fl-space-half) var(--fl-space-2);
    font-size: var(--fl-font-micro);
    font-weight: 600;
    font-variant-numeric: var(--fl-numeric);
    color: var(--fl-text);
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-pill);
  }
  .fl-studio-comment-form {
    display: flex;
    flex-direction: column;
    gap: var(--fl-space-2);
    padding: var(--fl-space-3) var(--fl-space-4) var(--fl-space-4);
    border-top: 1px solid var(--fl-border);
    background: var(--fl-panel);
  }
  .fl-studio-comment-form label {
    font-size: var(--fl-font-callout);
    font-weight: 600;
    font-variant-numeric: var(--fl-numeric);
  }
  textarea {
    width: 100%;
    resize: vertical;
    padding: var(--fl-space-2) var(--fl-space-3);
    color: var(--fl-text);
    background: var(--fl-canvas);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    font: inherit;
  }
</style>
