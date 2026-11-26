<script lang="ts">
  /** The badge on a person from another household: only the household's name, never an address. */
  import { Icon } from '@frameleaf/ui';
  import { mdiHomeGroup } from '@mdi/js';
  import { t } from 'svelte-i18n';

  let { name }: { name: string } = $props();
</script>

<span class="tag" title={$t('frameleaf_households_tag_title', { values: { name } })}>
  <Icon icon={mdiHomeGroup} size="12" aria-hidden />
  {$t('frameleaf_households_household_name', { values: { name } })}
</span>

<style>
  .tag {
    display: inline-flex;
    align-items: center;
    gap: var(--fl-space-1);
    padding: 2px var(--fl-space-2);
    border-radius: var(--fl-radius-pill);
    background: var(--fl-raised);
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
    font-weight: 500;
    white-space: nowrap;
  }
</style>
