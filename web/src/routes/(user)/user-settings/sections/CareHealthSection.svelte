<script lang="ts">
  /**
   * Library care → Media health & integrity (FL-71, settings-catalog.mjs `health`): the template's
   * three toggles (FL-69: scheduled incremental health scans, checksum verification, the reference
   * audit), the server's integrity check settings they sit over, and the "Review missing media" and
   * "Review damaged media" actions into the utilities.
   */
  import { goto } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import LibraryCareToggles from '$lib/components/frameleaf/settings/LibraryCareToggles.svelte';
  import { Route } from '$lib/route';
  import { t } from 'svelte-i18n';
  import IntegrityChecksSettings from '../../../admin/system-settings/IntegrityChecksSettings.svelte';
</script>

<LibraryCareToggles section="integrity-checks" />
<IntegrityChecksSettings />
<div class="cc-section-action">
  <Button onclick={() => goto(Route.missingMediaUtility())}>{$t('library_care_review_missing')}</Button>
  <Button onclick={() => goto(Route.corruptMediaUtility())}>{$t('library_care_review_damaged')}</Button>
</div>

<style>
  .cc-section-action {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 16px;
  }
</style>
