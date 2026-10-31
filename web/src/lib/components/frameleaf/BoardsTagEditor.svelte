<script lang="ts">
  /**
   * A file's tags in the Boards details panel (approved prototype `Inspector` tags and `TagInput`,
   * README point 6): the tags as chips with a remove button, then an "Add a tag" combobox whose
   * suggestions open directly under the field (never the browser's own `<datalist>`, which can open
   * far away) and which offers "Create “…”" for a new name.
   *
   * Adding writes through the tag API (`upsertTags` first when the tag is new, then tag assign);
   * removing through tag unassign. A failed change is reported in place with a Retry that repeats
   * exactly that change. Only the owner edits; anyone else sees the chips.
   */
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import { tagSuggestions, type TagSuggestion } from '$lib/frameleaf/info-panel';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { removeTag, tagAssets } from '$lib/utils/asset-utils';
  import { getAllTags, upsertTags, type TagResponseDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiClose, mdiPlus, mdiTagOutline } from '@mdi/js';
  import { untrack } from 'svelte';
  import { t } from 'svelte-i18n';

  type Change = { kind: 'add'; option: TagSuggestion } | { kind: 'remove'; tag: TagResponseDto };

  let {
    assetId,
    tags,
    canEdit = false,
    labelledBy,
  }: {
    assetId: string;
    tags: TagResponseDto[];
    canEdit?: boolean;
    /** Id of the section heading that names the tag list. */
    labelledBy?: string;
  } = $props();

  const listId = $props.id();
  let current = $state<TagResponseDto[]>([]);
  let allTags = $state<TagResponseDto[] | null>(null);
  let query = $state('');
  let open = $state(false);
  let active = $state(0);
  let busy = $state(false);
  let failed = $state<Change | null>(null);
  let generation = 0;

  // A new item starts from its stored tags; later answers for the same item are kept locally.
  $effect.pre(() => {
    void assetId;
    current = [...untrack(() => tags)];
    generation++;
    query = '';
    open = false;
    active = 0;
    busy = false;
    failed = null;
  });

  const options = $derived(
    tagSuggestions(
      allTags ?? [],
      current.map((tag) => tag.id),
      query,
    ),
  );
  const expanded = $derived(open && options.length > 0);

  const loadTags = async () => {
    if (allTags) {
      return;
    }
    try {
      allTags = await getAllTags();
    } catch {
      // Suggestions are optional: a new name can still be typed and created.
      allTags = [];
    }
  };

  const run = async (change: Change) => {
    const id = assetId;
    const version = generation;
    const stillHere = () => assetId === id && generation === version;
    busy = true;
    failed = null;
    try {
      if (change.kind === 'add') {
        const known = change.option.create ? undefined : allTags?.find((item) => item.id === change.option.id);
        const tag = known ?? (await upsertTags({ tagUpsertDto: { tags: [change.option.id] } }))[0];
        if (!known) {
          allTags = [...(allTags ?? []).filter((item) => item.id !== tag.id), tag];
        }
        await tagAssets({ tagIds: [tag.id], assetIds: [id], showNotification: false });
        if (stillHere() && current.every((item) => item.id !== tag.id)) {
          current = [...current, tag];
        }
      } else {
        await removeTag({ tagIds: [change.tag.id], assetIds: [id], showNotification: false });
        if (stillHere()) {
          current = current.filter((item) => item.id !== change.tag.id);
        }
      }
      eventManager.emit('AssetsTag', [id]);
    } catch {
      if (stillHere()) {
        failed = change;
      }
    } finally {
      if (stillHere()) {
        busy = false;
      }
    }
  };

  const choose = (option: TagSuggestion) => {
    query = '';
    open = false;
    active = 0;
    void run({ kind: 'add', option });
  };

  const onKeydown = (event: KeyboardEvent) => {
    switch (event.key) {
      case 'ArrowDown': {
        event.preventDefault();
        if (expanded) {
          active = Math.min(options.length - 1, active + 1);
        } else {
          open = true;
          active = 0;
        }
        break;
      }
      case 'ArrowUp': {
        event.preventDefault();
        active = Math.max(0, active - 1);
        break;
      }
      case 'Enter': {
        event.preventDefault();
        // A closed list has nothing on show to choose.
        const option = expanded ? options.at(active) : undefined;
        if (option) {
          choose(option);
        }
        break;
      }
      case 'Escape': {
        if (open || query) {
          event.preventDefault();
          event.stopPropagation();
          open = false;
          query = '';
        }
        break;
      }
    }
  };
</script>

<div class="fl-boards-tags">
  {#if current.length > 0}
    <ul class="chips" aria-labelledby={labelledBy}>
      {#each current as tag (tag.id)}
        <li>
          <span>{tag.value}</span>
          {#if canEdit}
            <button
              type="button"
              aria-label={$t('frameleaf_info_remove_tag', { values: { name: tag.value } })}
              disabled={busy}
              onclick={() => void run({ kind: 'remove', tag })}
            >
              <Icon icon={mdiClose} size="14" aria-hidden />
            </button>
          {/if}
        </li>
      {/each}
    </ul>
  {:else if !canEdit}
    <p class="muted">{$t('frameleaf_info_no_tags')}</p>
  {/if}

  {#if canEdit}
    <div class="combobox">
      <input
        bind:value={query}
        role="combobox"
        aria-label={$t('frameleaf_info_add_tag')}
        aria-expanded={expanded}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={expanded && options.at(active) ? `${listId}-${active}` : undefined}
        placeholder={$t('frameleaf_info_add_tag')}
        autocomplete="off"
        disabled={busy}
        onfocus={() => {
          open = true;
          void loadTags();
        }}
        onblur={() => (open = false)}
        oninput={() => {
          open = true;
          active = 0;
        }}
        onkeydown={onKeydown}
      />
      <ul
        class="listbox"
        role="listbox"
        id={listId}
        aria-label={$t('frameleaf_info_tag_suggestions')}
        hidden={!expanded}
      >
        {#each options as option, index (`${option.create ? 'new' : 'tag'}:${option.id}`)}
          <!-- The input keeps focus and owns the keys (aria-activedescendant); a pointer press chooses. -->
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <li
            id="{listId}-{index}"
            role="option"
            aria-selected={index === active}
            class:active={index === active}
            onmousedown={(event) => event.preventDefault()}
            onmouseenter={() => (active = index)}
            onclick={() => choose(option)}
          >
            <Icon icon={option.create ? mdiPlus : mdiTagOutline} size="15" aria-hidden />
            {option.create ? $t('frameleaf_info_create_tag', { values: { name: option.label } }) : option.label}
          </li>
        {/each}
      </ul>
    </div>
  {/if}

  {#if failed}
    {@const change = failed}
    <InlineError
      compact
      message={change.kind === 'add' ? $t('frameleaf_info_error_add_tag') : $t('frameleaf_info_error_remove_tag')}
      retrying={busy}
      onRetry={() => run(change)}
    />
  {/if}
</div>

<style>
  .fl-boards-tags {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fl-space-2);
  }
  .chips {
    display: contents;
    list-style: none;
  }
  .chips li {
    display: inline-flex;
    align-items: center;
    gap: var(--fl-space-1);
    min-height: 32px;
    padding: 2px 4px 2px 12px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-pill);
    background: var(--fl-raised);
    font-size: var(--fl-font-small);
  }
  .chips button {
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    color: var(--fl-muted);
  }
  .chips button:hover:not(:disabled) {
    color: var(--fl-text);
    background: var(--fl-border);
  }
  .combobox {
    position: relative;
    flex: 1 1 8rem;
    min-width: 8rem;
  }
  input {
    width: 100%;
    min-height: 32px;
    padding: 0 12px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-pill);
    color: var(--fl-text);
    background: var(--fl-raised);
    font: inherit;
    font-size: var(--fl-font-small);
  }
  input::placeholder {
    color: var(--fl-muted);
  }
  input:focus-visible {
    outline: 2px solid var(--fl-accent);
    outline-offset: 1px;
  }
  /* Opens directly under the field, over what follows it. */
  .listbox {
    position: absolute;
    inset-inline: 0;
    top: calc(100% + 4px);
    z-index: var(--fl-z-popover);
    max-height: 14rem;
    margin: 0;
    padding: 4px;
    overflow-y: auto;
    list-style: none;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    background: var(--fl-panel);
    box-shadow: var(--fl-shadow-2);
  }
  .listbox[hidden] {
    display: none;
  }
  .listbox li {
    display: flex;
    align-items: center;
    gap: var(--fl-space-2);
    min-height: 32px;
    padding: 0 var(--fl-space-2);
    border-radius: var(--fl-radius-sm);
    font-size: var(--fl-font-small);
    cursor: pointer;
    overflow-wrap: anywhere;
  }
  .listbox li.active {
    background: var(--fl-accent-soft);
  }
  .muted {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  button:focus-visible {
    outline: 2px solid var(--fl-accent);
    outline-offset: 2px;
  }
  .fl-boards-tags :global(.fl-inline-error) {
    flex-basis: 100%;
  }
</style>
