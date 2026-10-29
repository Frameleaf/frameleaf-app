<script lang="ts">
  import AlbumDestinationPicker from '$lib/components/frameleaf/AlbumDestinationPicker.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { fileUploadHandler } from '$lib/utils/file-uploader';
  import { handleError } from '$lib/utils/handle-error';
  import {
    addBookmarksToAlbum,
    createBookmark,
    getAllAlbums,
    LibraryScope,
    LibraryViewScope,
    previewBookmark,
    type AlbumResponseDto,
  } from '@frameleaf/sdk';
  import { untrack } from 'svelte';
  import { t } from 'svelte-i18n';

  /**
   * "Save a link" in Boards (prototype `SaveLinkDialog`, README point 9): the address, then the
   * title and picture read from the page (FL-632, through the server's guarded `previewBookmark`),
   * a collection and a note. Only the address, title, note and picture are stored, never a copy of
   * the page. The picture is uploaded as a Boards-only file and shows on the link's card, not as
   * an item of its own.
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
  /** What the page gave; `titleEdited` keeps a title the person typed. */
  let preview = $state<{
    for: string;
    title: string | null;
    image: { contentType: string; data: string } | null;
  } | null>(null);
  let reading = $state(false);
  let titleEdited = $state(false);
  const id = $props.id();

  $effect(() => {
    if (open) {
      untrack(() => {
        url = initialUrl;
        title = '';
        note = '';
        collection = albumId ?? null;
        touched = false;
        preview = null;
        titleEdited = false;
        if (initialUrl) {
          void read();
        }
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

  /** Reads the page once per address; a page that cannot be read just leaves the fields empty. */
  const read = async () => {
    const address = parsed?.href;
    if (!address || preview?.for === address) {
      return;
    }
    reading = true;
    try {
      const result = await previewBookmark({ bookmarkPreviewRequestDto: { url: address } });
      if (parsed?.href !== address) {
        return;
      }
      preview = { for: address, ...result };
      if (!titleEdited) {
        // a title the page filled in for an earlier address must not stay on this one
        title = result.title ?? '';
      }
    } catch {
      preview = { for: address, title: null, image: null };
      if (!titleEdited) {
        title = '';
      }
    } finally {
      reading = false;
    }
  };
  const picture = $derived(
    preview?.for === parsed?.href && preview?.image
      ? `data:${preview.image.contentType};base64,${preview.image.data}`
      : null,
  );
  /** Uploads the page's picture as a Boards-only file, for the link's card. */
  const uploadPicture = async (): Promise<string | null> => {
    if (!picture || !preview?.image) {
      return null;
    }
    const bytes = Uint8Array.from(atob(preview.image.data), (character) => character.codePointAt(0)!);
    const extension = preview.image.contentType.split('/', 2)[1].replace('jpeg', 'jpg');
    const file = new File([bytes], `${parsed!.hostname}-preview.${extension}`, { type: preview.image.contentType });
    const [assetId] = await fileUploadHandler({ files: [file], libraryScope: LibraryScope.Design });
    return assetId ?? null;
  };

  const save = async () => {
    touched = true;
    if (!parsed || busy) {
      return;
    }
    busy = true;
    try {
      const previewAssetId = await uploadPicture();
      const bookmark = await createBookmark({
        bookmarkCreateDto: {
          url: parsed.href,
          title: title.trim() || parsed.hostname,
          note: note.trim() || null,
          libraryScope: LibraryScope.Design,
          ...(previewAssetId && { previewAssetId }),
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
        onchange={() => {
          touched = true;
          void read();
        }}
      />
    </label>
    {#if invalid}
      <p id="{id}-error" class="error" role="alert">{$t('frameleaf_boards_save_link_invalid')}</p>
    {:else}
      <p id="{id}-hint" class="note">{$t('frameleaf_boards_save_link_hint')}</p>
    {/if}
    <label>
      <span>{$t('frameleaf_bookmark_title')}</span>
      <input
        type="text"
        bind:value={title}
        placeholder={reading ? $t('frameleaf_boards_save_link_reading') : (parsed?.hostname ?? '')}
        maxlength="500"
        oninput={() => (titleEdited = true)}
      />
    </label>
    {#if picture}
      <img class="picture" src={picture} alt={$t('frameleaf_boards_save_link_picture')} />
    {/if}
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
  .picture {
    max-height: 10rem;
    max-width: 100%;
    align-self: flex-start;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    object-fit: cover;
  }
  .error {
    color: var(--fl-danger);
  }
</style>
