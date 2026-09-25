<script lang="ts">
  /**
   * Library care → Enrichment completeness (FL-71, settings-catalog.mjs `enrichment-care`): where
   * faces, descriptions and embeddings stand. The work itself is the enrichment workbench of Search
   * & intelligence and the Job manager (FL-59); this section opens them, under the template's two
   * rerun toggles (FL-69).
   */
  import { goto } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import LibraryCareToggles from '$lib/components/frameleaf/settings/LibraryCareToggles.svelte';
  import { OpenQueryParam } from '$lib/constants';
  import { Route } from '$lib/route';
  import { t } from 'svelte-i18n';
</script>

<LibraryCareToggles section="enrichment-care" />
<p class="help">{$t('frameleaf_cc_enrichment_help')}</p>
<div class="cc-section-action">
  <Button
    onclick={() => goto(Route.systemSettings({ isOpen: OpenQueryParam.IMAGE_DESCRIPTION, openSetting: 'workbench' }))}
    >{$t('frameleaf_cc_enrichment_workbench')}</Button
  >
  <Button onclick={() => goto(Route.queues())}>{$t('frameleaf_cc_enrichment_queues')}</Button>
</div>

<style>
  .help {
    margin: 0 0 16px;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.5;
  }
  .cc-section-action {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
</style>
