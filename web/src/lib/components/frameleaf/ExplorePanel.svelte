<script lang="ts">
  /**
   * Frameleaf Explore destination (FL-50, T-12).
   *
   * Ported from the approved prototype (`design/frameleaf/template/src/ExploreLibrary.jsx`,
   * `explore-library.css`, the snapping carousels of `apple-style.css` "#5"), but every section
   * below is real, already-accessible data the route loader (`explore/+page.ts`) gathered from
   * production endpoints: `POST /search/facets` counts People, Places and "Things in your photos"
   * in the same scope as the search each card opens, `BestPhotosService.getBestPhotos` gives the
   * quality-score highlight, `AssetService`/`SearchService` statistics the shortcut counts, the
   * memory manager "Days to revisit", the albums endpoint "From your albums", and a capture-date
   * metadata search "Recent captures". There is no local sample array and no rating-based fallback
   * for Best Photos.
   */
  import AlbumCover from '$lib/components/album-page/AlbumCover.svelte';
  import PersonAvatar from '$lib/components/frameleaf/PersonAvatar.svelte';
  import type {
    ExploreBestPhotosPreview,
    ExploreCoverCard,
    ExplorePersonCard,
    ExploreShortcutCounts,
  } from '$lib/frameleaf/explore';
  import { buildExploreShortcuts, captureDay, isVideoAsset } from '$lib/frameleaf/explore';
  import { Route } from '$lib/route';
  import { getAssetMediaUrl } from '$lib/utils';
  import { AssetMediaSize, type AlbumResponseDto, type AssetResponseDto } from '@immich/sdk';
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

  export interface ExploreMemoryCard {
    id: string;
    title: string;
    href: string;
    alt: string;
    src: string;
    count: number;
  }

  interface Props {
    people: ExplorePersonCard[];
    places: ExploreCoverCard[];
    things: ExploreCoverCard[];
    /** Newest captures first (not uploads). */
    recents: AssetResponseDto[];
    memories: ExploreMemoryCard[];
    albums: AlbumResponseDto[];
    bestPhotos: ExploreBestPhotosPreview;
    shortcutCounts: ExploreShortcutCounts;
    /** Items the account can see in the library, when known; 0 shows the empty state. */
    libraryTotal?: number | null;
    onViewAsset: (id: string) => void;
  }

  let {
    people,
    places,
    things,
    recents,
    memories,
    albums,
    bestPhotos,
    shortcutCounts,
    libraryTotal = null,
    onViewAsset,
  }: Props = $props();

  const shortcuts = $derived(buildExploreShortcuts(shortcutCounts));

  const hasAnything = $derived(
    libraryTotal === null
      ? people.length > 0 ||
          places.length > 0 ||
          things.length > 0 ||
          recents.length > 0 ||
          memories.length > 0 ||
          albums.length > 0
      : libraryTotal > 0,
  );

  const countLabel = (count: number) => $t('frameleaf_explore_item_count', { values: { count } });
  const thumbnail = (id: string) => getAssetMediaUrl({ id, size: AssetMediaSize.Thumbnail });
  const nameOf = (asset: AssetResponseDto) => asset.originalFileName;
</script>

{#snippet heading(id: string, title: string, href?: string)}
  <div class="el-section-heading">
    <h2 {id}>{title}</h2>
    {#if href}
      <a {href}>
        {$t('frameleaf_explore_view_all')}
        <Icon icon={mdiChevronRight} size="16" aria-hidden="true" />
      </a>
    {/if}
  </div>
{/snippet}

{#snippet cover(assetId: string | null | undefined)}
  {#if assetId}
    <img src={thumbnail(assetId)} alt="" loading="lazy" />
  {:else}
    <span class="el-cover-empty"><Icon icon={mdiImageMultipleOutline} size="28" aria-hidden="true" /></span>
  {/if}
{/snippet}

<div class="explore-library">
  <header class="el-header">
    <h1>{$t('explore')}</h1>
    <p>{$t('frameleaf_explore_intro')}</p>
  </header>

  {#if !hasAnything}
    <!--
      The prototype's empty state (ExploreLibrary.jsx:60-66) speaks of albums and filters, which
      production Explore does not have: here it is only ever an empty library, so the same pattern
      and tone point at uploading instead.
    -->
    <div class="el-empty" role="status">
      <Icon icon={mdiImageSearchOutline} size="32" aria-hidden="true" />
      <h2>{$t('frameleaf_explore_empty_title')}</h2>
      <p>{$t('frameleaf_explore_empty_body')}</p>
    </div>
  {:else}
    {#if people.length > 0}
      <section class="el-section" aria-labelledby="explore-people-heading">
        {@render heading('explore-people-heading', $t('people'), Route.people())}
        <div class="el-people">
          {#each people as item (item.id)}
            <a href={item.href} class="el-person">
              <PersonAvatar person={item.person} size={88} />
              <strong>{item.label}</strong>
              <small>{countLabel(item.count)}</small>
            </a>
          {/each}
        </div>
      </section>
    {/if}

    <section class="el-section" aria-label={$t('frameleaf_explore_highlights_label')}>
      <div class="el-highlights">
        <a class="el-best fl-continuous-corners" href={Route.bestPhotos()}>
          {@render cover(bestPhotos.cover?.id)}
          <span class="el-cover-shade"></span>
          <span class="el-best-copy">
            <span class="el-overline"
              ><Icon icon={mdiStarOutline} size="16" aria-hidden="true" /> {$t('best_photos')}</span
            >
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
          <span class="el-cover-arrow"><Icon icon={mdiChevronRight} aria-hidden="true" /></span>
        </a>
        <div class="el-shortcuts">
          {#each shortcuts as shortcut (shortcut.id)}
            <a class="el-shortcut" href={shortcut.href}>
              <span class="el-shortcut-icon"><Icon icon={shortcut.icon} size="20" aria-hidden="true" /></span>
              <span>
                <strong>{$t(shortcut.labelKey)}</strong>
                <small>
                  {shortcut.count === null ? $t('frameleaf_explore_highlight_loading') : countLabel(shortcut.count)}
                </small>
              </span>
              <Icon icon={mdiChevronRight} size="16" aria-hidden="true" />
            </a>
          {/each}
        </div>
      </div>
    </section>

    {#if places.length > 0}
      <section class="el-section" aria-labelledby="explore-places-heading">
        {@render heading('explore-places-heading', $t('places'), Route.places())}
        <div class="el-places">
          {#each places as place (place.id)}
            <a href={place.href} class="el-place fl-continuous-corners">
              {@render cover(place.coverAssetId)}
              <span class="el-cover-shade"></span>
              <span>
                <strong>{place.label}</strong>
                <small>{countLabel(place.count)}</small>
              </span>
            </a>
          {/each}
        </div>
      </section>
    {/if}

    {#if memories.length > 0}
      <section class="el-section" aria-labelledby="explore-memories-heading">
        {@render heading('explore-memories-heading', $t('frameleaf_explore_days_to_revisit'), Route.memories())}
        <div class="el-memory-row">
          {#each memories as memory (memory.id)}
            <a href={memory.href}>
              <img src={memory.src} alt={memory.alt} loading="lazy" />
              <span class="el-cover-shade"></span>
              <span class="el-memory-copy">
                <strong>{memory.title}</strong>
                <small>{countLabel(memory.count)}</small>
              </span>
            </a>
          {/each}
        </div>
      </section>
    {/if}

    {#if things.length > 0}
      <section class="el-section" aria-labelledby="explore-things-heading">
        {@render heading('explore-things-heading', $t('frameleaf_explore_things'))}
        <div class="el-things">
          {#each things as thing (thing.id)}
            <a href={thing.href}>
              {@render cover(thing.coverAssetId)}
              <span>
                <strong>{thing.label}</strong>
                <small>{countLabel(thing.count)}</small>
              </span>
              <Icon icon={mdiChevronRight} size="16" aria-hidden="true" />
            </a>
          {/each}
        </div>
      </section>
    {/if}

    {#if albums.length > 0}
      <section class="el-section" aria-labelledby="explore-albums-heading">
        {@render heading('explore-albums-heading', $t('frameleaf_explore_from_your_albums'))}
        <div class="el-collections">
          {#each albums as album (album.id)}
            <a href={Route.viewAlbum({ id: album.id })}>
              <AlbumCover {album} class="el-album-cover" />
              <span>
                <strong>{album.albumName || $t('unnamed_album')}</strong>
                <small>{countLabel(album.assetCount)}</small>
              </span>
              <Icon icon={mdiChevronRight} size="16" aria-hidden="true" />
            </a>
          {/each}
        </div>
      </section>
    {/if}

    {#if recents.length > 0}
      <section class="el-section" aria-labelledby="explore-recent-heading">
        {@render heading('explore-recent-heading', $t('frameleaf_explore_recent_captures'))}
        <div class="el-recent">
          {#each recents as asset (asset.id)}
            <button
              type="button"
              onclick={() => onViewAsset(asset.id)}
              aria-label={$t('frameleaf_explore_open_item', { values: { name: nameOf(asset) } })}
            >
              <img src={thumbnail(asset.id)} alt="" loading="lazy" />
              <span>{nameOf(asset)}</span>
              {#if isVideoAsset(asset)}
                <span class="el-media-label">
                  <Icon icon={mdiMovieOpenOutline} size="14" aria-hidden="true" />
                  {$t('video')}
                </span>
              {/if}
              <small>{captureDay(asset) ?? $t('frameleaf_explore_date_unknown')}</small>
            </button>
          {/each}
        </div>
      </section>
    {/if}

    <div class="el-more">
      <a href={Route.memories()}>
        <Icon icon={mdiHistory} aria-hidden="true" />
        <span>{$t('memories')}</span>
        <Icon icon={mdiChevronRight} size="16" aria-hidden="true" />
      </a>
      <a href={Route.recentlyAdded()}>
        <Icon icon={mdiClockOutline} aria-hidden="true" />
        <span>{$t('recently_added')}</span>
        <Icon icon={mdiChevronRight} size="16" aria-hidden="true" />
      </a>
    </div>
  {/if}
</div>

<style>
  /* explore-library.css, with apple-style.css's card radius, continuous corners and "#5 snapping carousels". */
  .explore-library {
    width: 100%;
    max-width: 1400px;
    min-width: 0;
    box-sizing: border-box;
    margin: 0 auto;
    padding: 26px 30px 36px;
    color: var(--fl-text);
  }
  .explore-library a,
  .explore-library button {
    font: inherit;
    color: inherit;
    text-decoration: none;
    cursor: pointer;
  }
  .explore-library :focus-visible {
    outline: 2px solid var(--fl-accent);
    outline-offset: 4px;
  }
  .explore-library h1 {
    margin: 0;
    font-size: 26px;
    font-weight: 600;
    letter-spacing: -0.035em;
  }
  .el-header {
    margin-bottom: 28px;
  }
  .el-header p {
    margin: 8px 0 0;
    color: var(--fl-muted);
    font-size: 13px;
    line-height: 1.6;
  }
  .el-section {
    min-width: 0;
    margin: 0 0 28px;
  }
  .el-section-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 14px;
  }
  .explore-library h2 {
    margin: 0;
    font-size: 15px;
    font-weight: 580;
  }
  .el-section-heading a {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 5px 0 5px 8px;
    color: var(--fl-muted);
    font-size: 12px;
  }
  .el-section-heading a:hover {
    color: var(--fl-text);
  }
  .explore-library strong {
    font-weight: 560;
  }
  .explore-library small {
    color: var(--fl-muted);
    font-size: 11px;
    font-weight: 400;
  }
  .el-people {
    display: flex;
    gap: 22px;
    overflow: auto;
    padding: 4px 4px 10px;
  }
  .el-person {
    display: flex;
    flex: 0 0 92px;
    flex-direction: column;
    align-items: center;
    gap: 7px;
    min-width: 0;
    text-align: center;
  }
  .el-person strong {
    max-width: 100%;
    overflow: hidden;
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .el-person small {
    margin-top: -2px;
  }
  .el-highlights {
    display: grid;
    grid-template-columns: minmax(0, 1.25fr) minmax(260px, 1fr);
    gap: 18px;
  }
  .el-best {
    position: relative;
    display: block;
    min-height: 220px;
    overflow: hidden;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-raised);
    text-align: left;
  }
  .explore-library .el-best {
    color: white;
  }
  .el-best > img,
  .el-place > img,
  .el-best > .el-cover-empty,
  .el-place > .el-cover-empty {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .el-cover-shade {
    position: absolute;
    inset: 0;
    background: linear-gradient(180deg, transparent 20%, rgb(0 0 0 / 72%));
    pointer-events: none;
  }
  .el-best-copy {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 90px 24px 22px;
  }
  .el-best-copy > strong {
    max-width: 24ch;
    font-size: 23px;
    line-height: 1.2;
    letter-spacing: -0.025em;
  }
  .explore-library .el-best-copy small {
    color: #e3e7e5;
  }
  .el-overline {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 12px;
  }
  .el-cover-arrow {
    position: absolute;
    right: 15px;
    bottom: 20px;
  }
  .el-shortcuts {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }
  .el-shortcut {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
    padding: 16px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
    text-align: left;
  }
  .el-shortcut > span:nth-child(2) {
    flex: 1;
    min-width: 0;
  }
  .el-shortcut strong,
  .el-shortcut small {
    display: block;
  }
  .el-shortcut strong {
    font-size: 12px;
  }
  .el-shortcut small {
    margin-top: 6px;
  }
  .el-shortcut-icon {
    display: inline-flex;
    color: var(--fl-muted);
  }
  .el-places {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
    gap: 14px;
  }
  .el-place {
    position: relative;
    display: block;
    min-height: 180px;
    overflow: hidden;
    border-radius: var(--fl-radius-card);
    background: var(--fl-raised);
    text-align: left;
  }
  .explore-library .el-place {
    color: white;
  }
  .el-place > span:last-child {
    position: absolute;
    right: 16px;
    bottom: 14px;
    left: 16px;
  }
  .el-place strong,
  .el-place small {
    display: block;
  }
  .el-place strong {
    font-size: 15px;
    text-transform: capitalize;
  }
  .explore-library .el-place small {
    margin-top: 5px;
    color: #e3e7e5;
  }
  .el-memory-row {
    display: grid;
    grid-auto-columns: minmax(180px, 1fr);
    grid-auto-flow: column;
    gap: 12px;
    overflow-x: auto;
    padding-bottom: 6px;
  }
  .el-memory-row a {
    position: relative;
    display: block;
    min-height: 205px;
    overflow: hidden;
    border-radius: var(--fl-radius-card);
    background: var(--fl-raised);
    text-align: left;
  }
  .el-memory-row img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .el-memory-copy {
    position: absolute;
    right: 14px;
    bottom: 16px;
    left: 14px;
    color: white;
  }
  .el-memory-copy strong {
    display: block;
    font-size: 13px;
    line-height: 1.5;
  }
  .explore-library .el-memory-copy small {
    display: block;
    margin-top: 5px;
    color: #e3e7e5;
  }
  .el-things,
  .el-collections {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(205px, 1fr));
    gap: 10px;
  }
  .el-things a,
  .el-collections a {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
    overflow: hidden;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
    text-align: left;
  }
  .el-things img,
  .el-things .el-cover-empty,
  .el-collections :global(.el-album-cover) {
    flex: 0 0 62px;
    width: 62px;
    height: 62px;
    object-fit: cover;
  }
  .el-things a > span:not(.el-cover-empty),
  .el-collections a > span {
    flex: 1;
    min-width: 0;
  }
  .el-things a > :global(svg),
  .el-collections a > :global(svg) {
    flex: 0 0 auto;
    margin-right: 12px;
    color: var(--fl-muted);
  }
  .el-things strong,
  .el-collections strong {
    display: block;
    overflow: hidden;
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .el-things strong {
    text-transform: capitalize;
  }
  .el-things small,
  .el-collections small {
    display: block;
    margin-top: 4px;
  }
  .el-recent {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 14px;
  }
  .el-recent button {
    position: relative;
    min-width: 0;
    padding: 0;
    border: 0;
    background: none;
    text-align: left;
  }
  .el-recent img {
    display: block;
    width: 100%;
    aspect-ratio: 1.45;
    object-fit: cover;
    border-radius: var(--fl-radius);
  }
  .el-recent button > span:not(.el-media-label) {
    display: block;
    margin-top: 7px;
    overflow: hidden;
    font-size: 11px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .el-recent small {
    display: block;
    margin-top: 4px;
  }
  .el-media-label {
    position: absolute;
    top: 7px;
    right: 7px;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 3px 5px;
    border-radius: 3px;
    background: rgb(0 0 0 / 65%);
    color: white;
    font-size: 10px;
  }
  .el-more {
    display: flex;
    gap: 12px;
    padding-top: 20px;
    border-top: 1px solid var(--fl-border);
  }
  .el-more a {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-right: 16px;
    padding: 8px 0;
    font-size: 12px;
  }
  .el-empty {
    padding: 50px 12px;
    color: var(--fl-muted);
    text-align: center;
  }
  .el-empty h2 {
    margin-top: 14px;
    color: var(--fl-text);
  }
  .el-empty p {
    font-size: 13px;
  }
  .el-cover-empty {
    display: grid;
    place-items: center;
    min-height: 62px;
    background: var(--fl-raised);
    color: var(--fl-muted);
  }
  .explore-library a:hover,
  .explore-library button:hover {
    filter: brightness(1.08);
  }

  /* apple-style.css "#5 snapping carousels" */
  :is(.el-memory-row, .el-people, .el-places, .el-highlights) {
    scroll-snap-type: x mandatory;
    scroll-padding-inline: 4px;
    overscroll-behavior-inline: contain;
  }
  :is(.el-memory-row, .el-people, .el-places, .el-highlights) > * {
    scroll-snap-align: start;
  }

  /* apple-style.css:109-135 continuous corners, grown for the squircle */
  @supports (corner-shape: squircle) {
    .el-best,
    .el-place {
      border-radius: calc(var(--fl-radius-card) * 1.8);
    }
  }

  @media (max-width: 1050px) {
    .el-highlights {
      grid-template-columns: 1fr;
    }
    .el-shortcuts {
      grid-template-columns: repeat(4, 1fr);
    }
    .el-shortcut {
      gap: 8px;
      padding: 12px;
    }
    .el-shortcut > :global(svg:last-child) {
      display: none;
    }
  }
  @media (max-width: 600px) {
    .explore-library {
      padding: 22px 16px 30px;
    }
    .el-people {
      gap: 13px;
    }
    .el-shortcuts {
      grid-template-columns: 1fr 1fr;
    }
    .el-places {
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    .el-place {
      min-height: 160px;
    }
    .el-recent {
      grid-template-columns: 1fr 1fr;
    }
    .el-things {
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }
    .el-things img,
    .el-things .el-cover-empty {
      flex-basis: 45px;
      width: 45px;
      height: 52px;
    }
    .el-things a {
      gap: 8px;
    }
    .el-things a > :global(svg) {
      display: none;
    }
    .el-best-copy {
      margin-left: 18px;
    }
    .el-more a {
      min-height: 40px;
    }
  }
</style>
