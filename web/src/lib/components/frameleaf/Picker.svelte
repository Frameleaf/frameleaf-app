<script lang="ts">
  import Combobox, { type ComboBoxOption } from '$lib/components/shared-components/Combobox.svelte';
  let {
    label,
    options,
    selectedOption = $bindable(),
    disabled = false,
    onSelect,
  }: {
    label: string;
    options: ComboBoxOption[];
    selectedOption?: ComboBoxOption;
    disabled?: boolean;
    onSelect?: (option: ComboBoxOption | undefined) => void;
  } = $props();
</script>

<fieldset class="picker" {disabled}>
  <Combobox {label} {options} bind:selectedOption {disabled} {onSelect} />
</fieldset>

<style>
  .picker {
    border: 0;
    padding: 0;
    margin: 0;
    min-width: 0;
    color: var(--fl-text);
  }
  .picker :global(label),
  .picker :global([role='combobox']),
  .picker :global([role='listbox']),
  .picker :global([role='option']) {
    color: var(--fl-text);
  }
  .picker :global([role='combobox']) {
    background: var(--fl-raised);
    border: 1px solid var(--fl-muted);
    border-radius: var(--fl-radius-control);
    caret-color: var(--fl-accent);
    box-shadow: none;
  }
  .picker :global([role='combobox']::placeholder),
  .picker :global(svg) {
    color: var(--fl-muted);
  }
  .picker :global([role='listbox']) {
    background: var(--fl-panel);
    border-color: var(--fl-muted);
    border-radius: var(--fl-radius-control);
  }
  .picker :global([role='option']) {
    background: var(--fl-panel);
    min-height: 44px;
    align-content: center;
  }
  .picker :global([role='option']:hover),
  .picker :global([role='option'][aria-selected='true']) {
    background: var(--fl-accent);
    color: var(--fl-accent-text);
  }
  .picker :global(button) {
    background: transparent;
    color: var(--fl-text);
  }
  .picker :global(button:hover:not(:disabled)) {
    background: var(--fl-panel);
  }
  @layer base {
    .picker :global([role='combobox']:focus-visible),
    .picker :global(button:focus-visible) {
      /* Same layer as app.css's important reset; scope wins on specificity. */
      outline: 2px solid var(--fl-accent) !important;
      outline-offset: 3px !important;
    }
  }
  .picker :global([role='option'][aria-disabled='true']),
  .picker:disabled :global([role='combobox']),
  .picker:disabled :global(button) {
    color: var(--fl-muted);
    background: var(--fl-raised);
    cursor: default;
    opacity: 1;
  }
  .picker:disabled :global([role='listbox']) {
    display: none;
  }
  @media (pointer: coarse) {
    .picker :global([role='option']) {
      min-height: 48px;
    }
  }
</style>
