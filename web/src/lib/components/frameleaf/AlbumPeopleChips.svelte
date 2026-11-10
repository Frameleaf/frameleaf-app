<script lang="ts">
  /**
   * FL-809: the named people in an album, as chips under its header (prototype `App.jsx`
   * `.album-people`, approved in frameleaf-prototype PR 32). Choosing chips narrows the album to the
   * items that show everyone chosen: the library session's `personIds.all`, the condition the Filters
   * panel writes, so the time buckets, the count and Slideshow all follow it. "Clear people" puts the
   * whole album back. An album where nobody is named shows no row at all, unless people are still
   * chosen, when the row stays for Clear people.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import PersonAvatar from '$lib/components/frameleaf/PersonAvatar.svelte';
  import { librarySession, type LibrarySessionStore } from '$lib/frameleaf/library-session.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { getAlbumPeople, type AlbumPersonResponseDto, type PersonResponseDto } from '@frameleaf/sdk';
  import { t } from 'svelte-i18n';

  interface Props {
    albumId: string;
    /** Changes when the album's items change, so the people and their counts are read again. */
    refreshKey?: unknown;
    session?: LibrarySessionStore;
  }

  let { albumId, refreshKey, session = librarySession }: Props = $props();

  let people = $state<AlbumPersonResponseDto[]>([]);

  $effect(() => {
    const id = albumId;
    void refreshKey;
    const current = authManager.captureSession();
    const controller = new AbortController();
    people = [];
    getAlbumPeople({ id }, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted && current() && albumId === id) {
          people = result;
        }
      })
      // The chips are a shortcut: without them the album still shows everything, so a failed read draws no row.
      .catch(() => {});
    return () => controller.abort();
  });

  const selected = $derived(session.query.filter.personIds?.all ?? []);

  const setSelected = (ids: string[]) => {
    const query = session.query;
    if (ids.length === 0) {
      session.removeFilter('personIds');
      return;
    }
    session.setQuery({ ...query, filter: { ...query.filter, personIds: { all: ids } } });
  };

  const toggle = (id: string) =>
    setSelected(selected.includes(id) ? selected.filter((each) => each !== id) : [...selected, id]);

  /** What the avatar needs of a person: their id for the face photo, the name for its fallback initial. */
  const asPerson = ({ id, name, updatedAt }: AlbumPersonResponseDto): PersonResponseDto => ({
    id,
    name,
    updatedAt,
    birthDate: null,
    thumbnailPath: '',
    isHidden: false,
  });
</script>

<!-- A choice still narrowing the album keeps the row, so it can always be cleared, even once the
     people it names are gone from the album or the list could not be read. -->
{#if people.length > 0 || selected.length > 0}
  <section class="fl-album-people" aria-label={$t('frameleaf_album_people_title')}>
    <h2>{$t('frameleaf_album_people_title')}</h2>
    <div class="fl-album-people-chips">
      {#each people as person (person.id)}
        <Button pressed={selected.includes(person.id)} onclick={() => toggle(person.id)}>
          <PersonAvatar person={asPerson(person)} size={22} />
          {$t('frameleaf_album_people_chip', { values: { name: person.name, count: person.count } })}
        </Button>
      {/each}
      {#if selected.length > 0}
        <Button variant="quiet" onclick={() => setSelected([])}>{$t('frameleaf_album_people_clear')}</Button>
      {/if}
    </div>
  </section>
{/if}

<style>
  /* library-enhancements.css `.album-people`, with the app's minimum gaps between rows and controls. */
  .fl-album-people {
    padding: 8px 0 12px;
  }

  h2 {
    margin: 0 0 8px;
    font-size: var(--fl-font-small);
    font-weight: 600;
    color: var(--fl-text);
  }

  .fl-album-people-chips {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
</style>
