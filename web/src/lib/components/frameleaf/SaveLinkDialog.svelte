<script lang="ts">
  import AlbumDestinationPicker from '$lib/components/frameleaf/AlbumDestinationPicker.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import {
    addBookmarksToAlbum,
    createBookmark,
    getAllAlbums,
    LibraryScope,
    LibraryViewScope,
    type AlbumResponseDto,
  } from '@frameleaf/sdk';
  import { untrack } from 'svelte';
  import { t } from 'svelte-i18n';

  /**
   * "Save a link" in Boards (prototype `SaveLinkDialog`, README point 9): the address, a title, a
   * collection and a note. Only the address, title and note are stored, never a copy of the page.
   *
   * ponytail: the server does not read the page, so the title starts as the site name and the
   * picture is left out. Reading them would mean the server fetching any address it is given (an
   * SSRF surface); the browser extension reads them on the page instead.
   */
  interface Props {
    open?: boolean;
    /** A pasted address, to start from. */
    url?: string;
    /** The collection being viewed, chosen to start with. */
    albumId?: string;
    onSaved: () => void;
  }

  let { open = $bindable(false), url: initialUrl = '', albumId, onSaved }: Props = $props();

  let url = $state('');
  let title = $state('');
  let note = $state('');
  let collection = $state<string | null>(null);
  let albums = $state<AlbumResponseDto[]>([]);
  let busy = $state(false);
  let touched = $state(false);
  const id = $props.id();

  $effect(() => {
    if (open) {
      untrack(() => {
        url = initialUrl;
        title = '';
        note = '';
        collection = albumId ?? null;
        touched = false;
        void getAllAlbums({ libraryScope: LibraryViewScope.Design })
          .then((loaded) => (albums = loaded))
          .catch((error: unknown) => handleError(error, $t('frameleaf_boards_save_link_failed')));
      });
    }
  });

  const parsed = $derived.by(() => {
    try {
      const value = new URL(url.trim());
      return value.protocol === 'http:' || value.protocol === 'https:' ? value : null;
    } catch {
      return null;
    }
  });
  const invalid = $derived(touched && !parsed);

  const save = async () => {
    touched = true;
    if (!parsed || busy) {
      return;
    }
    busy = true;
    try {
      const bookmark = await createBookmark({
        bookmarkCreateDto: {
          url: parsed.href,
          title: title.trim() || parsed.hostname,
          note: note.trim() || null,
          libraryScope: LibraryScope.Design,
        },
      });
      if (collection) {
        await addBookmarksToAlbum({ id: collection, bookmarkIdsDto: { ids: [bookmark.id] } });
      }
      open = false;
      onSaved();
    } catch (error) {
      handleError(error, $t('frameleaf_boards_save_link_failed'));
    } finally {
      busy = false;
    }
  };
</script>

<Dialog title={$t('frameleaf_boards_save_link')} closeLabel={$t('close')} bind:open>
  <form
    class="save-link"
    onsubmit={(event) => {
      event.preventDefault();
      void save();
    }}
  >
    <label>
      <span>{$t('frameleaf_boards_save_link_address')}</span>
      <input
        type="url"
        bind:value={url}
        placeholder="https://"
        required
        autocomplete="off"
        spellcheck="false"
        data-initial-focus
        aria-invalid={invalid}
        aria-describedby={invalid ? `${id}-error` : `${id}-hint`}
        onchange={() => (touched = true)}
      />
    </label>
    {#if invalid}
      <p id="{id}-error" class="error" role="alert">{$t('frameleaf_boards_save_link_invalid')}</p>
    {:else}
      <p id="{id}-hint" class="note">{$t('frameleaf_boards_save_link_hint')}</p>
    {/if}
    <label>
      <span>{$t('frameleaf_bookmark_title')}</span>
      <input type="text" bind:value={title} placeholder={parsed?.hostname ?? ''} maxlength="500" />
    </label>
    <div class="field">
      <span id="{id}-collection">{$t('frameleaf_boards_save_link_collection')}</span>
      <AlbumDestinationPicker
        {albums}
        value={collection}
        onChange={(next) => (collection = next)}
        allowTop
        topLabel={$t('frameleaf_boards_save_link_unfiled')}
        name="save-link-collection"
        label={$t('frameleaf_boards_save_link_collection')}
      />
    </div>
    <label>
      <span>{$t('frameleaf_bookmark_note')}</span>
      <textarea bind:value={note} rows="3"></textarea>
    </label>
  </form>
  {#snippet actions()}
    <button type="button" class="button" disabled={busy} onclick={() => (open = false)}>{$t('cancel')}</button>
    <button type="button" class="button primary" disabled={busy || !url.trim()} onclick={() => void save()}
      >{$t('save')}</button
    >
  {/snippet}
</Dialog>

<style>
  .save-link {
    display: flex;
    flex-direction: column;
    gap: var(--fl-space-3);
    width: min(32rem, 100%);
  }
  label,
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--fl-space-2);
  }
  label > span,
  .field > span {
    color: var(--fl-muted);
    font-size: 0.75rem;
    font-weight: 600;
  }
  .note,
  .error {
    margin: calc(-1 * var(--fl-space-2)) 0 0;
    font-size: var(--fl-font-small, 0.8125rem);
  }
  .note {
    color: var(--fl-muted);
  }
  .error {
    color: var(--fl-danger);
  }
</style>
