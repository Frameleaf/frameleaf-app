<script lang="ts">
  /**
   * FL-918: the two-way Library Assistant / Classic search switch from the approved mock
   * (`AssistantPanel.jsx` `.la-mode`). One tap flips it; the page remembers the choice for the person.
   */
  import { ASSISTANT_NAME } from '$lib/frameleaf/assistant';
  import { t } from 'svelte-i18n';

  let { classic, onChange }: { classic: boolean; onChange: (classic: boolean) => void } = $props();
</script>

<div class="frameleaf la-mode" role="radiogroup" aria-label={$t('frameleaf_assistant_mode')}>
  <button
    type="button"
    role="radio"
    aria-checked={!classic}
    class:is-on={!classic}
    onclick={() => classic && onChange(false)}
  >
    {ASSISTANT_NAME}
  </button>
  <button
    type="button"
    role="radio"
    aria-checked={classic}
    class:is-on={classic}
    onclick={() => !classic && onChange(true)}
  >
    {$t('frameleaf_assistant_classic')}
  </button>
</div>

<style>
  .la-mode {
    display: inline-flex;
    flex: none;
    gap: var(--fl-space-1);
    padding: var(--fl-space-1);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-pill);
  }
  .la-mode button {
    min-height: 40px;
    padding: 0 var(--fl-space-4);
    color: var(--fl-muted);
    font: inherit;
    background: transparent;
    border: 0;
    border-radius: var(--fl-radius-pill);
    cursor: pointer;
  }
  .la-mode button.is-on {
    color: var(--fl-text);
    font-weight: 600;
    background: var(--fl-raised);
  }
</style>
