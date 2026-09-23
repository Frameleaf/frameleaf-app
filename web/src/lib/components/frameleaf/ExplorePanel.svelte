<script lang="ts">
  /**
   * Frameleaf Explore destination (FL-50).
   *
   * Ported from the approved prototype (`design/frameleaf/template/src/ExploreLibrary.jsx`),
   * but every section below is real, already-accessible data the route loader
   * (`explore/+page.ts`) gathered from production endpoints — `SearchService.getExploreData`
   * for people/cities/recent uploads, `BestPhotosService.getBestPhotos` for the quality-score
   * highlight, `AssetService`/`SearchService` statistics for the shortcut counts, the memory
   * manager for "Days to revisit", and the existing albums endpoint for "From your albums".
   * There is no local sample array and no rating-based fallback for Best Photos.
   */
  import AlbumCover from '$lib/components/album-page/AlbumCover.svelte';
  import PersonAvatar from '$lib/components/frameleaf/PersonAvatar.svelte';
  import type { ExploreBestPhotosPreview, ExploreShortcutCounts } from '$lib/frameleaf/explore';
  import { buildExploreShortcuts } from '$lib/frameleaf/explore';
  import { Route } from '$lib/route';
  import { getAssetMediaUrl } from '$lib/utils';
  import { getAltText } from '$lib/utils/thumbnail-util';
  import { toTimelineAsset } from '$lib/utils/timeline-util';
  import {
    AssetMediaSize,
    AssetTypeEnum,
    type AlbumResponseDto,
    type AssetResponseDto,
    type PersonResponseDto,
  } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import {
    mdiChevronRight,
    mdiClockOutline,
    mdiHistory,
    mdiImageMultipleOutline,
    mdiImageSearchOutline,
    mdiMovieOpenOutline,
    mdiStarOutline,
  } from '@mdi/js';
  import { t } from 'svelte-i18n';

  export interface ExplorePlaceCard {
    value: string;
    data: AssetResponseDto;
  }

  export interface ExploreMemoryCard {
    id: string;
    title: string;
    href: string;
    alt: string;
    src: string;
  }

  interface Props {
    people: PersonResponseDto[];
    places: ExplorePlaceCard[];
    recents: AssetResponseDto[];
    memories: ExploreMemoryCard[];
    albums: AlbumResponseDto[];
    bestPhotos: ExploreBestPhotosPreview;
    shortcutCounts: ExploreShortcutCounts;
    onViewAsset: (id: string) => void;
  }

  let { people, places, recents, memories, albums, bestPhotos, shortcutCounts, onViewAsset }: Props = $props();

  const shortcuts = $derived(buildExploreShortcuts(shortcutCounts));

  const hasAnything = $derived(
    people.length > 0 || places.length > 0 || recents.length > 0 || memories.length > 0 || albums.length > 0,
  );

  const altTextFor = (asset: AssetResponseDto) => $getAltText(toTimelineAsset(asset));
</script>

<div class="explore">
  <header class="explore-header">
    <h1>{$t('explore')}</h1>
    <p>{$t('frameleaf_explore_intro')}</p>
  </header>

  {#if !hasAnything}
    <div class="explore-empty" role="status">
      <Icon icon={mdiImageSearchOutline} size={32} aria-hidden="true" />
      <p>{$t('no_explore_results_message')}</p>
    </div>
  {:else}
    {#if people.length > 0}
      <section class="explore-section" aria-labelledby="explore-people-heading">
        <div class="explore-section-heading">
          <h2 id="explore-people-heading">{$t('people')}</h2>
          <a href={Route.people()}>
            {$t('view_all')}
            <Icon icon={mdiChevronRight} size={16} aria-hidden="true" />
          </a>
        </div>
        <div class="explore-people">
          {#each people.slice(0, 12) as person (person.id)}
            <a href={Route.viewPerson(person)} class="explore-person">
              <PersonAvatar {person} size={88} />
              <strong>{person.name}</strong>
            </a>
          {/each}
        </div>
      </section>
    {/if}

    <section class="explore-section" aria-label={$t('frameleaf_explore_highlights_label')}>
      <div class="explore-highlights">
        <a class="explore-best" href={Route.bestPhotos()}>
          {#if bestPhotos.cover}
            <img src={getAssetMediaUrl({ id: bestPhotos.cover.id, size: AssetMediaSize.Thumbnail })} alt="" loading="lazy" />
          {:else}
            <div class="explore-cover-empty"><Icon icon={mdiImageMultipleOutline} size={28} aria-hidden="true" /></div>
          {/if}
          <span class="explore-cover-shade"></span>
          <span class="explore-best-copy">
            <span class="explore-overline"><Icon icon={mdiStarOutline} size={16} aria-hidden="true" /> {$t('best_photos')}</span>
            <strong>{$t('frameleaf_explore_highlight_copy')}</strong>
            <small>
              {#if bestPhotos.total === null}
                {$t('frameleaf_explore_highlight_loading')}
              {:else if bestPhotos.total > 0}
                {$t('frameleaf_explore_highlight_ready', { values: { count: bestPhotos.total } })}
              {:else}
                {$t('frameleaf_explore_highlight_empty')}
              {/if}
            </small>
          </span>
          <span class="explore-cover-arrow"><Icon icon={mdiChevronRight} aria-hidden="true" /></span>
        </a>
        <div class="explore-shortcuts">
          {#each shortcuts as shortcut (shortcut.id)}
            <a href={shortcut.href}>
              <span class="explore-shortcut-icon"><Icon icon={shortcut.icon} size={20} aria-hidden="true" /></span>
              <span>
                <strong>{$t(shortcut.labelKey)}</strong>
                <small>
                  {shortcut.count === null
                    ? $t('frameleaf_explore_highlight_loading')
                    : $t('frameleaf_explore_item_count', { values: { count: shortcut.count } })}
                </small>
              </span>
              <Icon icon={mdiChevronRight} size={16} aria-hidden="true" />
            </a>
          {/each}
        </div>
      </div>
    </section>

    {#if places.length > 0}
      <section class="explore-section" aria-labelledby="explore-places-heading">
        <div class="explore-section-heading">
          <h2 id="explore-places-heading">{$t('places')}</h2>
          <a href={Route.places()}>
            {$t('view_all')}
            <Icon icon={mdiChevronRight} size={16} aria-hidden="true" />
          </a>
        </div>
        <div class="explore-places">
          {#each places.slice(0, 8) as place (place.data.id)}
            <a href={Route.search({ city: place.value })} class="explore-place">
              <img
                src={getAssetMediaUrl({ id: place.data.id, size: AssetMediaSize.Thumbnail })}
                alt=""
                loading="lazy"
              />
              <span class="explore-cover-shade"></span>
              <span>{place.value}</span>
            </a>
          {/each}
        </div>
      </section>
    {/if}

    {#if memories.length > 0}
      <section class="explore-section" aria-labelledby="explore-memories-heading">
        <div class="explore-section-heading">
          <h2 id="explore-memories-heading">{$t('frameleaf_explore_days_to_revisit')}</h2>
          <a href={Route.memories()}>
            {$t('view_all')}
            <Icon icon={mdiChevronRight} size={16} aria-hidden="true" />
          </a>
        </div>
        <div class="explore-memory-row">
          {#each memories as memory (memory.id)}
            <a href={memory.href}>
              <img src={memory.src} alt={memory.alt} loading="lazy" />
              <span class="explore-cover-shade"></span>
              <span class="explore-memory-copy">
                <Icon icon={mdiHistory} size={14} aria-hidden="true" />
                <strong>{memory.title}</strong>
              </span>
            </a>
          {/each}
        </div>
      </section>
    {/if}

    {#if albums.length > 0}
      <section class="explore-section" aria-labelledby="explore-albums-heading">
        <div class="explore-section-heading">
          <h2 id="explore-albums-heading">{$t('frameleaf_explore_from_your_albums')}</h2>
          <a href={Route.albums()}>
            {$t('view_all')}
            <Icon icon={mdiChevronRight} size={16} aria-hidden="true" />
          </a>
        </div>
        <div class="explore-albums">
          {#each albums.slice(0, 6) as album (album.id)}
            <a href={Route.viewAlbum({ id: album.id })} class="explore-album">
              <AlbumCover {album} class="explore-album-cover" />
              <span>
                <strong>{album.albumName}</strong>
                <small>{$t('frameleaf_explore_item_count', { values: { count: album.assetCount } })}</small>
              </span>
              <Icon icon={mdiChevronRight} size={16} aria-hidden="true" />
            </a>
          {/each}
        </div>
      </section>
    {/if}

    {#if recents.length > 0}
      <section class="explore-section" aria-labelledby="explore-recent-heading">
        <div class="explore-section-heading">
          <h2 id="explore-recent-heading">{$t('recently_added')}</h2>
          <a href={Route.recentlyAdded()}>
            {$t('view_all')}
            <Icon icon={mdiChevronRight} size={16} aria-hidden="true" />
          </a>
        </div>
        <div class="explore-recent">
          {#each recents.slice(0, 8) as asset (asset.id)}
            <button type="button" onclick={() => onViewAsset(asset.id)} aria-label={altTextFor(asset)}>
              <img
                src={getAssetMediaUrl({ id: asset.id, size: AssetMediaSize.Thumbnail })}
                alt=""
                loading="lazy"
              />
              {#if asset.type === AssetTypeEnum.Video}
                <span class="explore-media-label"><Icon icon={mdiMovieOpenOutline} size={14} aria-hidden="true" /></span>
              {/if}
            </button>
          {/each}
        </div>
      </section>
    {/if}

    <div class="explore-more">
      <a href={Route.memories()}>
        <Icon icon={mdiHistory} aria-hidden="true" />
        <span>{$t('memories')}</span>
        <Icon icon={mdiChevronRight} size={16} aria-hidden="true" />
      </a>
      <a href={Route.recentlyAdded()}>
        <Icon icon={mdiClockOutline} aria-hidden="true" />
        <span>{$t('recently_added')}</span>
        <Icon icon={mdiChevronRight} size={16} aria-hidden="true" />
      </a>
    </div>
  {/if}
</div>

<style>
  .explore {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    color: var(--fl-text);
    padding-block-end: 1.5rem;
  }
  .explore-header h1 {
    font-size: 1.375rem;
  }
  .explore-header p {
    margin: 0.125rem 0 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .explore-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    padding: 3rem 1rem;
    color: var(--fl-muted);
    text-align: center;
  }
  .explore-section-heading {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-block-end: 0.625rem;
  }
  .explore-section-heading h2 {
    font-size: 1rem;
    margin: 0;
  }
  .explore-section-heading a {
    display: inline-flex;
    align-items: center;
    gap: 0.125rem;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    text-decoration: none;
  }
  .explore-section-heading a:hover {
    color: var(--fl-accent);
  }
  .explore-people {
    display: flex;
    gap: 1rem;
    overflow-x: auto;
    padding-block-end: 0.25rem;
  }
  .explore-person {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.375rem;
    flex-shrink: 0;
    width: 5.5rem;
    text-align: center;
    text-decoration: none;
    color: var(--fl-text);
  }
  .explore-person strong {
    font-size: var(--fl-font-small);
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
  }
  .explore-highlights {
    display: grid;
    grid-template-columns: minmax(16rem, 1.4fr) 1fr;
    gap: 0.75rem;
  }
  @media (max-width: 56rem) {
    .explore-highlights {
      grid-template-columns: 1fr;
    }
  }
  .explore-best {
    position: relative;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    min-height: 10rem;
    border-radius: var(--fl-radius-card);
    overflow: hidden;
    background: var(--fl-raised);
    text-decoration: none;
    color: inherit;
  }
  .explore-best img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .explore-cover-empty {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--fl-muted);
    background: var(--fl-raised);
  }
  .explore-cover-shade {
    position: absolute;
    inset: 0;
    background: linear-gradient(to top, rgb(0 0 0 / 65%), transparent 60%);
  }
  .explore-best-copy {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    padding: 0.875rem;
    color: #fff;
  }
  .explore-overline {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    font-size: var(--fl-font-small);
    text-transform: uppercase;
    letter-spacing: 0.03em;
    opacity: 0.85;
  }
  .explore-best-copy strong {
    font-size: 1.0625rem;
  }
  .explore-best-copy small {
    opacity: 0.85;
  }
  .explore-cover-arrow {
    position: absolute;
    inset-block-start: 0.75rem;
    inset-inline-end: 0.75rem;
    color: #fff;
  }
  .explore-shortcuts {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.5rem;
  }
  .explore-shortcuts a {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.625rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
    color: var(--fl-text);
    text-decoration: none;
  }
  .explore-shortcuts a:hover {
    background: var(--fl-raised);
  }
  .explore-shortcuts strong {
    display: block;
    font-size: var(--fl-font-small);
    font-weight: 500;
  }
  .explore-shortcuts small {
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
  }
  .explore-shortcut-icon {
    display: inline-flex;
    color: var(--fl-accent);
  }
  .explore-shortcuts a > span:nth-child(2) {
    flex: 1 1 auto;
    min-width: 0;
  }
  .explore-places,
  .explore-albums,
  .explore-recent {
    display: flex;
    gap: 0.625rem;
    overflow-x: auto;
    padding-block-end: 0.25rem;
  }
  .explore-place {
    position: relative;
    flex-shrink: 0;
    width: 7rem;
    height: 7rem;
    border-radius: var(--fl-radius-card);
    overflow: hidden;
    color: #fff;
    text-decoration: none;
  }
  .explore-place img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .explore-place span:last-child {
    position: absolute;
    inset-inline: 0;
    inset-block-end: 0.375rem;
    text-align: center;
    font-size: var(--fl-font-small);
    text-transform: capitalize;
  }
  .explore-memory-row {
    display: flex;
    gap: 0.625rem;
    overflow-x: auto;
    padding-block-end: 0.25rem;
  }
  .explore-memory-row a {
    position: relative;
    flex-shrink: 0;
    width: 11rem;
    height: 7rem;
    border-radius: var(--fl-radius-card);
    overflow: hidden;
    color: #fff;
    text-decoration: none;
  }
  .explore-memory-row img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .explore-memory-copy {
    position: absolute;
    inset-inline: 0.625rem;
    inset-block-end: 0.5rem;
    display: flex;
    align-items: center;
    gap: 0.25rem;
    font-size: var(--fl-font-small);
  }
  .explore-album {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    flex-shrink: 0;
    width: 8rem;
    text-decoration: none;
    color: var(--fl-text);
  }
  .explore-album :global(.explore-album-cover) {
    width: 8rem;
    height: 8rem;
    border-radius: var(--fl-radius-card);
    object-fit: cover;
  }
  .explore-album strong {
    display: block;
    font-size: var(--fl-font-small);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .explore-album small {
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
  }
  .explore-recent button {
    position: relative;
    flex-shrink: 0;
    width: 6.5rem;
    height: 6.5rem;
    padding: 0;
    border: 0;
    border-radius: var(--fl-radius);
    overflow: hidden;
    background: var(--fl-raised);
  }
  .explore-recent img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .explore-media-label {
    position: absolute;
    inset-block-start: 0.25rem;
    inset-inline-end: 0.25rem;
    display: inline-flex;
    padding: 0.125rem;
    border-radius: var(--fl-radius);
    background: rgb(0 0 0 / 55%);
    color: #fff;
  }
  .explore-more {
    display: flex;
    gap: 0.625rem;
  }
  .explore-more a {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.625rem 0.875rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
    color: var(--fl-text);
    text-decoration: none;
  }
  .explore-more a:hover {
    background: var(--fl-raised);
  }
  .explore-more span {
    font-size: var(--fl-font-small);
  }
</style>
