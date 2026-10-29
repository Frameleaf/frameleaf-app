<script lang="ts">
  import { tick } from "svelte";
  import Icon from "./Icon.svelte";
  import {
    collectionColour,
    collectionPath,
    collectionTree,
    type CollectionChoice,
  } from "./collections";
  let {
    collections,
    value = $bindable(""),
    disabled = false,
    createLocked = false,
    onCreate,
    onRefresh,
  }: {
    collections: CollectionChoice[];
    value?: string;
    disabled?: boolean;
    /** After an unconfirmed create, creating again waits for a refresh. */
    createLocked?: boolean;
    onCreate: (name: string, parentId: string) => Promise<boolean>;
    onRefresh: () => Promise<void>;
  } = $props();
  const uid = Math.random().toString(36).slice(2);
  let open = $state(false);
  let query = $state("");
  let creating = $state(false);
  let newName = $state("");
  let root = $state<HTMLDivElement>();
  let trigger = $state<HTMLButtonElement>();
  let search = $state<HTMLInputElement>();
  let nameInput = $state<HTMLInputElement>();
  const chosen = $derived(collections.find((item) => item.id === value));
  const chosenPath = $derived(chosen ? collectionPath(collections, chosen.id) : []);
  const tree = $derived(collectionTree(collections));
  const shown = $derived.by(() => {
    const needle = query.trim().toLowerCase();
    return needle
      ? tree.filter(({ collection }) =>
          collection.albumName.toLowerCase().includes(needle),
        )
      : tree;
  });
  const inside = (id: string) => collectionPath(collections, id).slice(0, -1);
  async function show() {
    open = true;
    await tick();
    search?.focus();
  }
  function close(focusTrigger = true) {
    open = false;
    creating = false;
    query = "";
    if (focusTrigger) void tick().then(() => trigger?.focus());
  }
  function choose(id: string) {
    value = id;
    close();
  }
  async function startCreating() {
    newName = query.trim();
    creating = true;
    await tick();
    nameInput?.focus();
  }
  async function create(event: SubmitEvent) {
    event.preventDefault();
    if (!newName.trim() || createLocked || disabled) return;
    if (await onCreate(newName.trim(), value)) {
      newName = "";
      close();
    }
  }
  function keydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.stopPropagation();
      if (creating) creating = false;
      else close();
    }
  }
  function outside(event: PointerEvent) {
    if (open && root && !root.contains(event.target as Node)) close(false);
  }
</script>

<svelte:window onpointerdown={outside} />

<div class="field picker" bind:this={root}>
  <span class="label" id={`save-to-${uid}`}>Save to</span>
  <button
    bind:this={trigger}
    type="button"
    class="select-button"
    aria-expanded={open}
    aria-controls={`collections-${uid}`}
    aria-labelledby={`save-to-${uid} save-to-value-${uid}`}
    {disabled}
    onclick={() => (open ? close() : void show())}
  >
    <Icon
      name={chosen ? "folderOutline" : "folderPlusOutline"}
      color={collectionColour(chosen)}
    />
    <span class="select-value" id={`save-to-value-${uid}`}
      >{#if chosen}{chosen.albumName}{#if chosenPath.length > 1}<small>
            {` · in ${chosenPath.slice(0, -1).join(" › ")}`}</small
          >{/if}{:else}<span class="muted">Choose a collection</span>{/if}</span
    >
    <Icon name={open ? "chevronUp" : "chevronDown"} />
  </button>
  {#if open}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="picker-panel"
      id={`collections-${uid}`}
      role="group"
      aria-label="Collections"
      onkeydown={keydown}
    >
      <input
        bind:this={search}
        type="search"
        placeholder="Find a collection"
        aria-label="Find a collection"
        bind:value={query}
      />
      {#if shown.length}
        <ul class="picker-list">
          {#each shown as { collection, depth, hasChildren } (collection.id)}
            <li>
              <button
                type="button"
                aria-pressed={collection.id === value}
                style:padding-left={`${10 + (query ? 0 : depth * 14)}px`}
                onclick={() => choose(collection.id)}
                ><Icon
                  name={hasChildren ? "folderMultipleOutline" : "folderOutline"}
                  color={collectionColour(collection)}
                /><span class="picker-name"
                  >{collection.albumName}{#if query && inside(collection.id).length}<small
                      >{` · in ${inside(collection.id).join(" › ")}`}</small
                    >{/if}</span
                ></button
              >
            </li>
          {/each}
        </ul>
      {:else}
        <p class="hint">
          {collections.length
            ? "No collection has that name."
            : "You don’t have a collection to save into yet."}
        </p>
      {/if}
      {#if creating}
        <form class="picker-create" onsubmit={create}>
          <label for={`new-collection-${uid}`}>New collection name</label>
          <input
            bind:this={nameInput}
            id={`new-collection-${uid}`}
            maxlength="255"
            disabled={disabled || createLocked}
            bind:value={newName}
          />
          <small class="hint"
            >Inside {chosen ? chosen.albumName : "the top level"}</small
          >
          <div class="row-actions">
            <button type="button" onclick={() => (creating = false)}
              >Cancel</button
            >
            <button
              type="submit"
              class="primary"
              disabled={disabled || createLocked || !newName.trim()}
              >Create</button
            >
          </div>
        </form>
      {/if}
      <div class="picker-foot">
        {#if !creating}<button
            type="button"
            class="link-button"
            disabled={disabled || createLocked}
            onclick={() => void startCreating()}
            ><Icon name="folderPlusOutline" />New collection{query.trim()
              ? ` “${query.trim()}”`
              : ""}</button
          >{/if}
        <button
          type="button"
          class="icon-button"
          aria-label="Refresh collections"
          title="Refresh collections"
          {disabled}
          onclick={() => void onRefresh()}><Icon name="refresh" /></button
        >
      </div>
      {#if createLocked}<p class="hint">
          Refresh collections before creating another. The last request may
          have worked.
        </p>{/if}
    </div>
  {/if}
</div>
