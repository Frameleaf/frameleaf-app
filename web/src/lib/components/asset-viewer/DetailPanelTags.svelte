<script lang="ts">
  /**
   * The information panel's tags (FL-36, audit V-25), ported from `TagsSection` in
   * `design/frameleaf/template/src/MediaViewer.jsx:3190-3343` and `.mv-chips`, `.mv-tag`,
   * `.mv-combobox`, `.mv-listbox` (media-viewer.css:1543-1641): the item's tags as chips with a
   * remove button, "No tags yet." when it has none, and an "Add a tag" combobox that suggests the
   * account's tags and offers "Create “…”" for a new one. T opens the panel on this box.
   *
   * Adding writes through `bulkTagAssets` (creating the tag first with `upsertTags` when it is new),
   * removing through `untagAssets`. The panel never keeps its own tag list: after either change it
   * refetches the asset so what is shown is what the server stored. A failed change is reported in
   * place with a retry, because a tag or untag that never reached a verdict is safe to repeat; a stale
   * asset is reloaded instead.
   */
  import OnEvents from '$lib/components/OnEvents.svelte';
  import ViewerInlineEditError from '$lib/components/frameleaf/ViewerInlineEditError.svelte';
  import { tagSuggestions, type TagSuggestion } from '$lib/frameleaf/info-panel';
  import { classifyInlineEditError, inlineEditRecovery, type InlineEditFailure } from '$lib/frameleaf/inline-edit';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { Route } from '$lib/route';
  import { handlePromiseError } from '$lib/utils';
  import { removeTag, tagAssets } from '$lib/utils/asset-utils';
  import { handleError } from '$lib/utils/handle-error';
  import { getAllTags, getAssetInfo, upsertTags, type AssetResponseDto, type TagResponseDto } from '@immich/sdk';
  import { Icon, toastManager } from '@immich/ui';
  import { mdiClose, mdiPlus, mdiTagOutline, mdiTagPlusOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  interface Props {
    asset: AssetResponseDto;
    isOwner: boolean;
    /** Lets the viewer take the updated asset, so the change is not stranded in the panel. */
    onAssetRefresh?: (asset: AssetResponseDto) => void;
  }

  let { asset = $bindable(), isOwner, onAssetRefresh }: Props = $props();

  const listId = $props.id();

  const tags = $derived(asset.tags ?? []);
  const canEdit = $derived(isOwner && !asset.isTrashed && !authManager.isSharedLink);

  let failure = $state<InlineEditFailure | null>(null);
  let isSaving = $state(false);
  /** The change that failed, so a retry repeats that change and not another one. */
  let pending = $state<{ kind: 'add'; option: TagSuggestion } | { kind: 'remove'; tagId: string } | null>(null);

  let allTags = $state<TagResponseDto[] | null>(null);
  let query = $state('');
  let open = $state(false);
  let active = $state(0);
  let input: HTMLInputElement | undefined = $state();

  const options = $derived(
    tagSuggestions(
      allTags ?? [],
      tags.map((tag) => tag.id),
      query,
    ),
  );

  const loadTags = async () => {
    if (allTags) {
      return;
    }
    try {
      allTags = await getAllTags();
    } catch (error) {
      handleError(error, $t('errors.frameleaf_tags_unable_to_load'));
    }
  };

  // T asks for this box (V-15); take focus once it renders.
  $effect(() => {
    if (assetViewerManager.focusRequest !== 'tags' || !input) {
      return;
    }
    assetViewerManager.focusRequest = null;
    input.focus();
  });

  const refresh = async () => {
    asset = await getAssetInfo({ id: asset.id });
    onAssetRefresh?.(asset);
  };

  const run = async (change: NonNullable<typeof pending>) => {
    isSaving = true;
    pending = change;
    try {
      if (change.kind === 'add') {
        let tagId = change.option.id;
        if (change.option.create) {
          const [created] = await upsertTags({ tagUpsertDto: { tags: [change.option.id] } });
          allTags = allTags ? [...allTags, created] : [created];
          tagId = created.id;
        }
        await tagAssets({ tagIds: [tagId], assetIds: [asset.id], showNotification: false });
        toastManager.primary(change.option.create ? $t('frameleaf_info_tag_created') : $t('frameleaf_info_tag_added'));
      } else {
        await removeTag({ tagIds: [change.tagId], assetIds: [asset.id], showNotification: false });
        toastManager.primary($t('frameleaf_info_tag_removed'));
      }
      failure = null;
      pending = null;
      eventManager.emit('AssetsTag', [asset.id]);
      await refresh();
    } catch (error) {
      failure = classifyInlineEditError(error);
      handleError(
        error,
        change.kind === 'add' ? $t('frameleaf_info_error_add_tag') : $t('frameleaf_info_error_remove_tag'),
      );
    } finally {
      isSaving = false;
    }
  };

  const choose = (option: TagSuggestion) => {
    query = '';
    open = false;
    active = 0;
    handlePromiseError(run({ kind: 'add', option }));
  };

  const reload = async () => {
    try {
      await refresh();
      failure = null;
      pending = null;
    } catch (error) {
      handleError(error, $t('frameleaf_info_error_reload_failed'));
    }
  };

  const onKeydown = (event: KeyboardEvent) => {
    // The box keeps its keys: nothing typed here reaches the viewer's shortcuts (MediaViewer.jsx:3293).
    event.stopPropagation();
    switch (event.key) {
      case 'ArrowDown': {
        event.preventDefault();
        open = true;
        active = Math.min(options.length - 1, active + 1);
        break;
      }
      case 'ArrowUp': {
        event.preventDefault();
        active = Math.max(0, active - 1);
        break;
      }
      case 'Enter': {
        event.preventDefault();
        const option = options.at(active);
        if (option) {
          choose(option);
        }
        break;
      }
      case 'Escape': {
        event.preventDefault();
        if (open || query) {
          open = false;
          query = '';
        } else {
          input?.blur();
        }
        break;
      }
    }
  };

  const onAssetsTag = async (ids: string[]) => {
    if (!ids.includes(asset.id) || isSaving) {
      return;
    }
    await refresh();
  };
</script>

<OnEvents {onAssetsTag} />

{#if tags.length > 0 || canEdit}
  <section class="fl-info-tags px-4 pt-4" data-testid="detail-panel-tags">
    <h3>{$t('tags')}</h3>
    <div class="fl-chips">
      {#each tags as tag (tag.id)}
        <span class="fl-tag">
          <Icon icon={mdiTagOutline} size="13" aria-hidden />
          <a href={Route.tags({ path: tag.value })}>{tag.value}</a>
          {#if canEdit}
            <button
              type="button"
              aria-label={$t('frameleaf_info_remove_tag', { values: { name: tag.value } })}
              disabled={isSaving}
              onclick={() => handlePromiseError(run({ kind: 'remove', tagId: tag.id }))}
            >
              <Icon icon={mdiClose} size="13" aria-hidden />
            </button>
          {/if}
        </span>
      {/each}
      {#if tags.length === 0}
        <span class="fl-no-tags">{$t('frameleaf_info_no_tags')}</span>
      {/if}
    </div>
    {#if canEdit}
      <div class="fl-combobox fl-continuous-corners">
        <Icon icon={mdiTagPlusOutline} size="16" aria-hidden />
        <input
          bind:this={input}
          bind:value={query}
          data-mv-focus="tags"
          role="combobox"
          aria-label={$t('frameleaf_info_add_tag')}
          aria-expanded={open && options.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && options.at(active) ? `${listId}-${active}` : undefined}
          placeholder={$t('frameleaf_info_add_tag')}
          disabled={isSaving}
          onfocus={() => {
            open = true;
            handlePromiseError(loadTags());
          }}
          onblur={() => setTimeout(() => (open = false), 120)}
          oninput={() => {
            open = true;
            active = 0;
          }}
          onkeydown={onKeydown}
        />
        {#if open && options.length > 0}
          <ul
            class="fl-listbox fl-continuous-corners"
            role="listbox"
            id={listId}
            aria-label={$t('frameleaf_info_tag_suggestions')}
          >
            {#each options as option, index (`${option.create ? 'new' : 'tag'}:${option.id}`)}
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <li
                id="{listId}-{index}"
                role="option"
                aria-selected={index === active}
                class:active={index === active}
                onmousedown={(event) => event.preventDefault()}
                onclick={() => choose(option)}
              >
                <Icon icon={option.create ? mdiPlus : mdiTagOutline} size="14" aria-hidden />
                {option.create ? $t('frameleaf_info_create_tag', { values: { name: option.label } }) : option.label}
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {/if}
    {#if failure}
      <ViewerInlineEditError
        {failure}
        busy={isSaving}
        onRetry={inlineEditRecovery(failure) === 'retry' && pending
          ? () => handlePromiseError(run(pending!))
          : undefined}
        onReload={inlineEditRecovery(failure) === 'reload' ? () => handlePromiseError(reload()) : undefined}
      />
    {/if}
  </section>
{/if}

<style>
  /* .mv-info h3 (media-viewer.css:979-989). */
  h3 {
    margin: 0 0 10px;
    color: var(--fl-viewer-muted, #979ba2);
    font-size: var(--fl-font-micro, 11px);
    font-weight: 550;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  .fl-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 10px;
  }

  .fl-tag {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    min-height: 30px;
    padding: 3px 4px 3px 9px;
    border: 1px solid var(--fl-viewer-border, rgb(255 255 255 / 8%));
    border-radius: var(--fl-radius-pill, 999px);
    color: var(--fl-viewer-text, #f1f1f2);
    font-size: var(--fl-font-small, 13px);
  }

  .fl-tag > :global(svg) {
    color: var(--fl-viewer-muted, #979ba2);
  }

  .fl-tag a {
    color: inherit;
    text-decoration: none;
  }

  .fl-tag a:hover {
    text-decoration: underline;
  }

  .fl-tag button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: var(--fl-viewer-muted, #979ba2);
    cursor: pointer;
  }

  .fl-tag button:hover:not(:disabled) {
    background: #ffffff14;
    color: var(--fl-viewer-text, #f1f1f2);
  }

  .fl-no-tags {
    margin: 0;
    color: var(--fl-viewer-muted, #979ba2);
    font-size: var(--fl-font-small, 13px);
  }

  .fl-combobox {
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 36px;
    padding: 0 10px;
    border: 1px solid var(--fl-viewer-border, rgb(255 255 255 / 8%));
    border-radius: var(--fl-radius-control, 10px);
    background: #ffffff06;
    color: var(--fl-viewer-muted, #979ba2);
  }

  .fl-combobox:focus-within {
    border-color: var(--fl-accent);
  }

  .fl-combobox input {
    flex: 1;
    min-width: 0;
    min-height: 34px;
    border: 0;
    background: transparent;
    color: var(--fl-viewer-text, #f1f1f2);
    font: inherit;
    font-size: var(--fl-font-small, 13px);
    outline: none;
  }

  .fl-combobox input::placeholder {
    color: var(--fl-viewer-muted, #979ba2);
  }

  .fl-listbox {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    right: 0;
    z-index: 5;
    margin: 0;
    padding: 6px;
    list-style: none;
    background: var(--fl-viewer-raised, #25272b);
    border: 1px solid var(--fl-viewer-border, rgb(255 255 255 / 8%));
    border-radius: var(--fl-radius-card, 14px);
    box-shadow: var(--fl-shadow-2);
    max-height: 220px;
    overflow-y: auto;
  }

  .fl-listbox li {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 34px;
    padding: 6px 10px;
    border-radius: var(--fl-radius-control, 10px);
    color: var(--fl-viewer-text, #f1f1f2);
    font-size: var(--fl-font-small, 13px);
    cursor: pointer;
  }

  .fl-listbox li :global(svg) {
    color: var(--fl-viewer-muted, #979ba2);
  }

  .fl-listbox li.active,
  .fl-listbox li:hover {
    background: #ffffff0f;
  }

  @supports (corner-shape: squircle) {
    .fl-combobox {
      border-radius: calc(var(--fl-radius-control, 10px) * 1.8);
    }

    .fl-listbox {
      border-radius: calc(var(--fl-radius-card, 14px) * 1.8);
    }
  }
</style>
