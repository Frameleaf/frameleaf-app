<script lang="ts">
  /**
   * Editing & playback › Image previews (FL-366, after the approved prototype
   * `settings-v2/care/playback.jsx`, `ImagePreviews`): opens on whether previews are being made, then
   * one choice, "Preview quality", that writes the thumbnail and preview numbers the server keeps
   * (`$lib/frameleaf/playback-presets`), the full-size switch, and a "Rebuild previews" button that
   * starts the thumbnail job for every photo (`force`), as the Job manager does. Every `image.*` field
   * stays in four closed Advanced groups.
   *
   * FL-521: the space previews take (as last measured) and about what each choice would take, photos
   * still without a preview, "Save and rebuild tonight" from the save, and Stop while a rebuild runs.
   */
  import { goto } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import SegmentedControl from '$lib/components/frameleaf/SegmentedControl.svelte';
  import Scale from '$lib/components/frameleaf/settings/editing/Scale.svelte';
  import Advanced from '$lib/components/frameleaf/settings/kit/Advanced.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import Reread from '$lib/components/frameleaf/settings/kit/Reread.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Said from '$lib/components/frameleaf/settings/kit/Said.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Select from '$lib/components/frameleaf/settings/kit/Select.svelte';
  import Switch from '$lib/components/frameleaf/settings/kit/Switch.svelte';
  import SettingActions from '$lib/components/frameleaf/settings/SettingActions.svelte';
  import {
    applyPreviewQuality,
    PREVIEW_QUALITIES,
    previewQualityOf,
    previewSpaceFor,
    type PreviewQuality,
  } from '$lib/frameleaf/playback-presets';
  import { formatBytes } from '$lib/frameleaf/format-bytes';
  import { saveAndRedo } from '$lib/frameleaf/library-progress';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { requireSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import {
    Colorspace,
    emptyQueue,
    getMediaCopies,
    getQueue,
    ImageFormat,
    LibraryRedoQueue,
    LibraryRedoWhen,
    QueueCommand,
    QueueName,
    runQueueCommandLegacy,
    type MediaCopiesResponseDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiImageMultipleOutline, mdiStop, mdiSync } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';

  const disabled = $derived(featureFlagsManager.value.configFile);
  const settingsDraft = requireSystemConfigDraft();
  const configToEdit = $derived(settingsDraft.draft);
  const config = $derived(settingsDraft.baseline);

  const quality = $derived(previewQualityOf(configToEdit.image));
  const QUALITY_NAME: Record<PreviewQuality, Translations> = {
    saver: 'frameleaf_play_img_saver',
    balanced: 'frameleaf_play_img_balanced',
    sharp: 'frameleaf_play_img_sharp',
  };

  /** The fields a rebuild would change for photos already in the library. */
  const previewFields = (image: typeof config.image) =>
    JSON.stringify([image.thumbnail, image.preview, image.fullsize, image.colorspace, image.extractEmbedded]);
  const changed = $derived(previewFields(configToEdit.image) !== previewFields(config.image));

  const undo = () => {
    const saved = $state.snapshot(config.image);
    configToEdit.image.thumbnail = { ...saved.thumbnail };
    configToEdit.image.preview = { ...saved.preview };
    configToEdit.image.fullsize = { ...saved.fullsize };
    configToEdit.image.colorspace = saved.colorspace;
    configToEdit.image.extractEmbedded = saved.extractEmbedded;
  };

  const SIZE_WORDS = [
    'frameleaf_play_size_smaller',
    'frameleaf_play_size_small',
    'frameleaf_play_size_medium',
    'frameleaf_play_size_large',
    'frameleaf_play_size_largest',
  ] as const;
  const THUMBNAIL_SIZES = [200, 250, 480, 720, 1080];
  const PREVIEW_SIZES = [720, 1080, 1440, 2160];
  /** Size choices in words; a size saved outside them is shown as it is and kept. */
  const sizeOptions = (sizes: number[], current: number) => {
    const words = sizes.length === THUMBNAIL_SIZES.length ? SIZE_WORDS : SIZE_WORDS.slice(1);
    return [
      ...sizes.map((size, index) => ({ value: String(size), label: $t(words[index], { values: { size } }) })),
      ...(sizes.includes(current)
        ? []
        : [{ value: String(current), label: $t('frameleaf_play_size_px', { values: { size: current } }) }]),
    ];
  };
  const FORMATS = [
    { value: ImageFormat.Webp, label: 'WebP' },
    { value: ImageFormat.Jpeg, label: 'JPEG' },
  ];

  type Copy = { format: ImageFormat; progressive?: boolean };
  /** A WebP picture cannot load progressively, so choosing WebP turns that off, as before. */
  const setFormat = (copy: Copy, format: string) => {
    copy.format = format as ImageFormat;
    if (copy.format === ImageFormat.Webp) {
      copy.progressive = false;
    }
  };

  let waiting = $state(0);
  let said = $state('');
  let rebuilding = $state(false);
  let stopping = $state(false);
  /** FL-521: the space previews take and how many photos have none yet. */
  let copies = $state<MediaCopiesResponseDto>();

  const readWaiting = async () => {
    try {
      const queue = await getQueue({ name: QueueName.ThumbnailGeneration });
      waiting = (queue?.statistics.active ?? 0) + (queue?.statistics.waiting ?? 0);
    } catch {
      // The status then says what previews are, without a count.
    }
  };

  onMount(async () => {
    await readWaiting();
    try {
      copies = await getMediaCopies();
    } catch {
      // Without the counts the page says what previews are, without sizes.
    }
  });

  const library = $derived(copies ? copies.photos + copies.videos : 0);
  const okBody = $derived(
    copies && copies.previewsBytes !== null
      ? $t('frameleaf_play_img_ok_space', {
          values: { size: formatBytes(copies.previewsBytes), count: library },
        })
      : $t('frameleaf_play_img_ok_body'),
  );
  /** About what each choice would take, from what previews take now with the saved numbers. */
  const spaceFor = (choice: PreviewQuality) =>
    copies && copies.previewsBytes !== null && copies.previewsBytes > 0
      ? $t('frameleaf_play_img_space_choice', {
          values: { size: formatBytes(previewSpaceFor(copies.previewsBytes, config.image, choice)) },
        })
      : '';
  const rebuildTonight = $derived(copies?.tonight.includes(LibraryRedoQueue.ThumbnailGeneration) ?? false);

  /** FL-521: Stop. What is already made stays; the rest keeps its old preview until the next rebuild. */
  const stop = async () => {
    stopping = true;
    try {
      await emptyQueue({ name: QueueName.ThumbnailGeneration, queueDeleteDto: { failed: false } });
      said = $t('frameleaf_play_img_stopped');
      await readWaiting();
    } catch (error) {
      handleError(error, $t('frameleaf_play_img_stop_failed'));
    } finally {
      stopping = false;
    }
  };

  const saveForNew = async () => {
    if (await settingsDraft.saveKeys(['image'])) {
      said = $t('frameleaf_play_img_saved_new');
    }
  };
  const saveAndRebuildTonight = async () => {
    try {
      if (await saveAndRedo(settingsDraft, ['image'], LibraryRedoQueue.ThumbnailGeneration, LibraryRedoWhen.Tonight)) {
        said = $t('frameleaf_play_img_saved_tonight');
        copies = copies ? { ...copies, tonight: [...copies.tonight, LibraryRedoQueue.ThumbnailGeneration] } : copies;
      }
    } catch (error) {
      handleError(error, $t('frameleaf_play_img_rebuild_failed'));
    }
  };

  const rebuild = async () => {
    rebuilding = true;
    try {
      await runQueueCommandLegacy({
        name: QueueName.ThumbnailGeneration,
        queueCommandDto: { command: QueueCommand.Start, force: true },
      });
      said = $t('frameleaf_play_img_rebuild_started');
      await readWaiting();
    } catch (error) {
      handleError(error, $t('frameleaf_play_img_rebuild_failed'));
    } finally {
      rebuilding = false;
    }
  };
</script>

<KitPage>
  <Said message={said} onDismiss={() => (said = '')} />

  {#if waiting > 0}
    <Hero
      icon={mdiSync}
      title={$t('frameleaf_play_img_working')}
      body={$t('frameleaf_play_img_working_body', { values: { count: waiting } })}
      label={$t('frameleaf_play_img_label')}
    >
      {#snippet actions()}
        <Button disabled={stopping || disabled} onclick={stop}>
          <Icon icon={mdiStop} size="1em" aria-hidden />
          {$t('frameleaf_play_stop')}
        </Button>
      {/snippet}
    </Hero>
  {:else if copies && copies.withoutPreview > 0}
    <Hero
      tone="warn"
      icon={mdiImageMultipleOutline}
      title={$t('frameleaf_play_img_missing', { values: { count: copies.withoutPreview } })}
      body={$t('frameleaf_play_img_missing_body')}
      label={$t('frameleaf_play_img_label')}
    />
  {:else}
    <Hero
      icon={mdiImageMultipleOutline}
      title={$t('frameleaf_play_img_ok')}
      body={okBody}
      label={$t('frameleaf_play_img_label')}
    />
  {/if}
  {#if rebuildTonight && waiting === 0}
    <Notice title={$t('frameleaf_play_img_tonight')}>{$t('frameleaf_play_img_tonight_body')}</Notice>
  {/if}

  <Section title={$t('frameleaf_play_img_section')}>
    <Row
      label={$t('frameleaf_play_img_quality')}
      help={quality
        ? `${$t(`frameleaf_play_img_${quality}_help` as Translations)} ${spaceFor(quality)}`.trim()
        : $t('frameleaf_play_img_custom_help')}
      lead={quality ? $t(QUALITY_NAME[quality]) : $t('frameleaf_play_custom')}
    >
      <SegmentedControl
        label={$t('frameleaf_play_img_quality')}
        options={[
          ...PREVIEW_QUALITIES.map((value) => ({ value, label: $t(QUALITY_NAME[value]) })),
          ...(quality ? [] : [{ value: 'custom', label: $t('frameleaf_play_custom') }]),
        ]}
        value={quality ?? 'custom'}
        {disabled}
        onChange={(value) => {
          if (value !== 'custom') {
            applyPreviewQuality(configToEdit.image, value as PreviewQuality);
          }
        }}
      />
    </Row>
    <Row label={$t('frameleaf_play_img_full')} help={$t('frameleaf_play_img_full_help')}>
      <Switch
        label={$t('frameleaf_play_img_full')}
        checked={configToEdit.image.fullsize.enabled}
        held={disabled}
        onChange={(value) => (configToEdit.image.fullsize.enabled = value)}
      />
    </Row>
    {#if changed}
      <Reread
        title={$t('frameleaf_play_img_changed')}
        body={$t('frameleaf_play_img_changed_reread', { values: { count: library } })}
        {disabled}
        choices={[
          { label: $t('frameleaf_play_img_save_tonight'), run: saveAndRebuildTonight },
          { label: $t('frameleaf_play_img_save_new'), run: saveForNew },
        ]}
        onUndo={undo}
      />
    {/if}
    <Row label={$t('frameleaf_play_img_rebuild_row')} help={$t('frameleaf_play_img_rebuild_help')}>
      <Button disabled={rebuilding} onclick={rebuild}>{$t('frameleaf_play_img_rebuild')}</Button>
    </Row>
    <Row label={$t('frameleaf_play_img_overnight')} help={$t('frameleaf_play_img_overnight_help')}>
      <Button onclick={() => goto(commandCenterUrl('processing', 'nightly-tasks'))}>
        {$t('frameleaf_play_overnight_link')}
      </Button>
    </Row>

    <Advanced summary={$t('frameleaf_play_adv_thumbnails')}>
      <p class="hint">{$t('frameleaf_play_adv_thumbnails_hint')}</p>
      <Row label={$t('frameleaf_play_size')} help={$t('frameleaf_play_size_help')}>
        <Select
          label={$t('frameleaf_play_thumbnail_size')}
          value={String(configToEdit.image.thumbnail.size)}
          options={sizeOptions(THUMBNAIL_SIZES, configToEdit.image.thumbnail.size)}
          {disabled}
          onChange={(value) => (configToEdit.image.thumbnail.size = Number(value))}
        />
      </Row>
      <Row label={$t('frameleaf_play_format')} help={$t('frameleaf_play_format_help')}>
        <SegmentedControl
          label={$t('frameleaf_play_thumbnail_format')}
          options={FORMATS}
          value={configToEdit.image.thumbnail.format}
          {disabled}
          onChange={(value) => setFormat(configToEdit.image.thumbnail, value)}
        />
      </Row>
      <Row label={$t('frameleaf_play_quality')}>
        <Scale
          label={$t('frameleaf_play_thumbnail_quality')}
          low={$t('frameleaf_play_quality_low')}
          high={$t('frameleaf_play_quality_high')}
          value={configToEdit.image.thumbnail.quality}
          {disabled}
          onChange={(value) => (configToEdit.image.thumbnail.quality = value)}
        />
      </Row>
      <Row label={$t('frameleaf_play_blurry')} help={$t('frameleaf_play_blurry_help')}>
        <Switch
          label={$t('frameleaf_play_thumbnail_blurry')}
          checked={configToEdit.image.thumbnail.progressive ?? false}
          held={disabled || configToEdit.image.thumbnail.format === ImageFormat.Webp}
          onChange={(value) => (configToEdit.image.thumbnail.progressive = value)}
        />
      </Row>
    </Advanced>

    <Advanced summary={$t('frameleaf_play_adv_previews')}>
      <p class="hint">{$t('frameleaf_play_adv_previews_hint')}</p>
      <Row label={$t('frameleaf_play_size')} help={$t('frameleaf_play_size_help')}>
        <Select
          label={$t('frameleaf_play_preview_size')}
          value={String(configToEdit.image.preview.size)}
          options={sizeOptions(PREVIEW_SIZES, configToEdit.image.preview.size)}
          {disabled}
          onChange={(value) => (configToEdit.image.preview.size = Number(value))}
        />
      </Row>
      <Row label={$t('frameleaf_play_format')} help={$t('frameleaf_play_format_help')}>
        <SegmentedControl
          label={$t('frameleaf_play_preview_format')}
          options={FORMATS}
          value={configToEdit.image.preview.format}
          {disabled}
          onChange={(value) => setFormat(configToEdit.image.preview, value)}
        />
      </Row>
      <Row label={$t('frameleaf_play_quality')}>
        <Scale
          label={$t('frameleaf_play_preview_quality')}
          low={$t('frameleaf_play_quality_low')}
          high={$t('frameleaf_play_quality_high')}
          value={configToEdit.image.preview.quality}
          {disabled}
          onChange={(value) => (configToEdit.image.preview.quality = value)}
        />
      </Row>
      <Row label={$t('frameleaf_play_blurry')} help={$t('frameleaf_play_blurry_help')}>
        <Switch
          label={$t('frameleaf_play_preview_blurry')}
          checked={configToEdit.image.preview.progressive ?? false}
          held={disabled || configToEdit.image.preview.format === ImageFormat.Webp}
          onChange={(value) => (configToEdit.image.preview.progressive = value)}
        />
      </Row>
    </Advanced>

    <Advanced summary={$t('frameleaf_play_adv_full')}>
      <p class="hint">{$t('frameleaf_play_adv_full_hint')}</p>
      <Row label={$t('frameleaf_play_format')} help={$t('frameleaf_play_format_full_help')}>
        <SegmentedControl
          label={$t('frameleaf_play_full_format')}
          options={FORMATS}
          value={configToEdit.image.fullsize.format}
          disabled={disabled || !configToEdit.image.fullsize.enabled}
          onChange={(value) => setFormat(configToEdit.image.fullsize, value)}
        />
      </Row>
      <Row label={$t('frameleaf_play_quality')}>
        <Scale
          label={$t('frameleaf_play_full_quality')}
          low={$t('frameleaf_play_quality_low')}
          high={$t('frameleaf_play_quality_high')}
          value={configToEdit.image.fullsize.quality}
          disabled={disabled || !configToEdit.image.fullsize.enabled}
          onChange={(value) => (configToEdit.image.fullsize.quality = value)}
        />
      </Row>
      <Row label={$t('frameleaf_play_blurry')} help={$t('frameleaf_play_blurry_help')}>
        <Switch
          label={$t('frameleaf_play_full_blurry')}
          checked={configToEdit.image.fullsize.progressive ?? false}
          held={disabled ||
            !configToEdit.image.fullsize.enabled ||
            configToEdit.image.fullsize.format === ImageFormat.Webp}
          onChange={(value) => (configToEdit.image.fullsize.progressive = value)}
        />
      </Row>
    </Advanced>

    <Advanced summary={$t('frameleaf_play_adv_colour')}>
      <Row label={$t('frameleaf_play_colour')} help={$t('frameleaf_play_colour_help')}>
        <SegmentedControl
          label={$t('frameleaf_play_colour')}
          options={[
            { value: Colorspace.P3, label: $t('frameleaf_play_colour_p3') },
            { value: Colorspace.Srgb, label: $t('frameleaf_play_colour_srgb') },
          ]}
          value={configToEdit.image.colorspace}
          {disabled}
          onChange={(value) => (configToEdit.image.colorspace = value as Colorspace)}
        />
      </Row>
      <Row label={$t('frameleaf_play_camera')} help={$t('frameleaf_play_camera_help')}>
        <Switch
          label={$t('frameleaf_play_camera')}
          checked={configToEdit.image.extractEmbedded}
          held={disabled}
          onChange={(value) => (configToEdit.image.extractEmbedded = value)}
        />
      </Row>
      <Row label={$t('frameleaf_play_raw')} help={$t('frameleaf_play_raw_help')}>
        <Switch
          label={$t('frameleaf_play_raw')}
          checked={configToEdit.image.enhancedRaw?.enabled !== false}
          held={disabled}
          onChange={(value) => (configToEdit.image.enhancedRaw = { enabled: value })}
        />
      </Row>
    </Advanced>
  </Section>

  <SettingActions keys={['image']} {disabled} />
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
