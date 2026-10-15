<script lang="ts">
  /**
   * Editing & playback › Video playback copies (FL-366, after the approved prototype
   * `settings-v2/care/playback.jsx`, `VideoCopies`): opens on what happens to videos today, then two
   * choices, "Which videos get a copy" and "Playback quality", that write the `ffmpeg.*` numbers the
   * server keeps (`$lib/frameleaf/playback-presets`). HDR, adapting to the connection and the graphics
   * card are one switch each; "Remake copies" starts the video conversion job for every video
   * (`force`), as the Job manager does. Every `ffmpeg.*` field stays in four closed Advanced groups,
   * each with its trade name said beside it.
   *
   * What the graphics card is comes from the server's own check (`getHardwareCheck`), which the
   * Graphics card check page shows in full.
   *
   * Left for later (server work): how many videos have a copy and the space they take, MB a minute
   * per choice, remaking copies tonight from the save, "Test it" and the "graphics card stopped
   * helping" state.
   */
  import { goto } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import SegmentedControl from '$lib/components/frameleaf/SegmentedControl.svelte';
  import Checks from '$lib/components/frameleaf/settings/editing/Checks.svelte';
  import Advanced from '$lib/components/frameleaf/settings/kit/Advanced.svelte';
  import Amount from '$lib/components/frameleaf/settings/kit/Amount.svelte';
  import Field from '$lib/components/frameleaf/settings/kit/Field.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Said from '$lib/components/frameleaf/settings/kit/Said.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Select from '$lib/components/frameleaf/settings/kit/Select.svelte';
  import Switch from '$lib/components/frameleaf/settings/kit/Switch.svelte';
  import SettingActions from '$lib/components/frameleaf/settings/SettingActions.svelte';
  import {
    applyPlaybackQuality,
    COPY_RULES,
    copyRuleOf,
    PLAYBACK_QUALITIES,
    playbackQualityOf,
    policyOf,
    type CopyRule,
    type PlaybackQuality,
  } from '$lib/frameleaf/playback-presets';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { requireSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import {
    AudioCodec,
    CQMode,
    getHardwareCheck,
    getQueue,
    HardwareBackend,
    HlsVideoResolution,
    QueueCommand,
    QueueName,
    runQueueCommandLegacy,
    ToneMapping,
    TranscodeHWAccel,
    TranscodePolicy,
    VideoCodec,
    VideoContainer,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiChevronRight,
    mdiPlayBoxMultipleOutline,
    mdiShieldCheckOutline,
    mdiSync,
    mdiVideoOffOutline,
  } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';

  const disabled = $derived(featureFlagsManager.value.configFile);
  const settingsDraft = requireSystemConfigDraft();
  const configToEdit = $derived(settingsDraft.draft);
  const config = $derived(settingsDraft.baseline);

  const rule = $derived(copyRuleOf(configToEdit.ffmpeg.transcode));
  const quality = $derived(playbackQualityOf(configToEdit.ffmpeg));
  const RULE_NAME: Record<CopyRule, Translations> = {
    needed: 'frameleaf_play_vid_needed',
    all: 'frameleaf_play_vid_all',
  };
  const QUALITY_NAME: Record<PlaybackQuality, Translations> = {
    good: 'frameleaf_play_vid_good',
    better: 'frameleaf_play_vid_better',
    best: 'frameleaf_play_vid_best',
  };
  const POLICY_NAME: Record<TranscodePolicy, Translations> = {
    [TranscodePolicy.Required]: 'frameleaf_play_rule_required',
    [TranscodePolicy.All]: 'frameleaf_play_rule_all',
    [TranscodePolicy.Optimal]: 'frameleaf_play_rule_optimal',
    [TranscodePolicy.Bitrate]: 'frameleaf_play_rule_bitrate',
    [TranscodePolicy.Disabled]: 'frameleaf_play_rule_disabled',
  };

  const SIZES = [
    { value: '480', label: '480p' },
    { value: '720', label: '720p' },
    { value: '1080', label: '1080p' },
    { value: '1440', label: '1440p' },
    { value: '2160', label: '4K' },
  ];
  const sizeName = (size: string) =>
    SIZES.find((option) => option.value === size)?.label ?? $t('frameleaf_play_target_original');

  /** The choices that decide which videos already have a copy that is now out of date. */
  const copyFields = (ffmpeg: typeof config.ffmpeg) =>
    JSON.stringify([ffmpeg.transcode, ffmpeg.targetResolution, ffmpeg.crf, ffmpeg.preset]);
  const changed = $derived(copyFields(configToEdit.ffmpeg) !== copyFields(config.ffmpeg));
  const undo = () => {
    configToEdit.ffmpeg.transcode = config.ffmpeg.transcode;
    configToEdit.ffmpeg.targetResolution = config.ffmpeg.targetResolution;
    configToEdit.ffmpeg.crf = config.ffmpeg.crf;
    configToEdit.ffmpeg.preset = config.ffmpeg.preset;
  };

  // HDR on regular screens is tone mapping; turning it back on keeps the saved method.
  const hdr = $derived(configToEdit.ffmpeg.tonemap !== ToneMapping.Disabled);
  const setHdr = (on: boolean) => {
    configToEdit.ffmpeg.tonemap = on
      ? config.ffmpeg.tonemap === ToneMapping.Disabled
        ? ToneMapping.Hable
        : config.ffmpeg.tonemap
      : ToneMapping.Disabled;
  };

  /** What the server's own check found for video, as the kind of card the converter uses. */
  const BACKEND_ACCEL: Partial<Record<HardwareBackend, TranscodeHWAccel>> = {
    [HardwareBackend.Nvenc]: TranscodeHWAccel.Nvenc,
    [HardwareBackend.Qsv]: TranscodeHWAccel.Qsv,
    [HardwareBackend.VaApi]: TranscodeHWAccel.Vaapi,
  };
  const KIND_NAME: Record<TranscodeHWAccel, Translations> = {
    [TranscodeHWAccel.Nvenc]: 'frameleaf_play_card_nvenc',
    [TranscodeHWAccel.Qsv]: 'frameleaf_play_card_qsv',
    [TranscodeHWAccel.Vaapi]: 'frameleaf_play_card_vaapi',
    [TranscodeHWAccel.Rkmpp]: 'frameleaf_play_card_rkmpp',
    [TranscodeHWAccel.Disabled]: 'frameleaf_play_off',
  };
  let found = $state<{ accel?: TranscodeHWAccel; name: string } | null>(null);
  const card = $derived(configToEdit.ffmpeg.accel !== TranscodeHWAccel.Disabled);
  /** The kind turning the switch on uses: the one saved before, else the one the check found. */
  const cardKind = $derived(config.ffmpeg.accel === TranscodeHWAccel.Disabled ? found?.accel : config.ffmpeg.accel);
  const cardHelp = $derived.by(() => {
    if (card) {
      return $t('frameleaf_play_vid_card_set', { values: { name: $t(KIND_NAME[configToEdit.ffmpeg.accel]) } });
    }
    if (found?.accel) {
      return $t('frameleaf_play_vid_card_found', { values: { name: found.name } });
    }
    return $t('frameleaf_play_vid_card_none');
  });

  let waiting = $state(0);
  let said = $state('');
  let remaking = $state(false);

  onMount(() => {
    void getQueue({ name: QueueName.VideoConversion })
      .then((queue) => (waiting = (queue?.statistics.active ?? 0) + (queue?.statistics.waiting ?? 0)))
      .catch(() => {
        // The status then says what happens to videos, without a count.
      });
    void getHardwareCheck()
      .then((check) => {
        const server = check?.server;
        const accel = server ? BACKEND_ACCEL[server.backend] : undefined;
        found = accel ? { accel, name: server?.model ?? server?.vendor ?? $t(KIND_NAME[accel]) } : null;
      })
      .catch(() => {
        // The Graphics card check page says why the server could not be checked.
      });
  });

  const hero = $derived.by(() => {
    if (configToEdit.ffmpeg.transcode === TranscodePolicy.Disabled) {
      return {
        tone: 'quiet' as const,
        icon: mdiVideoOffOutline,
        title: $t('frameleaf_play_vid_off'),
        body: $t('frameleaf_play_vid_off_body'),
      };
    }
    if (waiting > 0) {
      return {
        tone: 'good' as const,
        icon: mdiSync,
        title: $t('frameleaf_play_vid_working'),
        body: $t('frameleaf_play_vid_working_body', { values: { count: waiting } }),
      };
    }
    const size = sizeName(config.ffmpeg.targetResolution);
    const savedRule = copyRuleOf(config.ffmpeg.transcode);
    return {
      tone: 'good' as const,
      icon: mdiPlayBoxMultipleOutline,
      title: $t('frameleaf_play_vid_ok'),
      body:
        savedRule === 'all'
          ? $t('frameleaf_play_vid_ok_all', { values: { size } })
          : savedRule === 'needed'
            ? $t('frameleaf_play_vid_ok_needed', { values: { size } })
            : $t('frameleaf_play_vid_ok_custom'),
    };
  });

  const remake = async () => {
    remaking = true;
    try {
      await runQueueCommandLegacy({
        name: QueueName.VideoConversion,
        queueCommandDto: { command: QueueCommand.Start, force: true },
      });
      said = $t('frameleaf_play_vid_remake_started');
    } catch (error) {
      handleError(error, $t('frameleaf_play_vid_remake_failed'));
    } finally {
      remaking = false;
    }
  };

  const SPEEDS = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'];
</script>

<KitPage>
  <Said message={said} onDismiss={() => (said = '')} />

  <Hero tone={hero.tone} icon={hero.icon} title={hero.title} body={hero.body} label={$t('frameleaf_play_vid_label')} />

  <Section title={$t('frameleaf_play_vid_section')}>
    <Row
      label={$t('frameleaf_play_vid_which')}
      help={rule ? $t(`frameleaf_play_vid_${rule}_help` as Translations) : $t('frameleaf_play_vid_rule_custom_help')}
    >
      <SegmentedControl
        label={$t('frameleaf_play_vid_which')}
        options={[
          ...COPY_RULES.map((value) => ({ value, label: $t(RULE_NAME[value]) })),
          ...(rule ? [] : [{ value: 'custom', label: $t(POLICY_NAME[configToEdit.ffmpeg.transcode]) }]),
        ]}
        value={rule ?? 'custom'}
        {disabled}
        onChange={(value) => {
          if (value !== 'custom') {
            configToEdit.ffmpeg.transcode = policyOf(value as CopyRule);
          }
        }}
      />
    </Row>
    <Row
      label={$t('frameleaf_play_vid_quality')}
      help={quality
        ? $t(`frameleaf_play_vid_${quality}_help` as Translations)
        : $t('frameleaf_play_vid_quality_custom_help')}
    >
      <SegmentedControl
        label={$t('frameleaf_play_vid_quality')}
        options={[
          ...PLAYBACK_QUALITIES.map((value) => ({ value, label: $t(QUALITY_NAME[value]) })),
          ...(quality ? [] : [{ value: 'custom', label: $t('frameleaf_play_custom') }]),
        ]}
        value={quality ?? 'custom'}
        {disabled}
        onChange={(value) => {
          if (value !== 'custom') {
            applyPlaybackQuality(configToEdit.ffmpeg, value as PlaybackQuality);
          }
        }}
      />
    </Row>
    {#if changed}
      <Notice title={$t('frameleaf_play_vid_changed')} tone="warn">
        {$t('frameleaf_play_vid_changed_body')}
        {#snippet action()}
          <Button onclick={undo}>{$t('frameleaf_play_undo')}</Button>
        {/snippet}
      </Notice>
    {/if}
    <Row label={$t('frameleaf_play_vid_remake_row')} help={$t('frameleaf_play_vid_remake_help')}>
      <Button disabled={remaking || configToEdit.ffmpeg.transcode === TranscodePolicy.Disabled} onclick={remake}>
        {$t('frameleaf_play_vid_remake')}
      </Button>
    </Row>
    <Row label={$t('frameleaf_play_vid_hdr')} help={$t('frameleaf_play_vid_hdr_help')}>
      <Switch label={$t('frameleaf_play_vid_hdr')} checked={hdr} held={disabled} onChange={setHdr} />
    </Row>
    <Row label={$t('frameleaf_play_vid_adaptive')} help={$t('frameleaf_play_vid_adaptive_help')}>
      <Switch
        label={$t('frameleaf_play_vid_adaptive')}
        checked={configToEdit.ffmpeg.realtime.enabled}
        held={disabled}
        onChange={(value) => (configToEdit.ffmpeg.realtime.enabled = value)}
      />
    </Row>
    <Notice icon={mdiShieldCheckOutline} title={$t('frameleaf_play_vid_pledge')}>
      {$t('frameleaf_play_vid_pledge_body')}
    </Notice>
  </Section>

  <Section title={$t('frameleaf_play_vid_speed')}>
    <Row label={$t('frameleaf_play_vid_card')} help={cardHelp}>
      <Switch
        label={$t('frameleaf_play_vid_card')}
        checked={card}
        held={disabled || (!card && !cardKind)}
        onChange={(value) => {
          if (!value) {
            configToEdit.ffmpeg.accel = TranscodeHWAccel.Disabled;
          } else if (cardKind) {
            configToEdit.ffmpeg.accel = cardKind;
          }
        }}
      />
    </Row>
    <Row label={$t('frameleaf_play_vid_card_where')} help={$t('frameleaf_play_vid_card_where_help')}>
      <Button onclick={() => goto(commandCenterUrl('processing', 'hardware'))}>
        {$t('frameleaf_play_vid_card_check')}
        <Icon icon={mdiChevronRight} size="1em" aria-hidden={true} />
      </Button>
    </Row>

    <Advanced summary={$t('frameleaf_play_adv_rule')}>
      <p class="hint">{$t('frameleaf_play_adv_rule_hint')}</p>
      <Row label={$t('frameleaf_play_rule')} help={$t('frameleaf_play_rule_help')}>
        <Select
          label={$t('frameleaf_play_rule')}
          value={configToEdit.ffmpeg.transcode}
          options={Object.values(TranscodePolicy).map((value) => ({ value, label: $t(POLICY_NAME[value]) }))}
          {disabled}
          onChange={(value) => (configToEdit.ffmpeg.transcode = value as TranscodePolicy)}
        />
      </Row>
      <Row label={$t('frameleaf_play_accept_video')} help={$t('frameleaf_play_accept_video_help')}>
        <Checks
          label={$t('frameleaf_play_accept_video')}
          value={configToEdit.ffmpeg.acceptedVideoCodecs}
          locked={[configToEdit.ffmpeg.targetVideoCodec]}
          options={[
            { value: VideoCodec.H264, label: 'H.264' },
            { value: VideoCodec.Hevc, label: 'HEVC' },
            { value: VideoCodec.Vp9, label: 'VP9' },
            { value: VideoCodec.Av1, label: 'AV1' },
          ]}
          {disabled}
          onChange={(value) => (configToEdit.ffmpeg.acceptedVideoCodecs = value)}
        />
      </Row>
      <Row label={$t('frameleaf_play_accept_audio')} help={$t('frameleaf_play_accept_audio_help')}>
        <Checks
          label={$t('frameleaf_play_accept_audio')}
          value={configToEdit.ffmpeg.acceptedAudioCodecs}
          locked={[configToEdit.ffmpeg.targetAudioCodec]}
          options={[
            { value: AudioCodec.Aac, label: 'AAC' },
            { value: AudioCodec.Mp3, label: 'MP3' },
            { value: AudioCodec.Opus, label: 'Opus' },
            { value: AudioCodec.PcmS16Le, label: 'PCM 16-bit' },
          ]}
          {disabled}
          onChange={(value) => (configToEdit.ffmpeg.acceptedAudioCodecs = value)}
        />
      </Row>
      <Row label={$t('frameleaf_play_accept_files')} help={$t('frameleaf_play_accept_files_help')}>
        <Checks
          label={$t('frameleaf_play_accept_files')}
          value={configToEdit.ffmpeg.acceptedContainers}
          options={[
            { value: VideoContainer.Mov, label: 'MOV' },
            { value: VideoContainer.Ogg, label: 'Ogg' },
            { value: VideoContainer.Webm, label: 'WebM' },
          ]}
          {disabled}
          onChange={(value) => (configToEdit.ffmpeg.acceptedContainers = value)}
        />
      </Row>
      <Row label={$t('frameleaf_play_max_rate')} help={$t('frameleaf_play_max_rate_help')}>
        <Field
          label={$t('frameleaf_play_max_rate')}
          value={configToEdit.ffmpeg.maxBitrate}
          {disabled}
          onChange={(value) => (configToEdit.ffmpeg.maxBitrate = value)}
        />
      </Row>
    </Advanced>

    <Advanced summary={$t('frameleaf_play_adv_made')}>
      <p class="hint">{$t('frameleaf_play_adv_made_hint')}</p>
      <Row label={$t('frameleaf_play_target_size')}>
        <Select
          label={$t('frameleaf_play_target_size')}
          value={configToEdit.ffmpeg.targetResolution}
          options={[
            ...SIZES,
            ...(SIZES.some((option) => option.value === configToEdit.ffmpeg.targetResolution) ||
            configToEdit.ffmpeg.targetResolution === 'original'
              ? []
              : [{ value: configToEdit.ffmpeg.targetResolution, label: configToEdit.ffmpeg.targetResolution }]),
            { value: 'original', label: $t('frameleaf_play_target_original') },
          ]}
          {disabled}
          onChange={(value) => (configToEdit.ffmpeg.targetResolution = value)}
        />
      </Row>
      <Row label={$t('frameleaf_play_video_format')} help={$t('frameleaf_play_video_format_help')}>
        <Select
          label={$t('frameleaf_play_video_format')}
          value={configToEdit.ffmpeg.targetVideoCodec}
          options={[
            { value: VideoCodec.H264, label: 'H.264' },
            { value: VideoCodec.Hevc, label: 'HEVC' },
            { value: VideoCodec.Vp9, label: 'VP9' },
            { value: VideoCodec.Av1, label: 'AV1' },
          ]}
          {disabled}
          onChange={(value) => {
            // As before: only the new format is played as it is, so older copies are not kept.
            configToEdit.ffmpeg.targetVideoCodec = value as VideoCodec;
            configToEdit.ffmpeg.acceptedVideoCodecs = [value as VideoCodec];
          }}
        />
      </Row>
      <Row label={$t('frameleaf_play_crf')} help={$t('frameleaf_play_crf_help')}>
        <Amount
          label={$t('frameleaf_play_crf')}
          unit={$t('frameleaf_play_crf_unit')}
          min={0}
          max={51}
          value={configToEdit.ffmpeg.crf}
          {disabled}
          onChange={(value) => (configToEdit.ffmpeg.crf = value)}
        />
      </Row>
      <Row label={$t('frameleaf_play_speed')} help={$t('frameleaf_play_speed_help')}>
        <Select
          label={$t('frameleaf_play_speed')}
          value={configToEdit.ffmpeg.preset}
          options={[
            ...SPEEDS.map((speed) => ({ value: speed, label: speed })),
            ...(SPEEDS.includes(configToEdit.ffmpeg.preset)
              ? []
              : [{ value: configToEdit.ffmpeg.preset, label: configToEdit.ffmpeg.preset }]),
          ]}
          {disabled}
          onChange={(value) => (configToEdit.ffmpeg.preset = value)}
        />
      </Row>
      <Row label={$t('frameleaf_play_sound')} help={$t('frameleaf_play_sound_help')}>
        <!-- PCM is left out here: it is a poor choice for space. -->
        <Select
          label={$t('frameleaf_play_sound')}
          value={configToEdit.ffmpeg.targetAudioCodec}
          options={[
            { value: AudioCodec.Aac, label: 'AAC' },
            { value: AudioCodec.Mp3, label: 'MP3' },
            { value: AudioCodec.Opus, label: 'Opus' },
          ]}
          {disabled}
          onChange={(value) => {
            const codec = value as AudioCodec;
            configToEdit.ffmpeg.targetAudioCodec = codec;
            if (!configToEdit.ffmpeg.acceptedAudioCodecs.includes(codec)) {
              configToEdit.ffmpeg.acceptedAudioCodecs = [...configToEdit.ffmpeg.acceptedAudioCodecs, codec];
            }
          }}
        />
      </Row>
      <Row label={$t('frameleaf_play_threads')} help={$t('frameleaf_play_threads_help')}>
        <Amount
          label={$t('frameleaf_play_threads')}
          unit={$t('frameleaf_play_threads_unit')}
          min={0}
          max={256}
          value={configToEdit.ffmpeg.threads}
          {disabled}
          onChange={(value) => (configToEdit.ffmpeg.threads = value)}
        />
      </Row>
      <Row label={$t('frameleaf_play_tonemap')} help={$t('frameleaf_play_tonemap_help')}>
        <Select
          label={$t('frameleaf_play_tonemap')}
          value={configToEdit.ffmpeg.tonemap}
          options={[
            { value: ToneMapping.Hable, label: 'Hable' },
            { value: ToneMapping.Mobius, label: 'Mobius' },
            { value: ToneMapping.Reinhard, label: 'Reinhard' },
            { value: ToneMapping.Disabled, label: $t('frameleaf_play_off') },
          ]}
          {disabled}
          onChange={(value) => (configToEdit.ffmpeg.tonemap = value as ToneMapping)}
        />
      </Row>
      <Row label={$t('frameleaf_play_two_pass')} help={$t('frameleaf_play_two_pass_help')}>
        <Switch
          label={$t('frameleaf_play_two_pass')}
          checked={configToEdit.ffmpeg.twoPass}
          held={disabled}
          onChange={(value) => (configToEdit.ffmpeg.twoPass = value)}
        />
      </Row>
      <Row label={$t('frameleaf_play_gop')} help={$t('frameleaf_play_gop_help')}>
        <Amount
          label={$t('frameleaf_play_gop')}
          unit={$t('frameleaf_play_frames_unit')}
          min={0}
          max={100_000}
          value={configToEdit.ffmpeg.gopSize}
          {disabled}
          onChange={(value) => (configToEdit.ffmpeg.gopSize = value)}
        />
      </Row>
    </Advanced>

    <Advanced summary={$t('frameleaf_play_adv_card')}>
      <p class="hint">{$t('frameleaf_play_adv_card_hint')}</p>
      <Row label={$t('frameleaf_play_card_kind')} help={$t('frameleaf_play_card_kind_help')}>
        <Select
          label={$t('frameleaf_play_card_kind')}
          value={configToEdit.ffmpeg.accel}
          options={Object.values(TranscodeHWAccel).map((value) => ({ value, label: $t(KIND_NAME[value]) }))}
          {disabled}
          onChange={(value) => (configToEdit.ffmpeg.accel = value as TranscodeHWAccel)}
        />
      </Row>
      <Row label={$t('frameleaf_play_card_decode')} help={$t('frameleaf_play_card_decode_help')}>
        <Switch
          label={$t('frameleaf_play_card_decode')}
          checked={configToEdit.ffmpeg.accelDecode}
          held={disabled}
          onChange={(value) => (configToEdit.ffmpeg.accelDecode = value)}
        />
      </Row>
      <Row label={$t('frameleaf_play_card_device')} help={$t('frameleaf_play_card_device_help')}>
        <Field
          label={$t('frameleaf_play_card_device')}
          value={configToEdit.ffmpeg.preferredHwDevice}
          {disabled}
          onChange={(value) => (configToEdit.ffmpeg.preferredHwDevice = value)}
        />
      </Row>
      <Row label={$t('frameleaf_play_bframes')} help={$t('frameleaf_play_bframes_help')}>
        <Amount
          label={$t('frameleaf_play_bframes')}
          unit={$t('frameleaf_play_frames_unit')}
          min={-1}
          max={16}
          value={configToEdit.ffmpeg.bframes}
          {disabled}
          onChange={(value) => (configToEdit.ffmpeg.bframes = value)}
        />
      </Row>
      <Row label={$t('frameleaf_play_refs')} help={$t('frameleaf_play_refs_help')}>
        <Amount
          label={$t('frameleaf_play_refs')}
          unit={$t('frameleaf_play_frames_unit')}
          min={0}
          max={6}
          value={configToEdit.ffmpeg.refs}
          {disabled}
          onChange={(value) => (configToEdit.ffmpeg.refs = value)}
        />
      </Row>
      <Row label={$t('frameleaf_play_cq_mode')} help={$t('frameleaf_play_cq_mode_help')}>
        <Select
          label={$t('frameleaf_play_cq_mode')}
          value={configToEdit.ffmpeg.cqMode}
          options={[
            { value: CQMode.Auto, label: $t('frameleaf_play_cq_auto') },
            { value: CQMode.Cqp, label: 'CQP' },
            { value: CQMode.Icq, label: 'ICQ' },
          ]}
          {disabled}
          onChange={(value) => (configToEdit.ffmpeg.cqMode = value as CQMode)}
        />
      </Row>
      <Row label={$t('frameleaf_play_temporal')} help={$t('frameleaf_play_temporal_help')}>
        <Switch
          label={$t('frameleaf_play_temporal')}
          checked={configToEdit.ffmpeg.temporalAQ}
          held={disabled}
          onChange={(value) => (configToEdit.ffmpeg.temporalAQ = value)}
        />
      </Row>
    </Advanced>

    <Advanced summary={$t('frameleaf_play_adv_hls')}>
      <p class="hint">{$t('frameleaf_play_adv_hls_hint')}</p>
      <Row label={$t('frameleaf_play_stream_formats')}>
        <Checks
          label={$t('frameleaf_play_stream_formats')}
          value={configToEdit.ffmpeg.realtime.videoCodecs}
          options={[
            { value: VideoCodec.H264, label: 'H.264' },
            { value: VideoCodec.Hevc, label: 'HEVC' },
            { value: VideoCodec.Av1, label: 'AV1' },
          ]}
          disabled={disabled || !configToEdit.ffmpeg.realtime.enabled}
          onChange={(value) => (configToEdit.ffmpeg.realtime.videoCodecs = value)}
        />
      </Row>
      <Row label={$t('frameleaf_play_stream_steps')} help={$t('frameleaf_play_stream_steps_help')}>
        <Checks
          label={$t('frameleaf_play_stream_steps')}
          value={configToEdit.ffmpeg.realtime.resolutions}
          options={[
            { value: HlsVideoResolution.$480, label: '480p' },
            { value: HlsVideoResolution.$720, label: '720p' },
            { value: HlsVideoResolution.$1080, label: '1080p' },
            { value: HlsVideoResolution.$1440, label: '1440p' },
            { value: HlsVideoResolution.$2160, label: '4K' },
          ]}
          disabled={disabled || !configToEdit.ffmpeg.realtime.enabled}
          onChange={(value) => (configToEdit.ffmpeg.realtime.resolutions = value)}
        />
      </Row>
    </Advanced>
  </Section>

  <SettingActions keys={['ffmpeg']} {disabled} />
</KitPage>

<style>
  .hint {
    max-width: 560px;
    margin: 0 0 var(--fl-space-3);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.5;
  }
</style>
