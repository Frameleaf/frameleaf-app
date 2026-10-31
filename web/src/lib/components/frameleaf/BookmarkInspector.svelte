<script lang="ts">
  import BoardsRating from '$lib/components/frameleaf/BoardsRating.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import { onLibraryAccessChange } from '$lib/frameleaf/library-access';
  import { libraryReferenceUrl } from '$lib/frameleaf/library-reference';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { getBookmark, updateBookmark, type BookmarkResponseDto } from '@frameleaf/sdk';
  import { onDestroy } from 'svelte';
  import { t } from 'svelte-i18n';

  let {
    id,
    bookmark,
    onClose,
    onChange,
  }: {
    id: string;
    bookmark?: BookmarkResponseDto;
    onClose: () => void;
    onChange?: (bookmark: BookmarkResponseDto) => void;
  } = $props();
  let detail = $state<BookmarkResponseDto | null>(null);
  let title = $state('');
  let note = $state('');
  let rating = $state<number | null>(null);
  let busy = $state(false);
  let failed = $state(false);
  let generation = $state(0);
  let invalidatedBookmark = $state.raw<BookmarkResponseDto>();
  const owner = $derived(!!detail && authManager.authenticated && detail.ownerId === authManager.user.id);
  const url = $derived(libraryReferenceUrl(detail?.url));
  onDestroy(
    onLibraryAccessChange(() => {
      invalidatedBookmark = bookmark;
      detail = null;
      title = '';
      note = '';
      rating = null;
      generation++;
    }),
  );
  $effect(() => {
    const selected = id;
    const shared = bookmark;
    const version = generation;
    const controller = new AbortController();
    detail = null;
    title = '';
    note = '';
    rating = null;
    failed = false;
    busy = false;
    if (!authManager.authenticated) {
      return () => controller.abort();
    }
    if (shared && shared.ownerId !== authManager.user.id) {
      // The parent refreshes this authorized, redacted search projection; owned detail reads stay private.
      if (shared !== invalidatedBookmark && shared.id === selected) {
        detail = { ...shared, note: null, rating: null };
      }
      return () => controller.abort();
    }
    void getBookmark({ id: selected }, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted || id !== selected || generation !== version) {
          return;
        }
        detail = result;
        title = result.title;
        note = result.note ?? '';
        rating = result.rating ?? null;
      })
      .catch(() => {
        if (!controller.signal.aborted && generation === version) {
          failed = true;
        }
      });
    return () => controller.abort();
  });
  const save = async () => {
    if (!owner || !detail || busy) {
      return;
    }
    const selected = id;
    const version = generation;
    busy = true;
    failed = false;
    try {
      const updated = await updateBookmark({
        id: selected,
        bookmarkUpdateDto: { title, note: note || null, rating },
      });
      if (id !== selected || generation !== version) {
        return;
      }
      detail = updated;
      onChange?.(updated);
    } catch {
      if (id === selected && generation === version) {
        failed = true;
      }
    } finally {
      if (id === selected && generation === version) {
        busy = false;
      }
    }
  };
</script>

<aside class="fl-bookmark-inspector" aria-label={$t('frameleaf_bookmark_details')}>
  <div class="fl-bookmark-heading">
    <h2>{detail?.title || $t('frameleaf_bookmark_details')}</h2>
    <Button onclick={onClose}>{$t('close')}</Button>
  </div>
  {#if failed}<InlineError
      compact
      message={$t('frameleaf_item_details_unavailable')}
      onRetry={() => generation++}
    />{/if}
  {#if detail}
    {#if url}<a href={url} target="_blank" rel="noopener noreferrer">{$t('frameleaf_bookmark_open_source')}</a>{/if}
    {#if owner}
      <form
        onsubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label>{$t('frameleaf_bookmark_title')}<input bind:value={title} maxlength="2000" disabled={busy} /></label>
        <label
          >{$t('frameleaf_bookmark_note')}<textarea bind:value={note} maxlength="20000" rows="8" disabled={busy}
          ></textarea></label
        >
        <div class="fl-bookmark-field">
          <span aria-hidden="true">{$t('rating')}</span>
          <!-- The same Rejected-and-stars control as files; it is saved with the form. -->
          <BoardsRating value={rating} disabled={busy} onChange={(next) => (rating = next)} />
        </div>
        <Button type="submit" variant="primary" disabled={busy}>{$t('save')}</Button>
      </form>
    {/if}
  {:else if !failed}<p role="status">{$t('loading')}</p>{/if}
</aside>

<style>
  .fl-bookmark-inspector {
    display: flex;
    flex-direction: column;
    gap: var(--fl-space-4);
    padding: var(--fl-space-4);
    min-width: 0;
  }
  .fl-bookmark-heading {
    display: flex;
    align-items: start;
    justify-content: space-between;
    gap: var(--fl-space-2);
  }
  h2 {
    font-size: var(--fl-font-size);
    overflow-wrap: anywhere;
    font-weight: 600;
  }
  a {
    color: var(--fl-accent);
    overflow-wrap: anywhere;
    text-decoration: underline;
  }
  form,
  label,
  .fl-bookmark-field {
    display: flex;
    flex-direction: column;
    gap: var(--fl-space-2);
  }
  form {
    gap: var(--fl-space-4);
  }
  input,
  textarea {
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    padding: var(--fl-space-2);
    width: 100%;
  }
  textarea {
    resize: vertical;
  }
</style>
