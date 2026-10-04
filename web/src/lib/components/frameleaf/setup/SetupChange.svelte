<script lang="ts">
  /** The "Change" disclosure every optional step keeps its alternatives in. */
  import { Icon } from '@immich/ui';
  import { mdiChevronDown } from '@mdi/js';
  import type { Snippet } from 'svelte';
  import { t } from 'svelte-i18n';

  const { summary, children, open = false }: { summary: Snippet; children: Snippet; open?: boolean } = $props();
</script>

<details class="frs-change" {open}>
  <summary>
    <span>{@render summary()}</span>
    <span class="frs-change-link"
      >{$t('frameleaf_setup_change')}<Icon icon={mdiChevronDown} size="16" aria-hidden={true} /></span
    >
  </summary>
  <div class="frs-change-body">{@render children()}</div>
</details>
