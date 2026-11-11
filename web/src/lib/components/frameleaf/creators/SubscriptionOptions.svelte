<script lang="ts">
  import { MediaReachMode, type MediaQuality, type MediaSaves } from '@frameleaf/sdk';
  import { t } from 'svelte-i18n';
  import { MEDIA_INTERVALS, type MediaInterval } from '$lib/components/frameleaf/media/boards-media';
  import { boardsCollectionUi } from '$lib/frameleaf/boards-collection-ui.svelte';
  import { CREATOR_PLATFORMS, CREATOR_QUALITIES, CREATOR_REACHES, CREATOR_RECENT_COUNT } from '$lib/frameleaf/creators';
  import { creatorsStore } from '$lib/frameleaf/creators-store.svelte';
  import type { MediaPlatform } from '$lib/frameleaf/media-address';

  /**
   * The switches, quality and reach of one subscription (prototype `SubscriptionOptions`): on the
   * page, never in a menu. "How far back" starts with nothing chosen when following.
   */
  let {
    platform,
    saves = $bindable(),
    quality = $bindable(),
    reach = $bindable(),
    since = $bindable(),
    interval = $bindable(),
    folderId = $bindable(),
    disabled = false,
  }: {
    platform: MediaPlatform;
    saves: MediaSaves;
    quality: MediaQuality;
    reach: MediaReachMode | undefined;
    since: string;
    interval: MediaInterval;
    folderId: string | null;
    disabled?: boolean;
  } = $props();

  const id = $props.id();
  const NEW_FOLDER = '__new';
  const switches = $derived(CREATOR_PLATFORMS[platform].saves);
  const hasVideo = $derived(platform !== 'pinterest');
  // The folder a creator is already in stays on offer even if it can no longer be chosen afresh.
  const folders = $derived.by(() => {
    const list = creatorsStore.folders.map(({ id, albumName }) => ({ id, name: albumName }));
    const name = creatorsStore.folderName(folderId);
    return folderId && name && list.every((folder) => folder.id !== folderId)
      ? [...list, { id: folderId, name }]
      : list;
  });

  /** The folder shown as chosen; one that is not on offer reads as "No folder". */
  const chosen = $derived(folders.some((folder) => folder.id === folderId) ? (folderId ?? '') : '');

  const chooseFolder = (event: Event & { currentTarget: HTMLSelectElement }) => {
    const value = event.currentTarget.value;
    if (value === NEW_FOLDER) {
      // Boards' own New collection dialog; the new folder joins this list once it is made.
      event.currentTarget.value = chosen;
      boardsCollectionUi.newCollection(null);
      return;
    }
    folderId = value || null;
  };
</script>

<div class="cr-options">
  {#if switches.length > 0}
    <fieldset {disabled}>
      <legend>{$t('frameleaf_creators_what_to_save')}</legend>
      {#each switches as item (item.id)}
        <label class="cr-switch">
          <input
            type="checkbox"
            role="switch"
            checked={saves[item.id] ?? item.on}
            onchange={(event) => (saves = { ...saves, [item.id]: event.currentTarget.checked })}
          />
          <span>{$t(item.label)}</span>
        </label>
      {/each}
    </fieldset>
  {/if}
  {#if hasVideo}
    <fieldset {disabled}>
      <legend>{$t('frameleaf_creators_video_quality')}</legend>
      <div class="cr-seg">
        {#each CREATOR_QUALITIES as value (value)}
          <label>
            <input type="radio" name="{id}-quality" {value} bind:group={quality} />
            <span>{$t(`frameleaf_creators_quality_${value}`)}</span>
          </label>
        {/each}
      </div>
    </fieldset>
  {/if}
  <fieldset {disabled}>
    <legend
      >{$t('frameleaf_creators_how_far_back')}{#if !reach}<em>{$t('frameleaf_creators_choose_one')}</em>{/if}</legend
    >
    {#each CREATOR_REACHES as mode (mode)}
      <label class="cr-radio">
        <input type="radio" name="{id}-reach" value={mode} bind:group={reach} />
        <span>{$t(`frameleaf_creators_reach_${mode}`, { values: { count: CREATOR_RECENT_COUNT } })}</span>
        {#if mode === MediaReachMode.Since && reach === MediaReachMode.Since}
          <input type="date" aria-label={$t('frameleaf_creators_since')} bind:value={since} />
        {/if}
      </label>
    {/each}
  </fieldset>
  <fieldset class="cr-pair" {disabled}>
    <label>
      <span>{$t('frameleaf_creators_look_for_new')}</span>
      <select bind:value={interval}>
        {#each MEDIA_INTERVALS as value (value)}
          <option {value}>{$t(`frameleaf_creators_interval_${value}`)}</option>
        {/each}
      </select>
    </label>
    <label>
      <span>{$t('frameleaf_creators_folder')}</span>
      <select onchange={chooseFolder}>
        <option value="" selected={!chosen}>{$t('frameleaf_creators_no_folder')}</option>
        {#each folders as folder (folder.id)}
          <option value={folder.id} selected={folder.id === chosen}>{folder.name}</option>
        {/each}
        <option value={NEW_FOLDER}>{$t('frameleaf_creators_new_folder')}</option>
      </select>
    </label>
  </fieldset>
</div>
