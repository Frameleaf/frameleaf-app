<script lang="ts">
  /**
   * Editing & playback › Studio & Dolby Vision (FL-422, after the prototype's `studio` page and its
   * qualification checklist, settings-catalog.mjs:810-822 and CommandCenter.jsx `qualification`).
   *
   * Each row is a fact this server can answer. Studio exports come from what the connected computers
   * can take now (render-worker compatibility). HDR projects are automatic (FL-97). Dolby Vision
   * can't be made yet. Studio opens in browsers and in the tablet apps; the phone apps leave it out
   * in this version.
   *
   * The prototype's "Show Studio" switch is not built. Studio is on for everyone in v1 (FL-408), and
   * hiding it would need a server switch honoured by every Studio entry point and API.
   */
  import { goto } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Pill, { type KitTone } from '$lib/components/frameleaf/settings/kit/Pill.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import { canRunStudioWork } from '$lib/frameleaf/computers';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { getRenderWorkerCompatibility, type RenderWorkerCompatibilityResponseDto } from '@frameleaf/sdk';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  let compatibility = $state<RenderWorkerCompatibilityResponseDto | null>(null);
  let failed = $state(false);

  onMount(() => {
    getRenderWorkerCompatibility()
      .then((answer) => (compatibility = answer))
      .catch(() => (failed = true));
  });

  const exportState = $derived.by((): { tone: KitTone; text: string } => {
    const can = canRunStudioWork(compatibility, 'export');
    if (can === true) {
      return { tone: 'good', text: $t('frameleaf_editing_studio_ready') };
    }
    if (can === false) {
      return { tone: 'warn', text: $t('frameleaf_editing_studio_not_ready') };
    }
    return {
      tone: 'off',
      text: failed ? $t('frameleaf_editing_studio_unknown') : $t('frameleaf_editing_studio_checking'),
    };
  });
</script>

<KitPage>
  <Section title={$t('frameleaf_editing_studio_section')}>
    {#snippet action()}
      <Button onclick={() => goto(commandCenterUrl('processing', 'hardware'))}>
        {$t('frameleaf_editing_studio_hardware')}
      </Button>
    {/snippet}
    <Row label={$t('frameleaf_editing_studio_export')} help={$t('frameleaf_editing_studio_export_help')}>
      <Pill tone={exportState.tone}>{exportState.text}</Pill>
    </Row>
    <Row label={$t('frameleaf_editing_studio_hdr')} help={$t('frameleaf_editing_studio_hdr_help')}>
      <Pill tone="good">{$t('frameleaf_editing_studio_hdr_value')}</Pill>
    </Row>
    <Row label={$t('frameleaf_editing_studio_dolby')} help={$t('frameleaf_editing_studio_dolby_help')}>
      <Pill tone="off">{$t('frameleaf_editing_studio_dolby_value')}</Pill>
    </Row>
    <Row label={$t('frameleaf_editing_studio_where')} help={$t('frameleaf_editing_studio_where_help')}>
      <Pill tone="good">{$t('frameleaf_editing_studio_where_value')}</Pill>
    </Row>
  </Section>
</KitPage>
