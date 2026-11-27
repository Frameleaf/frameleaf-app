<script lang="ts">
  /**
   * FL-1837: on the Albums page, a one-time offer for a folder that made an album for every folder of a folder-by-event
   * layout (the approved prototype's Albums page notice): "One album for each event" changes them to match, "Choose
   * how…" opens the folder's page, "Not now" hides the offer for that folder on this device. Undo puts the rules back,
   * and the albums follow at the next sync. Only an administrator can change a folder, so only they see it.
   */
  import { goto } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import { EVENT_FOLDER_ALBUM_OPTIONS } from '$lib/frameleaf/folder-albums';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Route } from '$lib/route';
  import { handleError } from '$lib/utils/handle-error';
  import {
    FolderAlbumExisting,
    getFolderAlbumSuggestions,
    updateLibrary,
    type FolderAlbumSuggestionDto,
  } from '@frameleaf/sdk';
  import { mdiFolderMultipleOutline } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  let { onChanged }: { onChanged?: () => void } = $props();

  const dismissedKey = (libraryId: string) => `frameleaf.folderAlbumsNotice.${libraryId}`;

  let suggestion = $state<FolderAlbumSuggestionDto | undefined>();
  let done = $state(false);
  let busy = $state(false);

  onMount(async () => {
    if (!authManager.user?.isAdmin) {
      return;
    }
    try {
      const suggestions = await getFolderAlbumSuggestions();
      suggestion = suggestions.find(({ libraryId }) => !localStorage.getItem(dismissedKey(libraryId)));
    } catch {
      // the offer is a nicety: the Albums page works the same without it
    }
  });

  const apply = async (folderAlbumOptions: FolderAlbumSuggestionDto['options'], after: boolean) => {
    if (!suggestion) {
      return;
    }
    busy = true;
    try {
      await updateLibrary({
        id: suggestion.libraryId,
        updateLibraryDto: { folderAlbumOptions, folderAlbumExisting: FolderAlbumExisting.Match },
      });
      done = after;
      onChanged?.();
      if (!after) {
        // Undo: the rules are back as they were, and the offer is not made again
        notNow();
      }
    } catch (error) {
      handleError(error, $t('frameleaf_libraries_error_save'));
    } finally {
      busy = false;
    }
  };

  const notNow = () => {
    if (suggestion) {
      localStorage.setItem(dismissedKey(suggestion.libraryId), '1');
    }
    suggestion = undefined;
  };
</script>

{#if suggestion}
  <div class="folder-albums-notice" data-testid="folder-albums-notice">
    {#if done}
      <Notice icon={mdiFolderMultipleOutline} title={$t('frameleaf_folder_albums_notice_done')}>
        {#snippet action()}
          <Button disabled={busy} onclick={() => apply(suggestion!.options, false)}>{$t('undo')}</Button>
          <Button variant="quiet" onclick={notNow}>{$t('close')}</Button>
        {/snippet}
      </Notice>
    {:else}
      <Notice
        icon={mdiFolderMultipleOutline}
        title={$t('frameleaf_folder_albums_notice_title', {
          values: { name: suggestion.name, albums: suggestion.albums, empty: suggestion.empty },
        })}
      >
        {$t('frameleaf_folder_albums_notice_body', { values: { count: suggestion.suggestedAlbums } })}
        {#snippet action()}
          <Button variant="primary" disabled={busy} onclick={() => apply(EVENT_FOLDER_ALBUM_OPTIONS, true)}>
            {$t('frameleaf_folder_albums_notice_events')}
          </Button>
          <Button onclick={() => goto(Route.viewLibrary({ id: suggestion!.libraryId }))}>
            {$t('frameleaf_folder_albums_notice_choose')}
          </Button>
          <Button variant="quiet" onclick={notNow}>{$t('frameleaf_folder_albums_notice_later')}</Button>
        {/snippet}
      </Notice>
    {/if}
  </div>
{/if}

<style>
  .folder-albums-notice {
    padding: var(--fl-space-4) var(--fl-space-6) 0;
  }
  @media (max-width: 767px) {
    .folder-albums-notice {
      padding: var(--fl-space-4) var(--fl-space-4) 0;
    }
  }
</style>
