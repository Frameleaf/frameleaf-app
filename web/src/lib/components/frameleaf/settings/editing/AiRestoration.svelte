<script lang="ts">
  /**
   * Editing & playback › AI restoration (FL-422, after the prototype's `restoration` page,
   * settings-catalog.mjs:775-808): cleaning up and sharpening old videos.
   *
   * "Restoration style" (`editing.restoration.style`) is the style a video restoration starts on, in
   * the editor and in Studio's Restore tab; each restoration can still pick the other one. The rest
   * of the prototype's page is not a setting here:
   * - "Enlarge by" is chosen for each restoration, beside its preview.
   * - "Largest output size" is fixed at 4K by the server and the worker, so it is a promise.
   * - "Offer Smooth motion" is the Smooth motion row of Where work runs, whose "Nowhere" turns it off.
   */
  import { goto } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import SegmentedControl from '$lib/components/frameleaf/SegmentedControl.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Promises from '$lib/components/frameleaf/settings/kit/Promises.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { requireSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { RestorationStyle } from '@frameleaf/sdk';
  import { mdiArrowExpandAll, mdiContentSaveOutline, mdiPlayCircleOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  const disabled = $derived(featureFlagsManager.value.configFile);
  const settingsDraft = requireSystemConfigDraft();
  // The server always returns `editing`; the DTO marks it optional only because it has a default.
  const restoration = $derived(settingsDraft.draft.editing!.restoration);

  const creative = $derived(restoration.style === RestorationStyle.Creative);
</script>

<KitPage>
  <Section
    title={$t('frameleaf_editing_restore_section')}
    description={$t('frameleaf_editing_restore_section_description')}
  >
    <Row
      label={$t('frameleaf_editing_restore_style')}
      help={creative
        ? $t('frameleaf_editing_restore_style_creative_help')
        : $t('frameleaf_editing_restore_style_faithful_help')}
      lead={creative ? $t('frameleaf_restoration_mode_creative') : $t('frameleaf_restoration_mode_faithful')}
    >
      <SegmentedControl
        label={$t('frameleaf_editing_restore_style')}
        value={restoration.style}
        {disabled}
        options={[
          { value: RestorationStyle.Faithful, label: $t('frameleaf_restoration_mode_faithful') },
          { value: RestorationStyle.Creative, label: $t('frameleaf_restoration_mode_creative') },
        ]}
        onChange={(value) => (restoration.style = value as RestorationStyle)}
      />
    </Row>
    <Promises
      rows={[
        {
          icon: mdiPlayCircleOutline,
          text: $t('frameleaf_editing_restore_preview'),
          detail: $t('frameleaf_editing_restore_preview_detail'),
        },
        {
          icon: mdiContentSaveOutline,
          text: $t('frameleaf_editing_restore_original'),
          detail: $t('frameleaf_editing_restore_original_detail'),
        },
        {
          icon: mdiArrowExpandAll,
          text: $t('frameleaf_editing_restore_cap'),
          detail: $t('frameleaf_editing_restore_cap_detail'),
        },
      ]}
    />
  </Section>

  <Section title={$t('frameleaf_editing_restore_runs')} description={$t('frameleaf_editing_restore_runs_help')}>
    {#snippet action()}
      <Button onclick={() => goto(commandCenterUrl('processing', 'routing'))}>
        {$t('frameleaf_editing_restore_runs_button')}
      </Button>
    {/snippet}
  </Section>
</KitPage>
