<script lang="ts">
  /**
   * The "Change" disclosure every optional step keeps its alternatives in. A button and a region,
   * not a native `details`, so the body can open and close with the row-height transition
   * (first-run-setup.css); the closed body is inert, so nothing in it takes focus.
   */
  import { Icon } from '@frameleaf/ui';
  import { mdiChevronDown } from '@mdi/js';
  import type { Snippet } from 'svelte';
  import { t } from 'svelte-i18n';

  const { summary, children, open = false }: { summary: Snippet; children: Snippet; open?: boolean } = $props();

  const id = $props.id();
  // svelte-ignore state_referenced_locally
  let expanded = $state(open);
</script>

<div class="frs-change" data-open={expanded || undefined}>
  <button
    type="button"
    class="frs-change-summary fl-no-press"
    aria-expanded={expanded}
    aria-controls="{id}-body"
    onclick={() => (expanded = !expanded)}
  >
    <span>{@render summary()}</span>
    <span class="frs-change-link"
      >{$t('frameleaf_setup_change')}<Icon icon={mdiChevronDown} size="16" aria-hidden={true} /></span
    >
  </button>
  <div id="{id}-body" class="frs-change-region" inert={!expanded}>
    <div class="frs-change-body">{@render children()}</div>
  </div>
</div>
