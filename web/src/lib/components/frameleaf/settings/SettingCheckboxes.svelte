<script lang="ts" generics="T extends string | number">
  /**
   * A labelled multi-choice list for the Frameleaf settings pages (FL-71). Same props as the
   * route-local SettingCheckboxes it replaces; `lockedOptions` stay checked and disabled.
   */
  import { t } from 'svelte-i18n';

  interface Props {
    value: T[];
    options: { value: T; text: string }[];
    label?: string;
    desc?: string;
    name?: string;
    isEdited?: boolean;
    disabled?: boolean;
    lockedOptions?: T[];
  }

  let {
    value = $bindable(),
    options,
    label = '',
    desc = '',
    name = '',
    isEdited = false,
    disabled = false,
    lockedOptions = [],
  }: Props = $props();

  const id = $props.id();
  const descId = $derived(desc ? `${id}-desc` : undefined);

  function toggle(option: T) {
    value = value.includes(option) ? value.filter((item) => item !== option) : [...value, option];
  }
</script>

<fieldset class="field" aria-describedby={descId}>
  <legend>
    <span class="label">{label}</span>
    {#if isEdited}
      <span class="unsaved">{$t('unsaved_change')}</span>
    {/if}
  </legend>

  {#if desc}
    <p id={descId}>{desc}</p>
  {/if}

  <div class="options">
    {#each options as option (option.value)}
      <label class="option">
        <input
          type="checkbox"
          name={name || id}
          value={option.value}
          checked={value.includes(option.value)}
          disabled={disabled || lockedOptions.includes(option.value)}
          onchange={() => toggle(option.value)}
        />
        <span>{option.text}</span>
      </label>
    {/each}
  </div>
</fieldset>

<style>
  .field {
    width: 100%;
    margin: 0 0 1rem;
    padding: 0;
    border: 0;
    min-width: 0;
  }
  legend {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem;
    padding: 0;
    min-height: 1.5rem;
  }
  .label {
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
  .options {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .option {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    min-height: 2.75rem;
    color: var(--fl-text);
  }
  input[type='checkbox'] {
    width: 1.125rem;
    height: 1.125rem;
    min-height: 0;
    accent-color: var(--fl-accent);
  }
  .option:has(input:disabled) {
    color: var(--fl-muted);
  }
</style>
