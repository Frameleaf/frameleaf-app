<script lang="ts">
  /**
   * A labelled single choice for the Frameleaf settings pages (FL-71). Same props as the
   * route-local SettingSelect it replaces; a native select keeps keyboard and screen-reader
   * behaviour and the option list stays data the caller owns.
   */
  import { Icon } from '@immich/ui';
  import { mdiChevronDown } from '@mdi/js';
  import { t } from 'svelte-i18n';

  interface Props {
    value: string | number | undefined;
    options: { value: string | number; text: string }[];
    label?: string;
    desc?: string;
    name?: string;
    isEdited?: boolean;
    number?: boolean;
    disabled?: boolean;
    onSelect?: (setting: string | number) => void;
  }

  let {
    value = $bindable(),
    options,
    label = '',
    desc = '',
    name = '',
    isEdited = false,
    number = false,
    disabled = false,
    onSelect = () => {},
  }: Props = $props();

  const id = $props.id();
  const descId = $derived(desc ? `${id}-desc` : undefined);

  const handleChange = (e: Event) => {
    value = (e.target as HTMLSelectElement).value;
    if (number) {
      value = Number.parseInt(value);
    }
    onSelect(value);
  };
</script>

<div class="field">
  <div class="label-line">
    <label for={id}>{label}</label>
    {#if isEdited}
      <span class="unsaved">{$t('unsaved_change')}</span>
    {/if}
  </div>

  {#if desc}
    <p id={descId}>{desc}</p>
  {/if}

  <div class="control">
    <select {id} name={name || id} {disabled} aria-describedby={descId} bind:value onchange={handleChange}>
      {#each options as option (option.value)}
        <option value={option.value}>{option.text}</option>
      {/each}
    </select>
    <span class="chevron" aria-hidden="true"><Icon icon={mdiChevronDown} size="1.125rem" /></span>
  </div>
</div>

<style>
  .field {
    width: 100%;
    margin-bottom: 1rem;
  }
  .label-line {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem;
    min-height: 1.5rem;
  }
  label {
    font-weight: 550;
    color: var(--fl-text);
  }
  .unsaved {
    display: inline-flex;
    align-items: center;
    padding: 0 0.5rem;
    min-height: 1.25rem;
    border-radius: var(--fl-radius-pill);
    background: var(--fl-warning);
    color: var(--fl-warning-text);
    font-size: var(--fl-font-micro);
    font-weight: 600;
  }
  p {
    margin: 0.125rem 0 0.5rem;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.5;
  }
  .control {
    position: relative;
    display: grid;
  }
  select {
    width: 100%;
    appearance: none;
    padding: 0.5rem 2.25rem 0.5rem 0.75rem;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    font: inherit;
  }
  select:disabled {
    color: var(--fl-muted);
    background: var(--fl-canvas);
  }
  .chevron {
    position: absolute;
    inset-inline-end: 0.625rem;
    inset-block: 0;
    display: grid;
    place-items: center;
    pointer-events: none;
    color: var(--fl-muted);
  }
</style>
