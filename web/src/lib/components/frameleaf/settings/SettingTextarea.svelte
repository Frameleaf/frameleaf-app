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

<!--
  Sept 24 compact row. A multi-line value (templates, prompts, custom CSS) keeps the full width of
  the page under its label instead of the narrow control column.
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
      <p id={descId}>{description}</p>
    {:else if descriptionSnippet}
      <div id={descId} class="description">{@render descriptionSnippet()}</div>
    {/if}
  </div>

  <textarea aria-describedby={descId} {id} name={id} {required} {value} oninput={handleInput} {disabled}></textarea>
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
  .required {
    color: var(--fl-danger);
  }
  p,
  .description {
    margin: 4px 0 0;
    color: var(--fl-muted);
    font-size: 12.5px;
    line-height: 1.45;
  }
  textarea {
    width: 100%;
    min-height: 5.5rem;
    padding: 8px 10px;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    font: inherit;
    font-size: 13px;
    line-height: 1.5;
    resize: vertical;
  }
  textarea:disabled {
    color: var(--fl-muted);
    background: var(--fl-canvas);
  }
</style>
