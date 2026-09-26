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

<!-- Sept 24 compact row; the options list under its label, in two columns where the page allows. -->
<fieldset class="field" class:edited={isEdited} aria-describedby={descId}>
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
    min-width: 0;
    margin: 0;
    padding: 14px 0;
    border: 0;
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
  legend {
    display: flex;
    float: left;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    width: 100%;
    padding: 0;
  }
  legend + * {
    clear: both;
  }
  .label {
    color: var(--fl-text);
    font-size: 14px;
    font-weight: 500;
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
  p {
    margin: 4px 0 0;
    color: var(--fl-muted);
    font-size: 12.5px;
    line-height: 1.45;
  }
  .options {
    display: grid;
    gap: 0 16px;
    margin-top: 6px;
  }
  .option {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 2.25rem;
    color: var(--fl-text);
    font-size: 13px;
  }
  input[type='checkbox'] {
    width: 1rem;
    height: 1rem;
    min-height: 0;
    accent-color: var(--fl-accent);
  }
  .option:has(input:disabled) {
    color: var(--fl-muted);
  }
  @container settings (min-width: 560px) {
    .options {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
</style>
