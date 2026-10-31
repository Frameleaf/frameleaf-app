<script lang="ts">
  /**
   * FL-522, after the prototype's "Your smart albums" (`settings-v2/care/albums.jsx`): the smart albums
   * offered on this server, each with how many of your photos it holds as you see them and a few of the
   * newest, and a switch to hide it from your own library. Hiding is yours alone; the album keeps
   * filling, and showing it again brings it back as it is.
   */
  import Item from '$lib/components/frameleaf/settings/kit/Item.svelte';
  import ItemList from '$lib/components/frameleaf/settings/kit/ItemList.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Switch from '$lib/components/frameleaf/settings/kit/Switch.svelte';
  import Thumbs from '$lib/components/frameleaf/settings/kit/Thumbs.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import { getMySmartAlbums, setMySmartAlbumHidden, type MySmartAlbumsResponseDto } from '@frameleaf/sdk';
  import { mdiImageAlbum } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  let { description }: { description?: string } = $props();

  let mine = $state<MySmartAlbumsResponseDto>();
  let saving = $state<string>();

  onMount(() => {
    void (async () => {
      try {
        mine = await getMySmartAlbums();
      } catch {
        // without an answer the section is left out
      }
    })();
  });

  const setShown = async (kind: string, shown: boolean) => {
    saving = kind;
    try {
      mine = await setMySmartAlbumHidden({ kind, smartAlbumHiddenDto: { hidden: !shown } });
    } catch (error) {
      handleError(error, $t('frameleaf_my_albums_failed'));
    } finally {
      saving = undefined;
    }
  };
</script>

{#if mine?.enabled && mine.albums.length > 0}
  <Section title={$t('frameleaf_my_albums_title')} description={description ?? $t('frameleaf_my_albums_description')}>
    <ItemList>
      {#each mine.albums as album (album.kind)}
        <Item
          icon={mdiImageAlbum}
          off={album.hidden}
          name={album.name}
          tone={album.hidden ? 'off' : 'good'}
          status={album.hidden
            ? $t('frameleaf_my_albums_hidden')
            : $t('frameleaf_my_albums_count', { values: { count: album.count } })}
          note={album.hidden ? $t('frameleaf_my_albums_hidden_note') : undefined}
        >
          {#snippet measure()}
            <div class="inline">
              {#if !album.hidden}
                <Thumbs
                  ids={album.samples}
                  label={$t('frameleaf_my_albums_samples', { values: { name: album.name } })}
                />
              {/if}
              <Switch
                label={$t('frameleaf_my_albums_show', { values: { name: album.name } })}
                checked={!album.hidden}
                held={saving === album.kind}
                onChange={(value) => setShown(album.kind, value)}
              />
            </div>
          {/snippet}
        </Item>
      {/each}
    </ItemList>
  </Section>
{/if}

<style>
  .inline {
    display: flex;
    align-items: center;
    gap: var(--fl-space-3);
  }
</style>
