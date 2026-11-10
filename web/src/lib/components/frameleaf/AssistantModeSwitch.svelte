<script module lang="ts">
  // The page swaps the switch to another spot when the mode changes; the new one takes the focus back.
  let focusOnMount = false;
</script>

<script lang="ts">
  /**
   * FL-918: the two-way Library Assistant / Classic search switch from the approved mock
   * (`AssistantPanel.jsx` `.la-mode`). One tap flips it; the page remembers the choice for the person.
   */
  import { ASSISTANT_NAME } from '$lib/frameleaf/assistant';
  import { t } from 'svelte-i18n';

  let { classic, onChange }: { classic: boolean; onChange: (classic: boolean) => void } = $props();
  let group: HTMLDivElement | undefined = $state();

  const choose = (next: boolean) => {
    if (next === classic) {
      return;
    }
    focusOnMount = !!group?.contains(document.activeElement);
    onChange(next);
  };

  // A radio group: arrow keys move the choice, and only the chosen option is a Tab stop.
  const onkeydown = (event: KeyboardEvent) => {
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault();
      choose(!classic);
    }
  };

  $effect(() => {
    void classic;
    if (focusOnMount && group) {
      focusOnMount = false;
      group.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    }
  });
</script>

<div
  class="frameleaf la-mode"
  role="radiogroup"
  aria-label={$t('frameleaf_assistant_mode')}
  bind:this={group}
  {onkeydown}
>
  <button
    type="button"
    role="radio"
    aria-checked={!classic}
    tabindex={classic ? -1 : 0}
    class:is-on={!classic}
    onclick={() => choose(false)}
  >
    {ASSISTANT_NAME}
  </button>
  <button
    type="button"
    role="radio"
    aria-checked={classic}
    tabindex={classic ? 0 : -1}
    class:is-on={classic}
    onclick={() => choose(true)}
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
