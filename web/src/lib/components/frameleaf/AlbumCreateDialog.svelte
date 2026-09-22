<script lang="ts">
  import AlbumIcon from '$lib/components/frameleaf/AlbumIcon.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import IconChooser from '$lib/components/frameleaf/IconChooser.svelte';
  import Status from '$lib/components/frameleaf/Status.svelte';
  import { defaultIconFor } from '$lib/frameleaf/album-directory';
  import { AlbumKind, type AlbumResponseDto, type CreateAlbumDto } from '@immich/sdk';
  import { t } from 'svelte-i18n';

  /**
   * Create an album, a collection or a shared space. The icon chooser over the
   * whole Material catalogue is embedded instead of a small fixed grid; an
   * album may be placed inside a collection the user can edit.
   */
  interface Props {
    kind: AlbumKind;
    /** Collections the user can add to, offered as the album's home. */
    collections: AlbumResponseDto[];
    defaultParentId?: string | null;
    open?: boolean;
    onCreate: (dto: CreateAlbumDto) => Promise<boolean>;
  }

  let { kind, collections, defaultParentId = null, open = $bindable(false), onCreate }: Props = $props();

  let albumName = $state('');
  let description = $state('');
  let icon = $state<string>(defaultIconFor(kind));
  let parentId = $state<string | null>(defaultParentId);
  let busy = $state(false);
  let error = $state('');

  $effect(() => {
    if (open) {
      albumName = '';
      description = '';
      icon = defaultIconFor(kind);
      parentId = kind === AlbumKind.Album ? defaultParentId : null;
      error = '';
    }
  });

  const title = $derived(
    kind === AlbumKind.Collection
      ? $t('frameleaf_albums_create_collection')
      : kind === AlbumKind.Space
        ? $t('frameleaf_albums_create_space')
        : $t('frameleaf_albums_create_album'),
  );

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    const name = albumName.trim();
    if (!name) {
      error = $t('frameleaf_albums_name_required');
      return;
    }
    busy = true;
    error = '';
    try {
      const ok = await onCreate({
        albumName: name,
        description: description.trim() || null,
        icon,
        kind,
        parentId: kind === AlbumKind.Album && parentId ? parentId : undefined,
      });
      if (ok) {
        open = false;
      }
    } finally {
      busy = false;
    }
  };
</script>

<Dialog {title} closeLabel={$t('close')} bind:open>
  <form class="create" onsubmit={submit}>
    {#if kind === AlbumKind.Space}
      <p class="hint">{$t('frameleaf_albums_space_description')}</p>
    {/if}
    <label class="field">
      <span>{$t('name')}</span>
      <input type="text" bind:value={albumName} required maxlength="120" autocomplete="off" />
    </label>
    <label class="field">
      <span>{$t('description')}</span>
      <textarea bind:value={description} rows="2" maxlength="2000"></textarea>
    </label>
    {#if kind === AlbumKind.Album && collections.length > 0}
      <label class="field">
        <span>{$t('frameleaf_albums_in_collection')}</span>
        <select bind:value={parentId}>
          <option value={null}>{$t('frameleaf_albums_no_collection')}</option>
          {#each collections as collection (collection.id)}
            <option value={collection.id}>{collection.albumName || $t('unnamed_album')}</option>
          {/each}
        </select>
      </label>
    {/if}
    <div class="field">
      <span class="field-label">
        {$t('icon')}
        <span class="preview" aria-hidden="true"><AlbumIcon name={icon} size="20" /></span>
      </span>
      <IconChooser value={icon} onChange={(name) => (icon = name)} inline label={$t('frameleaf_icons_choose')} />
    </div>
    {#if error}
      <Status message={error} />
    {/if}
    <div class="buttons">
      <button type="button" onclick={() => (open = false)} disabled={busy}>{$t('cancel')}</button>
      <button type="submit" class="primary" disabled={busy}>{$t('create')}</button>
    </div>
  </form>
</Dialog>

<style>
  .create {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin-block-start: 1rem;
    width: min(32rem, calc(100vw - 4rem));
  }
  .hint {
    margin: 0;
    color: var(--fl-muted);
    font-size: 0.875rem;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .field > span,
  .field-label {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--fl-muted);
  }
  .field input,
  .field textarea,
  .field select {
    padding: 0.5rem 0.625rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    background: var(--fl-raised);
    color: var(--fl-text);
    font: inherit;
  }
  .preview {
    display: inline-flex;
    color: var(--fl-text);
  }
  .buttons {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }
  .buttons button {
    padding: 0 1rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    background: var(--fl-raised);
    color: var(--fl-text);
  }
  .buttons .primary {
    background: var(--fl-accent);
    border-color: var(--fl-accent);
    color: var(--fl-accent-text);
  }
  .buttons button:disabled {
    opacity: 0.6;
  }
</style>
