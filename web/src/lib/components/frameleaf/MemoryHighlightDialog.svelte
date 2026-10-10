<script lang="ts" module>
  export type MemoryHighlightChoice = {
    lengthSeconds: number;
    resolution: StudioExportResolution;
    audio: MemoryHighlightAudio;
    destination: MemoryHighlightDestination;
  };

  /** The lengths offered, in seconds, and the one the dialog starts from. */
  export const highlightLengths = [30, 60, 120] as const;
  export const defaultHighlightChoice: MemoryHighlightChoice = {
    lengthSeconds: 60,
    resolution: StudioExportResolution.$2160P,
    audio: MemoryHighlightAudio.Original,
    destination: MemoryHighlightDestination.Local,
  };
</script>

<script lang="ts">
  /**
   * Ask for a highlight video of a memory (FL-194): length, resolution, sound and where it renders.
   *
   * The memory player (`MemoryPlayer.jsx`) shows no such sheet, so this follows its nearest pattern,
   * Studio's `ExportDialog` (`Studio.jsx`), which the highlight renders through: the same resolutions
   * largest first with 2160p chosen, the same "Render on" choice of this server or the home network,
   * and every resolution judged against what the qualified render workers verified (FL-42), so an
   * export the server would refuse is disabled with its reason before anything is submitted. The
   * highlight's own format and colour are the dialog's defaults (H.265 Main10, source colour).
   */
  import {
    MemoryHighlightAudio,
    MemoryHighlightDestination,
    StudioExportColor,
    StudioExportFormat,
    StudioExportResolution,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiAlertOutline, mdiMovieOpenPlayOutline } from '@mdi/js';
  import type { Translations } from 'svelte-i18n';
  import { t } from 'svelte-i18n';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import type { StudioRenderEvidence } from '$lib/frameleaf/studio/host-contract';
  import {
    evaluateStudioRender,
    studioRenderChoices,
    studioRenderRefusalKey,
  } from '$lib/frameleaf/studio/render-output';

  let {
    open = $bindable(false),
    memoryTitle,
    initial = defaultHighlightChoice,
    busy = false,
    renderEvidence = [],
    onStart,
  }: {
    open?: boolean;
    memoryTitle: string;
    /** What the dialog opens with: the defaults, or a failed run's settings for a retry. */
    initial?: MemoryHighlightChoice;
    busy?: boolean;
    /** What the qualified render workers verified, per destination (FL-42). */
    renderEvidence?: readonly StudioRenderEvidence[];
    onStart: (choice: MemoryHighlightChoice) => void;
  } = $props();

  const lengthLabels: Record<(typeof highlightLengths)[number], Translations> = {
    30: 'frameleaf_memories_highlight_length_30',
    60: 'frameleaf_memories_highlight_length_60',
    120: 'frameleaf_memories_highlight_length_120',
  };
  const resolutions: { value: StudioExportResolution; label: Translations }[] = [
    { value: StudioExportResolution.$2160P, label: 'frameleaf_studio_export_resolution_2160' },
    { value: StudioExportResolution.$1440P, label: 'frameleaf_studio_export_resolution_1440' },
    { value: StudioExportResolution.$1080P, label: 'frameleaf_studio_export_resolution_1080' },
    { value: StudioExportResolution.$720P, label: 'frameleaf_studio_export_resolution_720' },
  ];
  const sounds: { value: MemoryHighlightAudio; label: Translations }[] = [
    { value: MemoryHighlightAudio.Original, label: 'frameleaf_memories_highlight_audio_original' },
    { value: MemoryHighlightAudio.Silent, label: 'frameleaf_memories_highlight_audio_silent' },
  ];
  const destinations: { value: MemoryHighlightDestination; label: Translations }[] = [
    { value: MemoryHighlightDestination.Local, label: 'frameleaf_activity_destination_local' },
    { value: MemoryHighlightDestination.Lan, label: 'frameleaf_activity_destination_lan' },
  ];

  let lengthSeconds = $state(defaultHighlightChoice.lengthSeconds);
  let resolution = $state(defaultHighlightChoice.resolution);
  let audio = $state(defaultHighlightChoice.audio);
  let destination = $state(defaultHighlightChoice.destination);
  const fieldId = $props.id();

  // Every opening starts from what it was given.
  $effect(() => {
    if (!open) {
      return;
    }
    ({ lengthSeconds, resolution, audio, destination } = initial);
  });

  const settings = $derived({
    format: StudioExportFormat.Mp4HevcMain10,
    color: StudioExportColor.Preserve,
    resolution,
  });
  const choices = $derived(studioRenderChoices(renderEvidence, destination, settings).resolutions);
  const verdict = $derived(evaluateStudioRender(renderEvidence, destination, settings));
  const canStart = $derived(!busy && verdict.supported);

  const submit = () => {
    if (canStart) {
      onStart({ lengthSeconds, resolution, audio, destination });
    }
  };
</script>

<Dialog
  bind:open
  title={$t('frameleaf_memories_highlight_title', { values: { title: memoryTitle } })}
  closeLabel={$t('close')}
>
  <div class="highlight" data-testid="memory-highlight-dialog">
    <div class="grid">
      <label class="field" for="{fieldId}-length">
        <span>{$t('frameleaf_memories_highlight_length')}</span>
        <select id="{fieldId}-length" bind:value={lengthSeconds}>
          {#each highlightLengths as value (value)}
            <option {value}>{$t(lengthLabels[value])}</option>
          {/each}
        </select>
      </label>
      <label class="field" for="{fieldId}-resolution">
        <span>{$t('frameleaf_studio_export_resolution')}</span>
        <select id="{fieldId}-resolution" bind:value={resolution}>
          {#each resolutions as item (item.value)}
            <option
              value={item.value}
              disabled={choices.find((choice) => choice.value === item.value)?.verdict.supported === false}
              >{$t(item.label)}</option
            >
          {/each}
        </select>
      </label>
      <label class="field" for="{fieldId}-audio">
        <span>{$t('frameleaf_memories_highlight_audio')}</span>
        <select id="{fieldId}-audio" bind:value={audio}>
          {#each sounds as item (item.value)}
            <option value={item.value}>{$t(item.label)}</option>
          {/each}
        </select>
      </label>
      <label class="field" for="{fieldId}-destination">
        <span>{$t('frameleaf_studio_export_destination')}</span>
        <select id="{fieldId}-destination" bind:value={destination}>
          {#each destinations as item (item.value)}
            <option value={item.value}>{$t(item.label)}</option>
          {/each}
        </select>
      </label>
    </div>

    {#if !verdict.supported}
      <p class="note warning" role="status">
        <Icon icon={mdiAlertOutline} size="14" aria-hidden={true} />
        {$t(studioRenderRefusalKey(verdict.refusal))}
      </p>
    {/if}
    <p class="note">{$t('frameleaf_memories_highlight_note')}</p>

    <footer>
      <Button onclick={() => (open = false)}>{$t('cancel')}</Button>
      <Button variant="primary" disabled={!canStart} onclick={submit}>
        <Icon icon={mdiMovieOpenPlayOutline} size="16" aria-hidden={true} />
        {$t('frameleaf_memories_highlight_start')}
      </Button>
    </footer>
  </div>
</Dialog>

<style>
  /* studio.css `.fls-dialog-grid`, `.fls-field`, `.fls-note`, as in StudioExportDialog. */
  .highlight {
    display: grid;
    gap: 0.75rem;
    margin-top: 0.75rem;
    min-width: min(30rem, 100%);
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.75rem;
  }
  .field {
    display: grid;
    gap: 0.3rem;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .field select {
    min-height: 34px;
    padding: 0 0.5rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    background: var(--fl-panel);
    color: var(--fl-text);
    font: inherit;
  }
  .note {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .note.warning {
    color: var(--fl-warning);
  }
  footer {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 0.5rem;
  }
  @media (max-width: 520px) {
    .grid {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
