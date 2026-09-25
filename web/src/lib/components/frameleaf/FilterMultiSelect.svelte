<script lang="ts">
  import PersonAvatar from '$lib/components/frameleaf/PersonAvatar.svelte';
  import {
    moveSetGroup,
    SET_GROUP_LABEL_KEYS,
    SET_GROUPS,
    updateSetGroup,
    type SetCondition,
    type SetGroup,
  } from '$lib/frameleaf/search-filters';
  import '$lib/frameleaf/tokens.css';
  import type { PersonResponseDto } from '@immich/sdk';
  import { t } from 'svelte-i18n';

  /**
   * The id-set filter section from the prototype's `FilterPanel.jsx` `MultiFilter` (FL-49).
   *
   * A `SearchFilter` id condition can hold three groups at once — `any`, `all` and `none` —
   * and the control edits exactly one of them. The other groups stay active and are
   * summarised above the list with their own Edit link, so switching the matching mode never
   * silently drops a condition the user set earlier. Moving a group merges into the target
   * rather than replacing it, which is what `moveSetGroup` guarantees.
   *
   * Options come from the caller, which loads them from the real people/tags/albums APIs.
   */
  let {
    field,
    anchor,
    label,
    options,
    condition,
    people,
    onChange,
  }: {
    field: string;
    /**
     * The `data-section` name the Filter control deep-links to. It is the section vocabulary
     * from `query.ts` ("people", "tags"), not the filter field, so a deep link and a chip's
     * section agree.
     */
    anchor: string;
    label: string;
    /** `count` is the facet count for the current search (FL-49), when the caller has one. */
    options: { value: string; label: string; count?: number }[];
    condition: SetCondition;
    /** Supplied for the People section only; each option renders its face thumbnail. */
    people?: PersonResponseDto[];
    onChange: (field: string, condition: SetCondition) => void;
  } = $props();

  let term = $state('');
  let preferred = $state<SetGroup | null>(null);

  const mode = $derived<SetGroup>(preferred ?? SET_GROUPS.find((group) => condition?.[group]?.length) ?? 'any');
  const selected = $derived(condition?.[mode] ?? []);
  const activeGroups = $derived(SET_GROUPS.filter((group) => condition?.[group]?.length));
  const retainedGroups = $derived(activeGroups.filter((group) => group !== mode));
  /**
   * FL-31: "removable zero-match filter choices retained". A chosen value the list no longer offers
   * (its facet count fell to nothing, or it is no longer readable) stays listed, checked and
   * removable, instead of silently staying applied with no way to see or clear it here.
   */
  const retained = $derived(
    selected
      .filter((value) => options.every((option) => option.value !== value))
      .map((value) => ({ value, label: $t('frameleaf_search_unavailable_choice'), count: 0 as number | undefined })),
  );
  const matches = $derived([
    ...retained,
    ...options.filter((option) => option.label.toLowerCase().includes(term.trim().toLowerCase())),
  ]);

  const nameFor = (value: string) => options.find((option) => option.value === value)?.label ?? value;

  const toggle = (value: string) =>
    onChange(
      field,
      updateSetGroup(
        condition,
        mode,
        selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value],
      ),
    );
</script>

<section class="filter-section" data-section={anchor}>
  <div class="heading">
    <h3>{label}</h3>
    <label class="mode">
      <span class="sr-only">{$t('frameleaf_search_matching_for', { values: { label } })}</span>
      <select
        value={mode}
        onchange={(event) => {
          const next = event.currentTarget.value as SetGroup;
          onChange(field, moveSetGroup(condition, mode, next));
          preferred = next;
        }}
      >
        {#each SET_GROUPS as group (group)}
          <option value={group}>{$t(SET_GROUP_LABEL_KEYS[group])}</option>
        {/each}
      </select>
    </label>
  </div>

  {#if activeGroups.length > 1}
    <p class="muted">{$t('frameleaf_search_other_selections_active')}</p>
  {/if}

  {#each retainedGroups as group (group)}
    <p class="muted summary">
      {$t(SET_GROUP_LABEL_KEYS[group])}: {(condition?.[group] ?? []).map((value) => nameFor(value)).join(', ')}
      <button type="button" class="text" onclick={() => (preferred = group)}>
        {$t('frameleaf_search_edit_group', { values: { group: $t(SET_GROUP_LABEL_KEYS[group]) } })}
      </button>
    </p>
  {/each}

  {#if activeGroups.length > 0}
    <div class="group-actions">
      {#each SET_GROUPS.filter((group) => group !== mode && !condition?.[group]?.length) as group (group)}
        <button type="button" class="text" onclick={() => (preferred = group)}>
          {$t('frameleaf_search_add_group', { values: { group: $t(SET_GROUP_LABEL_KEYS[group]) } })}
        </button>
      {/each}
    </div>
  {/if}

  <input
    class="find"
    type="search"
    aria-label={$t('frameleaf_search_find_in', { values: { label } })}
    placeholder={$t('frameleaf_search_find_in', { values: { label } })}
    bind:value={term}
  />

  <div class="options">
    {#each matches as option (option.value)}
      <label class="option" class:selected={selected.includes(option.value)}>
        <input type="checkbox" checked={selected.includes(option.value)} onchange={() => toggle(option.value)} />
        {#if people}
          <PersonAvatar person={people.find((person) => person.id === option.value)} size={34} />
        {/if}
        <span>{option.label}</span>
        {#if option.count !== undefined}
          <small class="count">{option.count.toLocaleString()}</small>
        {/if}
      </label>
    {/each}
    {#if matches.length === 0}
      <p class="muted">{$t('frameleaf_search_no_matches_in', { values: { label: label.toLowerCase() } })}</p>
    {/if}
  </div>
</section>

<style>
  .filter-section {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding-block: 0.875rem;
    border-bottom: 1px solid var(--fl-border);
  }
  .heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }
  h3 {
    font-size: 0.875rem;
    font-weight: 600;
  }
  select,
  .find {
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    padding: 0.3125rem 0.5rem;
    font-size: var(--fl-font-small);
    min-height: 32px;
  }
  .muted {
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .summary {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
    align-items: baseline;
  }
  .group-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
  }
  .text {
    color: var(--fl-accent);
    background: none;
    border: 0;
    padding: 0;
    font-size: var(--fl-font-small);
    text-decoration: underline;
  }
  .count {
    margin-inline-start: auto;
    font-size: var(--fl-font-small);
    font-variant-numeric: tabular-nums;
    color: var(--fl-muted);
  }
  .options {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    max-height: 13rem;
    overflow-y: auto;
  }
  .option {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-height: 36px;
    padding: 0.25rem 0.375rem;
    border-radius: var(--fl-radius);
  }
  .option:hover {
    background: var(--fl-raised);
  }
  .option.selected {
    background: var(--fl-accent-soft);
    box-shadow: inset 0 0 0 1px var(--fl-accent);
  }
  .option span {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }
</style>
