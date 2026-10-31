<script lang="ts">
  /**
   * Editing & playback › Edited masters (FL-422, after the prototype's `masters` page,
   * settings-catalog.mjs:740-773): how an edited photo or video is saved.
   *
   * Only "How trims are cut" is a setting (`editing.trimMode`). It is where the video editor starts a
   * new trim, and how the server cuts a trim that names no mode. Size and audio are guarantees of the
   * edited-master policy, shown as the prototype's locked "Original-quality guarantee" rows. Colour
   * isn't a setting either: an HDR switch here would go against FL-97, where HDR is automatic. The
   * row says what the server does, which follows "HDR on regular screens" on Video playback copies:
   * while it is on, an edited HDR video is saved in standard range.
   */
  import SegmentedControl from '$lib/components/frameleaf/SegmentedControl.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Pill from '$lib/components/frameleaf/settings/kit/Pill.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { requireSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { ToneMapping, VideoTrimMode } from '@frameleaf/sdk';
  import { t } from 'svelte-i18n';

  const disabled = $derived(featureFlagsManager.value.configFile);
  const settingsDraft = requireSystemConfigDraft();
  // The server always returns `editing`; the DTO marks it optional only because it has a default.
  const editing = $derived(settingsDraft.draft.editing!);
  // What the saved settings do now: a draft change to playback is not saved yet.
  const toneMapped = $derived(settingsDraft.baseline.ffmpeg.tonemap !== ToneMapping.Disabled);

  const trimHelp = $derived(
    editing.trimMode === VideoTrimMode.Fast
      ? $t('frameleaf_editing_masters_trim_fast_help')
      : $t('frameleaf_editing_masters_trim_precise_help'),
  );
  const trimLead = $derived(
    editing.trimMode === VideoTrimMode.Fast
      ? $t('frameleaf_editing_masters_trim_fast')
      : $t('frameleaf_editing_masters_trim_precise'),
  );
</script>

<KitPage>
  <Section
    title={$t('frameleaf_editing_masters_quality')}
    description={$t('frameleaf_editing_masters_quality_description')}
  >
    <Row label={$t('frameleaf_editing_masters_resolution')} help={$t('frameleaf_editing_masters_resolution_help')}>
      <Pill tone="good">{$t('frameleaf_editing_masters_resolution_value')}</Pill>
    </Row>
    <Row
      label={$t('frameleaf_editing_masters_colour')}
      help={toneMapped
        ? $t('frameleaf_editing_masters_colour_sdr_help')
        : $t('frameleaf_editing_masters_colour_hdr_help')}
      link={{
        text: $t('frameleaf_editing_masters_colour_link'),
        href: commandCenterUrl('editing', 'video-transcoding'),
      }}
    >
      <Pill tone="good">
        {toneMapped ? $t('frameleaf_editing_masters_colour_sdr') : $t('frameleaf_editing_masters_colour_hdr')}
      </Pill>
    </Row>
    <Row label={$t('frameleaf_editing_masters_audio')} help={$t('frameleaf_editing_masters_audio_help')}>
      <Pill tone="good">{$t('frameleaf_editing_masters_audio_value')}</Pill>
    </Row>
  </Section>

  <Section
    title={$t('frameleaf_editing_masters_trims')}
    description={$t('frameleaf_editing_masters_trims_description')}
  >
    <Row label={$t('frameleaf_editing_masters_trim')} help={trimHelp} lead={trimLead}>
      <SegmentedControl
        label={$t('frameleaf_editing_masters_trim')}
        value={editing.trimMode}
        {disabled}
        options={[
          { value: VideoTrimMode.Precise, label: $t('frameleaf_editing_masters_trim_precise') },
          { value: VideoTrimMode.Fast, label: $t('frameleaf_editing_masters_trim_fast') },
        ]}
        onChange={(value) => (editing.trimMode = value as VideoTrimMode)}
      />
    </Row>
  </Section>
</KitPage>
