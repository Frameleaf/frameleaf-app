<script lang="ts">
  import { generateId } from '$lib/utils/generate-id';

  interface Props {
    filters: string[];
    labels?: string[];
    selected: string;
    label: string;
    onSelect: (selected: string) => void;
  }

  let { filters, selected, label, labels, onSelect }: Props = $props();

  const id = `group-tab-${generateId()}`;
</script>

<fieldset
  class="flex h-full rounded-lg border border-(--fl-border) bg-(--fl-raised) ring-(--fl-accent) has-focus-visible:ring-2"
>
  <legend class="sr-only">{label}</legend>
  {#each filters as filter, index (`${id}-${index}`)}
    <div class="group">
      <input
        type="radio"
        name={id}
        id="{id}-{index}"
        class="peer sr-only"
        value={filter}
        checked={filter === selected}
        onchange={() => onSelect(filter)}
      />
      <label
        for="{id}-{index}"
        class="flex h-full cursor-pointer items-center px-4 text-sm text-(--fl-muted) transition-colors group-first-of-type:rounded-s-lg group-last-of-type:rounded-e-lg peer-checked:bg-(--fl-panel) peer-checked:text-(--fl-text) hover:text-(--fl-text)"
      >
        {labels?.[index] ?? filter}
      </label>
    </div>
  {/each}
</fieldset>
