<script lang="ts">
  /**
   * A labelled text, number, email, colour or password field for the Frameleaf settings pages
   * (FL-71). Same props and clamping behaviour as the legacy SettingInputField so the existing
   * system-config forms keep their bindings; ids are generated so a repeated label never
   * produces duplicate ids.
   */
  import { SettingInputFieldType } from '$lib/constants';
  import { PasswordInput } from '@immich/ui';
  import { onMount, tick, type Snippet } from 'svelte';
  import { t } from 'svelte-i18n';
  import type { FormEventHandler } from 'svelte/elements';

  type Props = {
    min?: number;
    max?: number;
    step?: string;
    label?: string;
    description?: string;
    title?: string;
    required?: boolean;
    disabled?: boolean;
    isEdited?: boolean;
    autofocus?: boolean;
    passwordAutocomplete?: AutoFill;
    placeholder?: string;
    descriptionSnippet?: Snippet;
    trailingSnippet?: Snippet;
  } & (
    | { inputType: SettingInputFieldType.PASSWORD; value: string }
    | { inputType: SettingInputFieldType.NUMBER; value: number | null | undefined }
    | {
        inputType: SettingInputFieldType.TEXT | SettingInputFieldType.COLOR | SettingInputFieldType.EMAIL;
        value: string | null | undefined;
      }
  );

  let {
    inputType,
    value = $bindable(),
    min = Number.MIN_SAFE_INTEGER,
    max = Number.MAX_SAFE_INTEGER,
    step = '1',
    label = '',
    description = '',
    title = '',
    required = false,
    disabled = false,
    isEdited = false,
    autofocus = false,
    passwordAutocomplete = 'current-password',
    placeholder,
    descriptionSnippet,
    trailingSnippet,
  }: Props = $props();

  const id = $props.id();
  const descriptionId = $derived(description || descriptionSnippet ? `${id}-desc` : undefined);

  let input: HTMLInputElement | undefined = $state();

  const handleChange: FormEventHandler<HTMLInputElement> = (e) => {
    value = e.currentTarget.value;

    if (inputType === SettingInputFieldType.NUMBER) {
      if (value === '' && !required) {
        value = null;
        return;
      }

      let newValue = Number(value) || 0;
      if (newValue < min) {
        newValue = min;
      }
      if (newValue > max) {
        newValue = max;
      }
      value = newValue;
    }
  };

  onMount(() => {
    if (autofocus) {
      tick()
        .then(() => setTimeout(() => input?.focus(), 0))
        .catch(() => {});
    }
  });
</script>

<div class="field">
  <div class="label-line">
    <label for={id}>{label}</label>
    {#if required}
      <span class="required" aria-hidden="true">*</span>
    {/if}
    {#if isEdited}
      <span class="unsaved">{$t('unsaved_change')}</span>
    {/if}
  </div>

  {#if description}
    <p id={descriptionId}>{description}</p>
  {:else if descriptionSnippet}
    <div id={descriptionId} class="description">{@render descriptionSnippet()}</div>
  {/if}

  {#if inputType === SettingInputFieldType.PASSWORD}
    <PasswordInput
      aria-describedby={descriptionId}
      size="small"
      {id}
      name={id}
      autocomplete={passwordAutocomplete}
      {required}
      bind:value={value as string}
      {disabled}
      {title}
      {placeholder}
    />
  {:else}
    <div class="control">
      {#if inputType === SettingInputFieldType.COLOR}
        <input
          class="swatch"
          aria-label={label}
          type="color"
          bind:value
          onchange={handleChange}
          {disabled}
          {title}
        />
      {/if}
      <input
        bind:this={input}
        aria-describedby={descriptionId}
        {id}
        name={id}
        type={inputType === SettingInputFieldType.COLOR ? 'text' : inputType}
        min={min.toString()}
        max={max.toString()}
        {step}
        {required}
        {placeholder}
        bind:value
        onchange={handleChange}
        {disabled}
        {title}
      />
      {@render trailingSnippet?.()}
    </div>
  {/if}
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
  .required {
    color: var(--fl-danger);
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
  p,
  .description {
    margin: 0.125rem 0 0.5rem;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.5;
  }
  .control {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  input {
    width: 100%;
    min-width: 3rem;
    padding: 0.5rem 0.75rem;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    font: inherit;
  }
  input:disabled {
    color: var(--fl-muted);
    background: var(--fl-canvas);
  }
  .swatch {
    width: 2.75rem;
    min-width: 2.75rem;
    height: 2.75rem;
    padding: 0.25rem;
    cursor: pointer;
  }
</style>
