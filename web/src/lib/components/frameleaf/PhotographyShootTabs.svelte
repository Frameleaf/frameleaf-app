<script module lang="ts">
  /** A shoot's own sections, in working order: the tabs under the shoot strip. */
  export const shootTabs = ['photos', 'intake', 'workflow', 'orders', 'presentation'] as const;
  export type ShootTab = (typeof shootTabs)[number];
</script>

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { shootSectionKeys } from './PhotographyStatus.svelte';

  let { current, onSection }: { current: ShootTab | null; onSection: (tab: ShootTab) => void } = $props();
</script>

<nav class="phx-project-nav" aria-label={$t('frameleaf_photography_shoot_sections')}>
  {#each shootTabs as tab (tab)}<button
      type="button"
      aria-current={current === tab ? 'page' : undefined}
      onclick={() => onSection(tab)}>{$t(shootSectionKeys[tab])}</button
    >{/each}
</nav>
