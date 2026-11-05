<script lang="ts">
  /**
   * Run one task on one photo or video, now (approved design, 2026-11-04, `RunOneDialog.jsx`). Shared
   * by Background work › Advanced and Library care. Pick the item from the library by name, or paste
   * its ID; `onStart` starts the work and returns what to say, or throws to show why it could not.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { getAssetMediaUrl } from '$lib/utils';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import {
    AssetMediaSize,
    AssetOrder,
    AssetTypeEnum,
    AssetVisibility,
    searchAssets,
    type AssetResponseDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiAlertCircleOutline, mdiMagnify } from '@mdi/js';
  import { t } from 'svelte-i18n';

  let {
    open = $bindable(false),
    title,
    verb,
    note,
    videosOnly = false,
    onStart,
  }: {
    open?: boolean;
    title: string;
    /** The start button's word: "Check", "Redo", "Start now"… */
    verb: string;
    note: string;
    videosOnly?: boolean;
    onStart: (asset: AssetResponseDto) => Promise<void>;
  } = $props();

  const UUID = /[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}/i;
  let find = $state('');
  let items = $state<AssetResponseDto[]>([]);
  let picked = $state<AssetResponseDto | null>(null);
  let error = $state('');
  let searching = $state(false);
  let starting = $state(false);
  let generation = 0;

  async function search(text: string) {
    const current = ++generation;
    searching = true;
    try {
      const id = UUID.exec(text)?.[0];
      const { assets } = await searchAssets({
        metadataSearchDto: {
          size: 30,
          order: AssetOrder.Desc,
          visibility: AssetVisibility.Timeline,
          ...(videosOnly && { type: AssetTypeEnum.Video }),
          ...(id ? { id } : text.trim() ? { originalFileName: text.trim() } : {}),
        },
      });
      if (current === generation) {
        items = assets.items;
      }
    } catch (error_) {
      if (current === generation) {
        items = [];
        error = getServerErrorMessage(error_) ?? $t('errors.something_went_wrong');
      }
    } finally {
      if (current === generation) {
        searching = false;
      }
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    if (!open) {
      return;
    }
    const text = find;
    clearTimeout(timer);
    timer = setTimeout(() => void search(text), text ? 250 : 0);
    return () => clearTimeout(timer);
  });

  async function start() {
    if (!picked || starting) {
      return;
    }
    starting = true;
    error = '';
    try {
      await onStart(picked);
      open = false;
      picked = null;
      find = '';
    } catch (error_) {
      error = getServerErrorMessage(error_) ?? (error_ as Error)?.message ?? $t('errors.something_went_wrong');
    } finally {
      starting = false;
    }
  }
</script>

<Dialog {title} closeLabel={$t('close')} bind:open>
  <form
    class="run-one"
    onsubmit={(event) => {
      event.preventDefault();
      void start();
    }}
  >
    <p class="run-one-note">{note}</p>
    <label class="run-one-find">
      <Icon icon={mdiMagnify} size="18px" aria-hidden={true} />
      <input
        type="search"
        aria-label={videosOnly ? $t('frameleaf_run_one_find_video') : $t('frameleaf_run_one_find')}
        placeholder={videosOnly ? $t('frameleaf_run_one_find_video') : $t('frameleaf_run_one_find')}
        autocomplete="off"
        bind:value={find}
      />
    </label>
    <ul class="run-one-list" role="radiogroup" aria-label={$t('frameleaf_run_one_list')} aria-busy={searching}>
      {#each items as asset (asset.id)}
        <li>
          <label class:is-on={picked?.id === asset.id}>
            <input
              type="radio"
              name="run-one"
              checked={picked?.id === asset.id}
              onchange={() => {
                picked = asset;
                error = '';
              }}
            />
            <img src={getAssetMediaUrl({ id: asset.id, size: AssetMediaSize.Thumbnail })} alt="" loading="lazy" />
            <span>
              <strong>{asset.originalFileName}</strong>
              <small
                >{asset.type === AssetTypeEnum.Video
                  ? $t('frameleaf_run_one_video')
                  : $t('frameleaf_run_one_photo')}{asset.exifInfo?.city ? ` · ${asset.exifInfo.city}` : ''}</small
              >
            </span>
          </label>
        </li>
      {:else}
        <li class="run-one-empty">
          {searching
            ? $t('frameleaf_run_one_searching')
            : find.trim()
              ? $t('frameleaf_run_one_none', { values: { find: find.trim() } })
              : $t('frameleaf_run_one_empty')}
        </li>
      {/each}
    </ul>
    {#if error}<p class="run-one-error" role="alert">
        <Icon icon={mdiAlertCircleOutline} size="16px" aria-hidden={true} />{error}
      </p>{/if}
    <footer>
      <Button onclick={() => (open = false)}>{$t('cancel')}</Button>
      <Button type="submit" variant="primary" disabled={!picked || starting}
        >{picked ? `${verb} ${picked.originalFileName}` : verb}</Button
      >
    </footer>
  </form>
</Dialog>

<style>
  .run-one {
    display: grid;
    gap: 12px;
  }
  .run-one-note {
    margin: 0;
    color: var(--fl-muted);
    line-height: 1.5;
  }
  .run-one-find {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 10px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    background: var(--fl-raised);
    color: var(--fl-muted);
  }
  .run-one-find:focus-within {
    border-color: var(--fl-accent);
    box-shadow: 0 0 0 3px var(--fl-accent-soft);
  }
  .run-one-find input {
    flex: 1;
    min-height: 36px;
    padding: 0;
    border: 0;
    background: none;
    color: var(--fl-text);
    font: inherit;
  }
  .run-one-find input:focus-visible {
    outline: none;
  }
  .run-one-list {
    display: grid;
    gap: 2px;
    max-height: 320px;
    margin: 0;
    padding: 4px;
    overflow-y: auto;
    list-style: none;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-canvas);
  }
  .run-one-list label {
    display: grid;
    grid-template-columns: auto 44px minmax(0, 1fr);
    align-items: center;
    gap: 10px;
    padding: 6px 8px;
    border-radius: var(--fl-radius-sm);
    cursor: pointer;
  }
  .run-one-list label:hover {
    background: var(--fl-raised);
  }
  .run-one-list label.is-on {
    background: var(--fl-accent-soft);
  }
  .run-one-list input {
    accent-color: var(--fl-accent);
  }
  .run-one-list img {
    width: 44px;
    height: 44px;
    border-radius: var(--fl-radius-sm);
    object-fit: cover;
    background: var(--fl-raised);
  }
  .run-one-list strong {
    display: block;
    overflow: hidden;
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .run-one-list small {
    display: block;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .run-one-empty {
    padding: 16px;
    color: var(--fl-muted);
    text-align: center;
  }
  .run-one-error {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    margin: 0;
    color: var(--fl-warning);
  }
  .run-one footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
</style>
