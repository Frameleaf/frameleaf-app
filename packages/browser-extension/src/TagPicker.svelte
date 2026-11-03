<script lang="ts">
  import type { TagResponseDto } from "@frameleaf/sdk";
  import Icon from "./Icon.svelte";
  let {
    tags,
    selected = $bindable([]),
    disabled = false,
  }: {
    tags: TagResponseDto[];
    selected?: string[];
    disabled?: boolean;
  } = $props();
  const uid = Math.random().toString(36).slice(2);
  let query = $state("");
  let open = $state(false);
  let active = $state(0);
  let input = $state<HTMLInputElement>();
  const chosen = $derived(
    selected
      .map((id) => tags.find((tag) => tag.id === id))
      .filter((tag): tag is TagResponseDto => !!tag),
  );
  const suggestions = $derived.by(() => {
    const needle = query.trim().toLowerCase();
    return tags
      .filter(
        (tag) =>
          !selected.includes(tag.id) &&
          (!needle || tag.value.toLowerCase().includes(needle)),
      )
      .slice(0, 8);
  });
  const expanded = $derived(open && suggestions.length > 0);
  function add(tag: TagResponseDto) {
    if (!selected.includes(tag.id)) selected = [...selected, tag.id];
    query = "";
    active = 0;
    input?.focus();
  }
  function remove(id: string) {
    selected = selected.filter((value) => value !== id);
    input?.focus();
  }
  function keydown(event: KeyboardEvent) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      open = true;
      if (suggestions.length)
        active =
          (active + (event.key === "ArrowDown" ? 1 : -1) + suggestions.length) %
          suggestions.length;
    } else if (event.key === "Enter") {
      if (expanded && suggestions[active]) {
        event.preventDefault();
        add(suggestions[active]);
      }
    } else if (event.key === "Escape") {
      if (open) {
        event.stopPropagation();
        open = false;
      }
    } else if (event.key === "Backspace" && !query && selected.length) {
      selected = selected.slice(0, -1);
    }
  }
</script>

<div class="field tag-field">
  <label for={`tags-${uid}`}>Tags</label>
  <div class="tag-box" class:disabled>
    {#each chosen as tag (tag.id)}
      <span class="tag-chip"
        >{tag.value}<button
          type="button"
          aria-label={`Remove ${tag.value}`}
          {disabled}
          onclick={() => remove(tag.id)}><Icon name="close" size={12} /></button
        ></span
      >
    {/each}
    <input
      bind:this={input}
      id={`tags-${uid}`}
      role="combobox"
      aria-expanded={expanded}
      aria-controls={`tag-options-${uid}`}
      aria-autocomplete="list"
      aria-activedescendant={expanded
        ? `tag-option-${uid}-${active}`
        : undefined}
      autocomplete="off"
      placeholder={tags.length ? "Add a tag" : "No tags yet"}
      {disabled}
      bind:value={query}
      oninput={() => {
        open = true;
        active = 0;
      }}
      onfocus={() => (open = true)}
      onblur={() => (open = false)}
      onkeydown={keydown}
    />
  </div>
  <ul
    class="tag-options"
    id={`tag-options-${uid}`}
    role="listbox"
    aria-label="Tag suggestions"
    hidden={!expanded}
  >
    {#each suggestions as tag, index (tag.id)}
      <li
        id={`tag-option-${uid}-${index}`}
        role="option"
        aria-selected={index === active}
        onpointerdown={(event) => {
          event.preventDefault();
          add(tag);
        }}
      >
        {tag.value}
      </li>
    {/each}
  </ul>
  {#if open && query.trim() && !suggestions.length}<p class="hint">
      No tag called “{query.trim()}”. Make new tags in Frameleaf.
    </p>{/if}
</div>
