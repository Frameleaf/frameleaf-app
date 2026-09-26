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
    /** A row the server's policy fixes (the template's locked field, `CommandCenter.jsx:1632-1636`). */
    policy?: string;
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
    policy,
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

<!-- Sept 24 compact row: the choice sits right-aligned beside its label (apple-style.css:1014-1045). -->
<div class="field" class:edited={isEdited}>
  <div class="copy">
    <div class="label-line">
      <label for={id}>{label}</label>
      {#if isEdited}
        <span class="unsaved">{$t('unsaved_change')}</span>
      {/if}
    </div>

    {#if desc}
      <p id={descId}>{desc}</p>
    {/if}
    {#if policy}
      <small class="locked">{policy}</small>
    {/if}
  </div>

  <div class="control">
    <select {id} name={name || id} {disabled} aria-describedby={descId} bind:value onchange={handleChange}>
      {#each options as option (option.value)}
        <option value={option.value}>{option.text}</option>
      {/each}
    </select>
    <span class="chevron" aria-hidden="true"><Icon icon={mdiChevronDown} size="1rem" /></span>
  </div>
</div>

<style>
  .field {
    display: grid;
    gap: 8px;
    width: 100%;
    padding: 14px 0;
    border-top: 1px solid var(--fl-border);
  }
  .field:first-child {
    border-top: 0;
  }
  .field.edited {
    margin-inline-start: -12px;
    padding-inline-start: 12px;
    box-shadow: inset 3px 0 var(--fl-warning);
  }
  /* command-center.css `.cc-locked` */
  .locked {
    display: block;
    margin-top: 8px;
    color: var(--fl-muted);
    font-size: 10px;
  }
  .copy {
    min-width: 0;
  }
  .label-line {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
  }
  .unsaved {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--fl-warning);
    font-size: 11px;
    font-weight: 600;
  }
  .unsaved::before {
    content: '';
    width: 5px;
    height: 5px;
    background: currentColor;
    border-radius: 50%;
  }
  label {
    color: var(--fl-text);
    font-size: 14px;
    font-weight: 500;
  }
  p {
    margin: 4px 0 0;
    color: var(--fl-muted);
    font-size: 12.5px;
    line-height: 1.45;
  }
  .control {
    position: relative;
    display: grid;
    min-width: 0;
  }
  select {
    width: 100%;
    appearance: none;
    padding: 7px 2rem 7px 10px;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    font: inherit;
    font-size: 13px;
  }
  select:disabled {
    color: var(--fl-muted);
    background: var(--fl-canvas);
  }
  .chevron {
    position: absolute;
    inset-inline-end: 0.5rem;
    inset-block: 0;
    display: grid;
    place-items: center;
    pointer-events: none;
    color: var(--fl-muted);
  }
  @container settings (min-width: 560px) {
    .field {
      grid-template-columns: minmax(0, 1fr) minmax(180px, 280px);
      align-items: center;
      gap: 24px;
    }
  }
</style>
