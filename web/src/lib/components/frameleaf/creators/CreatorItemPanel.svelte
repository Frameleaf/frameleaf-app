<script lang="ts">
  import {
    addAssetsToAlbum,
    BulkIdErrorReason,
    deleteAssets,
    LibraryViewScope,
    MediaItemKind,
    MediaSavedBy,
    updateMediaWatch,
    type MediaCreatorItemResponse,
    type MediaCreatorResponseDto,
  } from '@frameleaf/sdk';
  import { Icon, toastManager } from '@frameleaf/ui';
  import { mdiCheck, mdiClose, mdiEyeOffOutline, mdiFolderPlusOutline, mdiPlay, mdiTrashCanOutline } from '@mdi/js';
  import { locale, t, type Translations } from 'svelte-i18n';
  import { goto } from '$app/navigation';
  import BulkAlbumDialog from '$lib/components/frameleaf/BulkAlbumDialog.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import IconButton from '$lib/components/frameleaf/IconButton.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import { mediaDate } from '$lib/components/frameleaf/media/boards-media';
  import { creatorItemImage, creatorPlatform, mediaLength, platformName } from '$lib/frameleaf/creators';
  import { libraryReferenceUrl } from '$lib/frameleaf/library-reference';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { Route } from '$lib/route';

  /**
   * An item's details beside the page (prototype `ItemPanel`), laid out like the Library info panel:
   * what the post said is metadata, not a caption. Everything a site wrote is shown as text.
   */
  let {
    item,
    creator,
    onClose,
    onChange,
    onDeleted,
  }: {
    item: MediaCreatorItemResponse;
    creator: MediaCreatorResponseDto;
    onClose: () => void;
    /** The item with its new watched state. */
    onChange: (item: MediaCreatorItemResponse) => void;
    onDeleted: (assetId: string) => void;
  } = $props();

  let busy = $state(false);
  let error = $state<Translations | ''>('');
  let choosing = $state(false);

  const platform = $derived(creatorPlatform(creator.provider, creator.url));
  const site = $derived(platformName(platform, creator.provider) || $t('frameleaf_creators_platform_website'));
  const playable = $derived(item.kind !== MediaItemKind.Image);
  const length = $derived(mediaLength(item.duration));
  const original = $derived(libraryReferenceUrl(item.pageUrl));
  /** The saved file in the Library's own viewer, inside the creator's collection when it has one. */
  const viewer = $derived(
    creator.albumId
      ? Route.viewAlbumAsset({ albumId: creator.albumId, assetId: item.assetId })
      : Route.viewAsset({ id: item.assetId }),
  );

  const run = async (work: () => Promise<void>, failure: Translations) => {
    if (busy) {
      return;
    }
    busy = true;
    error = '';
    try {
      await work();
    } catch {
      error = failure;
    } finally {
      busy = false;
    }
  };

  const toggleWatched = () =>
    run(async () => {
      const watched = !item.watched;
      const result = await updateMediaWatch({ assetId: item.assetId, mediaWatchUpdateDto: { watched } });
      onChange({ ...item, watched: result.watched, position: result.position });
      toastManager.primary($t(watched ? 'frameleaf_creators_marked_watched' : 'frameleaf_creators_marked_unwatched'));
    }, 'frameleaf_creators_action_error');

  const addTo = (albumId: string | undefined) => {
    if (!albumId) {
      return;
    }
    return run(async () => {
      const result = await addAssetsToAlbum({ id: albumId, bulkIdsDto: { ids: [item.assetId] } });
      if (result.some((row) => !row.success && row.error !== BulkIdErrorReason.Duplicate)) {
        throw new Error('The item could not be added');
      }
      eventManager.emit('AlbumAddAssets', { assetIds: [item.assetId], albumIds: [albumId] });
      toastManager.primary($t('frameleaf_creators_added_to_collection'));
    }, 'frameleaf_creators_action_error');
  };

  const trash = () =>
    run(async () => {
      await deleteAssets({ assetBulkDeleteDto: { ids: [item.assetId] } });
      toastManager.primary($t('frameleaf_creators_trashed'));
      onDeleted(item.assetId);
    }, 'frameleaf_creators_action_error');
</script>

<aside class="cr-inspector" aria-label={$t('frameleaf_creators_details')}>
  <div class="cr-inspector-head">
    <h3>{$t('frameleaf_creators_details')}</h3>
    <IconButton label={$t('frameleaf_creators_close_details')} onclick={onClose}>
      <Icon icon={mdiClose} size="18" aria-hidden={true} />
    </IconButton>
  </div>
  <div class="cr-inspector-body">
    <a class="cr-thumb" href={viewer} aria-label={$t('frameleaf_creators_open_saved')}>
      <img src={creatorItemImage(item)} alt="" />
      {#if length}<span class="cr-length">{length}</span>{/if}
    </a>
    {#if playable}
      <div class="cr-inspector-actions">
        <Button variant="primary" onclick={() => void goto(viewer)}>
          <Icon icon={mdiPlay} size="18" aria-hidden={true} />
          {$t(item.position > 0 && !item.watched ? 'frameleaf_creators_carry_on_watching' : 'frameleaf_creators_play')}
        </Button>
        <Button disabled={busy} onclick={() => void toggleWatched()}>
          <Icon icon={item.watched ? mdiEyeOffOutline : mdiCheck} size="18" aria-hidden={true} />
          {$t(item.watched ? 'frameleaf_creators_mark_unwatched' : 'frameleaf_creators_mark_watched')}
        </Button>
      </div>
    {/if}
    {#if error}<InlineError compact message={$t(error)} />{/if}
    <section>
      <h4>{$t('frameleaf_creators_from_the_post')}</h4>
      <dl class="cr-facts">
        {#if item.title}
          <dt>{$t('frameleaf_creators_fact_title')}</dt>
          <dd>{item.title}</dd>
        {/if}
        <dt>{$t(playable ? 'frameleaf_creators_fact_description' : 'frameleaf_creators_fact_text')}</dt>
        <dd class="cr-pre">{item.description || $t('frameleaf_creators_none')}</dd>
        <dt>{$t('frameleaf_creators_fact_tags')}</dt>
        <dd class="cr-tags">
          {#each item.tags as tag (tag)}<span>#{tag}</span>{:else}{$t('frameleaf_creators_none')}{/each}
        </dd>
        {#if item.publishedAt}
          <dt>{$t('frameleaf_creators_fact_posted')}</dt>
          <dd>
            {new Date(item.publishedAt).toLocaleDateString($locale ?? undefined, { dateStyle: 'medium' })}
          </dd>
        {/if}
      </dl>
    </section>
    <section>
      <h4>{$t('frameleaf_creators_source')}</h4>
      <dl class="cr-facts">
        <dt>{$t('frameleaf_creators_fact_creator')}</dt>
        <dd>
          {creator.name}
          <small>{creator.handle ? `${creator.handle} · ` : ''}{site}</small>
        </dd>
        <dt>{$t('frameleaf_creators_fact_saved_by')}</dt>
        <dd>
          {$t(
            item.savedBy === MediaSavedBy.Subscription
              ? 'frameleaf_creators_saved_by_subscription'
              : 'frameleaf_creators_saved_by_download',
          )}
        </dd>
        {#if original}
          <dt>{$t('frameleaf_creators_fact_original')}</dt>
          <dd>
            <a href={original} target="_blank" rel="noopener noreferrer">
              {$t('frameleaf_creators_open_on', { values: { name: site } })}
            </a>
            <small>{$t('frameleaf_creators_original_private')}</small>
          </dd>
        {/if}
      </dl>
    </section>
    <section>
      <h4>{$t('frameleaf_creators_file')}</h4>
      <dl class="cr-facts">
        <dt>{$t('frameleaf_creators_fact_type')}</dt>
        <dd>{$t(`frameleaf_creators_kind_${item.kind}`)}</dd>
        <dt>{$t('frameleaf_creators_fact_added')}</dt>
        <dd>{mediaDate(item.savedAt, $locale)}</dd>
      </dl>
    </section>
    <div class="cr-inspector-foot">
      <Button disabled={busy} onclick={() => (choosing = true)}>
        <Icon icon={mdiFolderPlusOutline} size="18" aria-hidden={true} />{$t('frameleaf_creators_add_to_collection')}
      </Button>
      <Button variant="danger" disabled={busy} onclick={() => void trash()}>
        <Icon icon={mdiTrashCanOutline} size="18" aria-hidden={true} />{$t('delete')}
      </Button>
    </div>
  </div>
</aside>
{#if choosing}
  <BulkAlbumDialog
    libraryScope={LibraryViewScope.Design}
    bind:open={choosing}
    count={1}
    onSubmit={(payload) => void addTo(payload.albumId)}
  />
{/if}
