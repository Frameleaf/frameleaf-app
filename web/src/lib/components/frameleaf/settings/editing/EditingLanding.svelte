<script lang="ts">
  /**
   * Editing & playback (FL-366, after the approved prototype `settings-v2/care/playback.jsx`,
   * `EditingLanding`): opens on whether photos and videos are ready to view, with the two choices
   * that decide how (preview quality and which videos get a playback copy), then one row for each
   * page. The app has no editing pages in this area (edited masters, restoration, Studio), so only
   * the two viewing rows are shown.
   *
   * "Ready" is read from the preview and video conversion work still waiting. Left for later (server
   * work): the space the copies take beside the originals, how many videos have a copy, and the
   * "graphics card stopped helping" state.
   */
  import Coverage, { type CoverageRow } from '$lib/components/frameleaf/settings/kit/Coverage.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Links, { type LinkRow } from '$lib/components/frameleaf/settings/kit/Links.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import { copyRuleOf, playbackQualityOf, previewQualityOf } from '$lib/frameleaf/playback-presets';
  import { commandCenterUrl, type SettingsHostSection } from '$lib/frameleaf/settings-areas';
  import { getSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { getQueue, QueueName, TranscodePolicy } from '@frameleaf/sdk';
  import { mdiImageMultipleOutline, mdiPlayBoxMultipleOutline, mdiSync } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';

  let { sections }: { sections: SettingsHostSection[] } = $props();

  const saved = $derived(getSystemConfigDraft()?.baseline);

  let waiting = $state(0);
  onMount(() => {
    for (const name of [QueueName.ThumbnailGeneration, QueueName.VideoConversion]) {
      void getQueue({ name })
        .then((queue) => (waiting += (queue?.statistics.active ?? 0) + (queue?.statistics.waiting ?? 0)))
        .catch(() => {
          // The answer then says what the copies are for, without a count.
        });
    }
  });

  const PAGES: Record<string, { icon: string; title: Translations; body: Translations }> = {
    image: {
      icon: mdiImageMultipleOutline,
      title: 'frameleaf_play_previews_title',
      body: 'frameleaf_play_previews_row',
    },
    'video-transcoding': {
      icon: mdiPlayBoxMultipleOutline,
      title: 'frameleaf_play_videos_title',
      body: 'frameleaf_play_videos_row',
    },
  };

  const previewFact = $derived.by(() => {
    if (!saved) {
      return;
    }
    const quality = previewQualityOf(saved.image);
    return quality ? $t(`frameleaf_play_img_${quality}` as Translations) : $t('frameleaf_play_custom');
  });

  const videoFact = $derived.by(() => {
    if (!saved) {
      return;
    }
    if (saved.ffmpeg.transcode === TranscodePolicy.Disabled) {
      return $t('frameleaf_play_rule_disabled');
    }
    const quality = playbackQualityOf(saved.ffmpeg);
    const rule = copyRuleOf(saved.ffmpeg.transcode);
    const qualityName = quality ? $t(`frameleaf_play_vid_${quality}` as Translations) : $t('frameleaf_play_custom');
    return rule === 'all' ? `${$t('frameleaf_play_vid_all')} · ${qualityName}` : qualityName;
  });

  const facts = $derived<CoverageRow[]>(
    previewFact && videoFact
      ? [
          {
            icon: mdiImageMultipleOutline,
            name: $t('frameleaf_play_previews_title'),
            detail: $t('frameleaf_play_fact_previews_detail'),
            tone: 'good',
            value: previewFact,
          },
          {
            icon: mdiPlayBoxMultipleOutline,
            name: $t('frameleaf_play_videos_title'),
            detail: $t('frameleaf_play_fact_videos_detail'),
            tone: saved?.ffmpeg.transcode === TranscodePolicy.Disabled ? 'off' : 'good',
            value: videoFact,
          },
        ]
      : [],
  );

  const rows = $derived(
    sections.map((section): LinkRow => {
      const page = PAGES[section.key];
      return {
        icon: page?.icon ?? section.icon,
        title: page ? $t(page.title) : section.title,
        body: page ? $t(page.body) : section.subtitle,
        href: commandCenterUrl('editing', section.key),
      };
    }),
  );
</script>

<KitPage>
  <Hero
    icon={waiting > 0 ? mdiSync : mdiPlayBoxMultipleOutline}
    title={waiting > 0 ? $t('frameleaf_play_landing_working') : $t('frameleaf_play_landing_ready')}
    body={waiting > 0
      ? $t('frameleaf_play_landing_working_body', { values: { count: waiting } })
      : $t('frameleaf_play_landing_ready_body')}
    label={$t('frameleaf_play_landing_label')}
  >
    {#if facts.length > 0}
      <Coverage rows={facts} />
    {/if}
  </Hero>

  <Section title={$t('frameleaf_play_landing_viewing')}>
    <!-- Side by side, as the prototype's Viewing group (settings-v2/care/playback.jsx). -->
    <Links {rows} />
  </Section>
</KitPage>
