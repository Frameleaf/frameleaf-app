<script lang="ts">
  import { createAlbum, LibraryScope, WriteWorkspaces, type OAuthAppGrantDto } from '@frameleaf/sdk';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Field from '$lib/components/frameleaf/settings/kit/Field.svelte';
  import Select from '$lib/components/frameleaf/settings/kit/Select.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import { t } from 'svelte-i18n';

  type Policy = NonNullable<OAuthAppGrantDto['accessPolicy']>;
  let {
    policy = $bindable(),
    albums,
    scopes,
    original,
    disabled = false,
    creating = $bindable(false),
  }: {
    policy: Policy;
    albums: { id: string; name: string; workspace: 'photo' | 'design' | 'both'; canWrite?: boolean }[];
    scopes: string[];
    original?: Policy;
    disabled?: boolean;
    creating?: boolean;
  } = $props();

  const canWrite = $derived(
    scopes.some((scope) => ['albums:write', 'tags:write', 'photos:upload', 'boards:upload'].includes(scope)),
  );
  let created = $state<typeof albums>([]);
  let albumName = $state('');
  let workspace = $state('');
  const choices = $derived(
    ['photo', 'design'].filter(
      (value) =>
        scopes.includes('albums:write') ||
        scopes.includes('tags:write') ||
        scopes.includes(value === 'photo' ? 'photos:upload' : 'boards:upload'),
    ),
  );
  const destinations = $derived([...albums, ...created]);
  // A destination the grant cannot upload into stays off, unless it is already chosen (so it can be cleared).
  const writable = (album: (typeof albums)[number]) =>
    album.canWrite !== false && (album.workspace === 'both' ? choices.length > 0 : choices.includes(album.workspace));
  const createDestination = async () => {
    const target = workspace || choices[0];
    if (!albumName.trim() || !choices.includes(target)) {
      return;
    }
    creating = true;
    try {
      const album = await createAlbum({
        createAlbumDto: {
          albumName: albumName.trim(),
          libraryScope: target === 'design' ? LibraryScope.Design : LibraryScope.Personal,
        },
      });
      created = [...created, { id: album.id, name: album.albumName, workspace: target as 'photo' | 'design' }];
      policy = { ...policy, writableAlbumIds: [...policy.writableAlbumIds, album.id] };
      albumName = '';
    } catch (error) {
      handleError(error, $t('errors.failed_to_create_album'));
    } finally {
      creating = false;
    }
  };
  const toggle = (field: 'readAlbumIds' | 'writableAlbumIds', id: string, checked: boolean) => {
    policy = { ...policy, [field]: checked ? [...policy[field], id] : policy[field].filter((value) => value !== id) };
  };
  const toggleWorkspace = (workspace: WriteWorkspaces, checked: boolean) => {
    policy = {
      ...policy,
      writeWorkspaces: checked
        ? [...policy.writeWorkspaces, workspace]
        : policy.writeWorkspaces.filter((value) => value !== workspace),
    };
  };
</script>

<div class="album-access">
  <fieldset {disabled}>
    <legend>{$t('frameleaf_connect_read_albums')}</legend>
    <p>{$t('frameleaf_connect_selection_help')}</p>
    {#if !original || original.allLibraryRead}
      <label
        ><input
          type="checkbox"
          checked={policy.allLibraryRead}
          onchange={(event) => (policy = { ...policy, allLibraryRead: event.currentTarget.checked })}
        />{$t('frameleaf_connect_all_read')}</label
      >
    {/if}
    {#if !policy.allLibraryRead}
      {#each destinations.filter((album) => !original || original.allLibraryRead || original.readAlbumIds.includes(album.id)) as album (album.id)}
        <label
          ><input
            type="checkbox"
            checked={policy.readAlbumIds.includes(album.id)}
            onchange={(event) => toggle('readAlbumIds', album.id, event.currentTarget.checked)}
          />{$t('frameleaf_connect_read_album', { values: { name: album.name } })}</label
        >
      {/each}
    {/if}
    {#if destinations.length === 0}<p>{$t('frameleaf_connect_no_albums')}</p>{/if}
  </fieldset>
  {#if canWrite}
    <fieldset {disabled}>
      <legend>{$t('frameleaf_connect_write_albums')}</legend>
      {#each destinations.filter((album) => !original || original.writableAlbumIds.includes(album.id)) as album (album.id)}
        <label
          ><input
            type="checkbox"
            disabled={!writable(album) && !policy.writableAlbumIds.includes(album.id)}
            checked={policy.writableAlbumIds.includes(album.id)}
            onchange={(event) => toggle('writableAlbumIds', album.id, event.currentTarget.checked)}
          />{$t('frameleaf_connect_write_album', { values: { name: album.name } })}</label
        >
      {/each}
      {#if scopes.includes('albums:write')}
        {#each [WriteWorkspaces.Photo, WriteWorkspaces.Design] as value (value)}
          {#if !original || original.writeWorkspaces.includes(value)}
            <label
              ><input
                type="checkbox"
                checked={policy.writeWorkspaces.includes(value)}
                onchange={(event) => toggleWorkspace(value, event.currentTarget.checked)}
              />{$t('frameleaf_connect_create_workspace', {
                values: { name: value === 'photo' ? 'Photos' : 'Boards' },
              })}</label
            >
          {/if}
        {/each}
      {/if}
      {#if !original}
        <Field
          label={$t('album_name')}
          value={albumName}
          onChange={(value) => (albumName = value)}
          disabled={disabled || creating}
        />
        <Select
          label={$t('frameleaf_connect_destination_workspace')}
          value={workspace || choices[0]}
          options={choices.map((value) => ({ value, label: value === 'photo' ? 'Photos' : 'Boards' }))}
          onChange={(value) => (workspace = value)}
          disabled={disabled || creating}
        />
        <Button disabled={disabled || creating || !albumName.trim()} onclick={createDestination}
          >{$t('create_album')}</Button
        >
      {/if}
    </fieldset>
  {/if}
  {#if original}<p>{$t('frameleaf_connect_narrow_help')}</p>{/if}
</div>

<style>
  .album-access,
  fieldset {
    display: grid;
    gap: var(--fl-space-3);
  }
  fieldset {
    margin: 0;
    padding: var(--fl-space-3);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
  }
  legend {
    padding: 0 var(--fl-space-2);
    font-weight: 600;
  }
  label {
    display: flex;
    align-items: start;
    gap: var(--fl-space-2);
    overflow-wrap: anywhere;
  }
  input {
    flex: none;
    margin-top: 0.25em;
    accent-color: var(--fl-accent);
  }
  p {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
</style>
