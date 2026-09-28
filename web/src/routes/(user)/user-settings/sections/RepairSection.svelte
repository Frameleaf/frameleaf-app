<script lang="ts">
  /**
   * Library care → Repair queues (FL-71): the template's `repairs` panel (CommandCenter.jsx), one
   * entry per repair workflow, each opening its utility. Only the tools this account may use appear.
   * For an administrator the template's three suggestion toggles come first (FL-69).
   */
  import { goto } from '$app/navigation';
  import LibraryCareToggles from '$lib/components/frameleaf/settings/LibraryCareToggles.svelte';
  import { utilitiesUrl, utilityToolsFor, type UtilityId } from '$lib/frameleaf/utilities';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Icon } from '@immich/ui';
  import { mdiChevronRight } from '@mdi/js';
  import { t, type Translations } from 'svelte-i18n';

  const REPAIRS: { tool: UtilityId; titleKey: Translations; descriptionKey: Translations }[] = [
    { tool: 'live-photos', titleKey: 'frameleaf_cc_repair_live', descriptionKey: 'frameleaf_cc_repair_live_help' },
    {
      tool: 'missing-media',
      titleKey: 'frameleaf_cc_repair_missing',
      descriptionKey: 'frameleaf_cc_repair_missing_help',
    },
    {
      tool: 'duplicates',
      titleKey: 'frameleaf_cc_repair_duplicates',
      descriptionKey: 'frameleaf_cc_repair_duplicates_help',
    },
    {
      tool: 'corrupt-media',
      titleKey: 'frameleaf_cc_repair_damaged',
      descriptionKey: 'frameleaf_cc_repair_damaged_help',
    },
  ];

  const available = $derived(
    REPAIRS.filter((repair) => utilityToolsFor(authManager.user.isAdmin).some((tool) => tool.id === repair.tool)),
  );
</script>

<LibraryCareToggles section="repair" />
<div class="cc-repair-grid">
  {#each available as repair (repair.tool)}
    <button type="button" onclick={() => goto(utilitiesUrl(repair.tool))}>
      <strong>{$t(repair.titleKey)}</strong>
      <span>{$t(repair.descriptionKey)}</span>
      <Icon icon={mdiChevronRight} size="1.125rem" aria-hidden />
    </button>
  {/each}
</div>

<style>
  .cc-repair-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }
  .cc-repair-grid button {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 6px 12px;
    padding: 16px;
    text-align: start;
    color: var(--fl-text);
    background: var(--fl-canvas);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    font: inherit;
    cursor: pointer;
  }
  .cc-repair-grid button:hover {
    background: var(--fl-raised);
  }
  .cc-repair-grid span {
    grid-column: 1;
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
  }
  .cc-repair-grid :global(svg) {
    grid-column: 2;
    grid-row: 1 / span 2;
    align-self: center;
    color: var(--fl-muted);
  }
  @media (max-width: 700px) {
    .cc-repair-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
