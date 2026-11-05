<script lang="ts">
  import BoardsRating from '$lib/components/frameleaf/BoardsRating.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import { onLibraryAccessChange } from '$lib/frameleaf/library-access';
  import { libraryReferenceUrl } from '$lib/frameleaf/library-reference';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import {
    addBookmarkTags,
    AssetMediaSize,
    getAllTags,
    getBookmark,
    getBookmarkTags,
    setBookmarkTags,
    updateBookmark,
    type BookmarkResponseDto,
    type ColorFilter,
    type TagResponseDto,
  } from '@frameleaf/sdk';
  import AssetPalette from '$lib/components/frameleaf/AssetPalette.svelte';
  import AssetSources from '$lib/components/frameleaf/AssetSources.svelte';
  import { bookmarkSources, type BookmarkWithSource } from '$lib/frameleaf/bookmark-source';
  import BoardsTagEditor from '$lib/components/frameleaf/BoardsTagEditor.svelte';
  import IconButton from '$lib/components/frameleaf/IconButton.svelte';
  import { getAssetMediaUrl } from '$lib/utils';
  import { Icon } from '@frameleaf/ui';
  import { mdiClose, mdiLinkVariantPlus, mdiOpenInNew, mdiWeb } from '@mdi/js';
  import { onDestroy } from 'svelte';
  import { t } from 'svelte-i18n';

  let {
    id,
    bookmark,
    onClose,
    onChange,
    onChooseColor,
  }: {
    id: string;
    bookmark?: BookmarkResponseDto;
    onClose: () => void;
    onChange?: (bookmark: BookmarkResponseDto) => void;
    /** A colour from the link's picture finds similar items (prototype `Inspector` Colours). */
    onChooseColor?: (color: ColorFilter) => void;
  } = $props();
  /** The link's own tags (bookmark tag API), as tag records for the editor; null until read. */
  let tags = $state<TagResponseDto[] | null>(null);
  let detail = $state<BookmarkWithSource | null>(null);
  let title = $state('');
  let note = $state('');
  let rating = $state<number | null>(null);
  let busy = $state(false);
  let failed = $state(false);
  let generation = $state(0);
  let invalidatedBookmark = $state.raw<BookmarkResponseDto>();
  const owner = $derived(!!detail && authManager.authenticated && detail.ownerId === authManager.user.id);
  const url = $derived(libraryReferenceUrl(detail?.url));
  const site = $derived(url ? new URL(url).hostname.replace(/^www\./, '') : '');
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
  // The owner's tags for this link: the ids from the bookmark, the names from the tag list.
  const tagsFor = $derived(owner ? detail?.id : undefined);
  $effect(() => {
    const selected = tagsFor;
    tags = null;
    if (!selected) {
      return;
    }
    let current = true;
    void Promise.all([Promise.resolve(getBookmarkTags({ id: selected })), Promise.resolve(getAllTags())])
      .then(([linked, all]) => {
        if (current && linked && Array.isArray(all)) {
          const ids = new Set(linked.ids);
          tags = all.filter((tag) => ids.has(tag.id));
        }
      })
      .catch(() => {
        // Tags stay hidden; the rest of the link's details still work.
      });
    return () => {
      current = false;
    };
  });
  const removeLinkTag = async (tagId: string) => {
    const linked = await getBookmarkTags({ id });
    await setBookmarkTags({ id, bookmarkTagsDto: { ids: linked.ids.filter((tag) => tag !== tagId) } });
  };
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

<!-- Prototype ProWorkspace.jsx `Inspector` for a link: "Saved link", its picture, title and site. -->
<aside class="fl-bookmark-inspector" aria-label={$t('frameleaf_bookmark_details')}>
  <div class="fl-bookmark-heading">
    <h2>{$t('frameleaf_boards_saved_link')}</h2>
    <IconButton variant="default" label={$t('frameleaf_boards_close_details')} onclick={onClose}>
      <Icon icon={mdiClose} size="18" aria-hidden />
    </IconButton>
  </div>
  <div class="fl-bookmark-body">
    {#if detail}
      <figure class="fl-bookmark-preview">
        {#if detail.previewAssetId}
          <img src={getAssetMediaUrl({ id: detail.previewAssetId, size: AssetMediaSize.Preview })} alt="" />
        {:else}
          <span aria-hidden="true"><Icon icon={mdiWeb} size="48" /></span>
        {/if}
      </figure>
      <h3 class="fl-bookmark-name">{detail.title || site || $t('frameleaf_bookmark_details')}</h3>
    {/if}
    {#if failed}<InlineError
        compact
        message={$t('frameleaf_item_details_unavailable')}
        onRetry={() => generation++}
      />{/if}
    {#if detail}
      {#if url}<a class="fl-bookmark-open" href={url} target="_blank" rel="noopener noreferrer"
          ><Icon icon={mdiOpenInNew} size="16" aria-hidden />{site
            ? $t('frameleaf_boards_open_site', { values: { site } })
            : $t('frameleaf_bookmark_open_source')}</a
        >{/if}
      {#if owner && detail.previewAssetId}
        <AssetPalette assetId={detail.previewAssetId} canRetry onChoose={onChooseColor} limit={5} />
      {/if}
      {#if owner && tags}
        <section class="fl-bookmark-tags" aria-labelledby="fl-bookmark-tags-{detail.id}">
          <h3 id="fl-bookmark-tags-{detail.id}">{$t('tags')}</h3>
          <BoardsTagEditor
            assetId={detail.id}
            {tags}
            canEdit
            labelledBy="fl-bookmark-tags-{detail.id}"
            onAdd={(tagId) => addBookmarkTags({ id: detail!.id, bookmarkTagsDto: { ids: [tagId] } })}
            onRemove={removeLinkTag}
          />
        </section>
      {/if}
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
            <span aria-hidden="true">{$t('frameleaf_boards_rating')}</span>
            <!-- The same Rejected-and-stars control as files; it is saved with the form. -->
            <BoardsRating value={rating} disabled={busy} onChange={(next) => (rating = next)} />
          </div>
          <Button type="submit" variant="primary" disabled={busy}>{$t('save')}</Button>
        </form>
      {/if}
      <!-- Prototype `Inspector` Source: how it was saved, the page, creator and licence, and when. -->
      <AssetSources
        assetId={detail.id}
        canRead={owner}
        added={detail.createdAt || undefined}
        given={bookmarkSources(detail)}
        fallbackVia={{ icon: mdiLinkVariantPlus, label: $t('frameleaf_boards_save_link') }}
      />
    {:else if !failed}<p role="status">{$t('loading')}</p>{/if}
  </div>
</aside>

<style>
  /* Prototype .pro-inspector: a headed panel, a 24px inset, sections 24px apart with eyebrow labels. */
  .fl-bookmark-inspector {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .fl-bookmark-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--fl-space-2);
    padding: var(--fl-space-3) var(--fl-space-3) var(--fl-space-3) var(--fl-space-6);
    border-bottom: 1px solid var(--fl-border);
  }
  .fl-bookmark-body {
    display: flex;
    flex-direction: column;
    gap: var(--fl-space-4);
    padding: var(--fl-space-4) var(--fl-space-6) var(--fl-space-6);
  }
  h2 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
  }
  .fl-bookmark-name {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .fl-bookmark-preview {
    margin: 0;
  }
  .fl-bookmark-preview img,
  .fl-bookmark-preview span {
    display: grid;
    place-items: center;
    width: 100%;
    max-height: 260px;
    aspect-ratio: 16 / 9;
    object-fit: contain;
    color: var(--fl-muted);
    background: var(--fl-raised);
    border-radius: var(--fl-radius-control);
  }
  .fl-bookmark-open {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--fl-accent);
    overflow-wrap: anywhere;
  }
  .fl-bookmark-body :global(h3:not(.fl-bookmark-name)) {
    margin: 0 0 var(--fl-space-2);
  }
  .fl-bookmark-body :global(h3:not(.fl-bookmark-name)),
  form > label,
  .fl-bookmark-field > span {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  form > label > input,
  form > label > textarea {
    color: var(--fl-text);
    font-size: var(--fl-font-size);
    font-weight: 400;
    letter-spacing: normal;
    text-transform: none;
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
