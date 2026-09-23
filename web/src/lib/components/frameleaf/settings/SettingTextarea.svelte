<script lang="ts">
  /**
   * A labelled multi-line field for the Frameleaf settings pages (FL-71). Same props as the
   * route-local SettingTextarea it replaces. Callers pick exactly one of `bind:value` or
   * `onChange`: with `onChange` the parent owns the assignment.
   */
  import type { Snippet } from 'svelte';
  import { t } from 'svelte-i18n';

  interface Props {
    value: string;
    label?: string;
    description?: string;
    required?: boolean;
    disabled?: boolean;
    isEdited?: boolean;
    descriptionSnippet?: Snippet;
    onChange?: (value: string) => void;
  }

  let {
    value = $bindable(),
    label = '',
    description = '',
    required = false,
    disabled = false,
    isEdited = false,
    descriptionSnippet,
    onChange,
  }: Props = $props();

  const id = $props.id();
  const descId = $derived(description || descriptionSnippet ? `${id}-desc` : undefined);

  const handleInput = (e: Event) => {
    const next = (e.target as HTMLTextAreaElement).value;
    if (onChange) {
      onChange(next);
    } else {
      value = next;
    }
  };
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
    <p id={descId}>{description}</p>
  {:else if descriptionSnippet}
    <div id={descId} class="description">{@render descriptionSnippet()}</div>
  {/if}

  <textarea aria-describedby={descId} {id} name={id} {required} {value} oninput={handleInput} {disabled}></textarea>
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
  textarea {
    width: 100%;
    min-height: 6rem;
    padding: 0.5rem 0.75rem;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    font: inherit;
    resize: vertical;
  }
  textarea:disabled {
    color: var(--fl-muted);
    background: var(--fl-canvas);
  }
</style>
