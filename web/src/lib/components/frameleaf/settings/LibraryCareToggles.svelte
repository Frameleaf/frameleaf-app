<script lang="ts">
  /**
   * One Library care page's toggles (FL-69), as the template draws them (settings-catalog.mjs:905-977,
   * the compact switch rows of CommandCenter.jsx:1639-1655). They edit the shared settings draft, so
   * the settings bar saves them with everything else; without a draft (somebody who is not an
   * administrator) nothing is shown, since these are server settings.
   */
  import SettingToggle from '$lib/components/frameleaf/settings/SettingToggle.svelte';
  import {
    LIBRARY_CARE_SECTION_TOGGLES,
    LIBRARY_CARE_TOGGLES,
    type LibraryCareSection,
  } from '$lib/frameleaf/library-care-settings';
  import { getSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { t } from 'svelte-i18n';

  let { section }: { section: LibraryCareSection } = $props();

  const settingsDraft = getSystemConfigDraft();
  const configToEdit = $derived(settingsDraft?.draft);
  const baseline = $derived(settingsDraft?.baseline);
  const disabled = $derived(featureFlagsManager.value.configFile);
</script>

{#if configToEdit?.libraryCare}
  <div class="care-toggles">
    {#each LIBRARY_CARE_SECTION_TOGGLES[section] as key (key)}
      <SettingToggle
        title={$t(LIBRARY_CARE_TOGGLES[key].titleKey)}
        subtitle={$t(LIBRARY_CARE_TOGGLES[key].descriptionKey)}
        {disabled}
        bind:checked={configToEdit.libraryCare[key]}
        isEdited={configToEdit.libraryCare[key] !== baseline?.libraryCare?.[key]}
      />
    {/each}
  </div>
{/if}

<style>
  .care-toggles {
    display: grid;
    gap: 4px;
    margin-bottom: 16px;
  }
</style>
