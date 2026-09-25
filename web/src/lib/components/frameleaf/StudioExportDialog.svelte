<script lang="ts" module>
  export type StudioExportChoice = {
    format: StudioExportFormat;
    color: StudioExportColor;
    resolution: StudioExportResolution;
    destination: MediaOperationDestination;
    /** Only ever true for a destination that leaves the network, and only when ticked. */
    cloudConsent: boolean;
  };
</script>

<script lang="ts">
  /**
   * Export the project as a video (FL-88 header, FL-106 server), ported from `ExportDialog` in
   * `design/frameleaf/template/src/Studio.jsx:1661-1739`: Format, Colour, Resolution and Render on,
   * with the prototype's notes. The render runs as a durable job on the server and is followed in
   * Activity; nothing renders in the browser.
   *
   * Two deliberate differences, both about not saying something untrue: a destination that leaves
   * the network needs an explicit consent tick (the server refuses a cloud export without one), and
   * the time, size and cost rows are not shown, because nothing on the server measures them for a
   * Studio export yet and the prototype's figures are simulated.
   */
  import { t } from 'svelte-i18n';
  import {
    MediaOperationDestination,
    StudioExportColor,
    StudioExportFormat,
    StudioExportResolution,
  } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiAlertOutline, mdiExportVariant } from '@mdi/js';
  import type { Translations } from 'svelte-i18n';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';

  let {
    open = $bindable(false),
    sequenceName,
    busy = false,
    onExport,
  }: {
    open?: boolean;
    sequenceName: string;
    busy?: boolean;
    onExport: (choice: StudioExportChoice) => void;
  } = $props();

  const formats: { value: StudioExportFormat; label: Translations }[] = [
    { value: StudioExportFormat.Mp4HevcMain10, label: 'frameleaf_studio_export_format_hevc' },
    { value: StudioExportFormat.Mp4H264, label: 'frameleaf_studio_export_format_h264' },
    { value: StudioExportFormat.WebmAv1, label: 'frameleaf_studio_export_format_av1' },
    { value: StudioExportFormat.Prores422Hq, label: 'frameleaf_studio_export_format_prores' },
  ];
  const colors: { value: StudioExportColor; label: Translations }[] = [
    { value: StudioExportColor.Preserve, label: 'frameleaf_studio_export_color_preserve' },
    { value: StudioExportColor.Hdr10, label: 'frameleaf_studio_export_color_hdr10' },
    { value: StudioExportColor.DolbyVision, label: 'frameleaf_studio_export_color_dolby' },
  ];
  // Largest first, as in the prototype.
  const resolutions: { value: StudioExportResolution; label: Translations }[] = [
    { value: StudioExportResolution.$2160P, label: 'frameleaf_studio_export_resolution_2160' },
    { value: StudioExportResolution.$1440P, label: 'frameleaf_studio_export_resolution_1440' },
    { value: StudioExportResolution.$1080P, label: 'frameleaf_studio_export_resolution_1080' },
    { value: StudioExportResolution.$720P, label: 'frameleaf_studio_export_resolution_720' },
  ];
  const destinations: { value: MediaOperationDestination; label: Translations; leaves: boolean }[] = [
    { value: MediaOperationDestination.Local, label: 'frameleaf_activity_destination_local', leaves: false },
    { value: MediaOperationDestination.Lan, label: 'frameleaf_activity_destination_lan', leaves: false },
    { value: MediaOperationDestination.Runpod, label: 'frameleaf_activity_destination_runpod', leaves: true },
  ];

  let format = $state(StudioExportFormat.Mp4HevcMain10);
  let color = $state(StudioExportColor.Preserve);
  let resolution = $state(StudioExportResolution.$2160P);
  let destination = $state(MediaOperationDestination.Local);
  let cloudConsent = $state(false);
  const fieldId = $props.id();

  // Every opening starts from the prototype's defaults and without consent.
  $effect(() => {
    if (!open) {
      return;
    }

    format = StudioExportFormat.Mp4HevcMain10;
    color = StudioExportColor.Preserve;
    resolution = StudioExportResolution.$2160P;
    destination = MediaOperationDestination.Local;
    cloudConsent = false;
  });

  const leaves = $derived(destinations.find((item) => item.value === destination)?.leaves ?? false);
  const canExport = $derived(!busy && (!leaves || cloudConsent));

  const submit = () => {
    if (canExport) {
      onExport({ format, color, resolution, destination, cloudConsent: leaves && cloudConsent });
    }
  };
</script>

<Dialog
  bind:open
  title={$t('frameleaf_studio_export_title', { values: { name: sequenceName } })}
  closeLabel={$t('close')}
>
  <div class="export" data-testid="studio-export-dialog">
    <div class="grid">
      <label class="field" for="{fieldId}-format">
        <span>{$t('frameleaf_studio_export_format')}</span>
        <select id="{fieldId}-format" bind:value={format}>
          {#each formats as item (item.value)}
            <option value={item.value}>{$t(item.label)}</option>
          {/each}
        </select>
      </label>
      <label class="field" for="{fieldId}-color">
        <span>{$t('frameleaf_studio_export_color')}</span>
        <select id="{fieldId}-color" bind:value={color}>
          {#each colors as item (item.value)}
            <option value={item.value}>{$t(item.label)}</option>
          {/each}
        </select>
      </label>
      <label class="field" for="{fieldId}-resolution">
        <span>{$t('frameleaf_studio_export_resolution')}</span>
        <select id="{fieldId}-resolution" bind:value={resolution}>
          {#each resolutions as item (item.value)}
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

    {#if color === StudioExportColor.DolbyVision}
      <p class="note warning">
        <Icon icon={mdiAlertOutline} size="14" aria-hidden={true} />
        {$t('frameleaf_studio_export_dolby_note')}
      </p>
    {/if}

    {#if leaves}
      <p class="note warning">{$t('frameleaf_studio_export_leaves')}</p>
      <label class="check">
        <input type="checkbox" bind:checked={cloudConsent} />
        <span>{$t('frameleaf_studio_export_cloud_consent')}</span>
      </label>
    {:else}
      <p class="note">{$t('frameleaf_studio_export_on_network')}</p>
    {/if}

    <footer>
      <Button onclick={() => (open = false)}>{$t('cancel')}</Button>
      <Button variant="primary" disabled={!canExport} onclick={submit}>
        <Icon icon={mdiExportVariant} size="16" aria-hidden={true} />
        {$t('frameleaf_studio_export_start')}
      </Button>
    </footer>
  </div>
</Dialog>

<style>
  /* studio.css `.fls-dialog-grid`, `.fls-field`, `.fls-note`. */
  .export {
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
  .check {
    display: flex;
    align-items: center;
    gap: 0.5rem;
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
