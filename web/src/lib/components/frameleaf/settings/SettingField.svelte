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

<!--
  Sept 24 compact row (apple-style.css:1014-1045, CommandCenter.jsx:1601-1715): label and help on the
  left, the control right-aligned beside them inside a Command Center page; stacked in a narrow
  container or anywhere else (dialogs, onboarding).
-->
<div class="field" class:edited={isEdited}>
  <div class="copy">
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
  </div>

  {#if inputType === SettingInputFieldType.PASSWORD}
    <div class="control">
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
    </div>
  {:else}
    <div class="control" class:number={inputType === SettingInputFieldType.NUMBER}>
      {#if inputType === SettingInputFieldType.COLOR}
        <input class="swatch" aria-label={label} type="color" bind:value onchange={handleChange} {disabled} {title} />
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
  .copy {
    min-width: 0;
  }
  .label-line {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
  }
  label {
    color: var(--fl-text);
    font-size: 14px;
    font-weight: 500;
  }
  .required {
    color: var(--fl-danger);
  }
  /* The prototype's changed dot, with the words beside it so the state is not colour alone. */
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
  p,
  .description {
    margin: 4px 0 0;
    color: var(--fl-muted);
    font-size: 12.5px;
    line-height: 1.45;
  }
  .control {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  input {
    width: 100%;
    min-width: 3rem;
    padding: 7px 10px;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    font: inherit;
    font-size: 13px;
    font-variant-numeric: tabular-nums;
  }
  input:disabled {
    color: var(--fl-muted);
    background: var(--fl-canvas);
  }
  .swatch {
    width: 2.25rem;
    min-width: 2.25rem;
    height: 2.25rem;
    padding: 0.25rem;
    cursor: pointer;
  }
  @container settings (min-width: 560px) {
    .field {
      grid-template-columns: minmax(0, 1fr) minmax(180px, 280px);
      align-items: center;
      gap: 24px;
    }
    .control {
      justify-content: flex-end;
    }
    .control.number input {
      width: 105px;
      text-align: end;
    }
  }
</style>
