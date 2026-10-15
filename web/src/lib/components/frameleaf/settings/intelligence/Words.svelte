<script lang="ts">
  /**
   * A short list of words as removable chips, with a box to add one (the prototype's `Words` in
   * `settings-v2/care/shared.jsx`). It reports the whole new list; the page owns the value.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { Icon } from '@frameleaf/ui';
  import { mdiClose } from '@mdi/js';
  import { t } from 'svelte-i18n';

  let {
    label,
    words,
    disabled = false,
    onChange,
  }: {
    label: string;
    words: readonly string[];
    disabled?: boolean;
    onChange: (words: string[]) => void;
  } = $props();

  let draft = $state('');

  const add = (event: SubmitEvent) => {
    event.preventDefault();
    const word = draft.trim();
    if (word && words.every((item) => item.toLowerCase() !== word.toLowerCase())) {
      onChange([...words, word]);
    }
    draft = '';
  };
</script>

<div class="words" role="group" aria-label={label}>
  {#if words.length > 0}
    <ul>
      {#each words as word (word)}
        <li>
          <span>{word}</span>
          <button
            type="button"
            aria-label={$t('frameleaf_intel_words_remove', { values: { word } })}
            {disabled}
            onclick={() => onChange(words.filter((item) => item !== word))}
          >
            <Icon icon={mdiClose} size="14" aria-hidden />
          </button>
        </li>
      {/each}
    </ul>
  {/if}
  <form onsubmit={add}>
    <input
      type="text"
      aria-label={$t('frameleaf_intel_words_add_label', { values: { list: label } })}
      placeholder={$t('frameleaf_intel_words_add_placeholder')}
      autocomplete="off"
      {disabled}
      bind:value={draft}
    />
    <Button type="submit" disabled={disabled || !draft.trim()}>{$t('frameleaf_intel_words_add')}</Button>
  </form>
</div>

<style>
  .words {
    display: flex;
    flex-direction: column;
    gap: var(--fl-space-3);
    margin-bottom: var(--fl-space-5);
  }
  ul {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li {
    display: inline-flex;
    align-items: center;
    gap: var(--fl-space-1);
    min-height: 32px;
    padding: 0 var(--fl-space-1) 0 var(--fl-space-3);
    color: var(--fl-text);
    font-size: var(--fl-font-callout);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: 999px;
  }
  li button {
    display: inline-grid;
    place-items: center;
    width: 24px;
    height: 24px;
    color: var(--fl-muted);
    background: none;
    border: 0;
    border-radius: 50%;
    cursor: pointer;
  }
  li button:hover {
    color: var(--fl-text);
  }
  li button:disabled {
    cursor: default;
    opacity: 0.6;
  }
  li button:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
  form {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-2);
  }
  input {
    flex: 1 1 200px;
    max-width: 300px;
    min-height: var(--fl-control-height);
    padding: 0 var(--fl-space-3);
    color: var(--fl-text);
    font: inherit;
    font-size: var(--fl-font-callout);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  input::placeholder {
    color: var(--fl-muted);
  }
  input:disabled {
    opacity: 0.6;
  }
  input:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
</style>
