<script lang="ts">
  /**
   * "Download" (FL-826), after `DownloadFormatDialog` in the approved prototype's
   * `QuickWinsJanMar.jsx`: three choices with what each is and about how big the download would be,
   * starting on the account's default. Sizes come from the server's own estimate for the same
   * items; while they load, or if they can't be read, the choices show without them.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { DOWNLOAD_FORMATS, type DownloadQuestion } from '$lib/frameleaf/download-format';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import { DownloadFormat, getDownloadInfo } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiDownloadOutline, mdiRadioboxBlank, mdiRadioboxMarked } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';

  interface Props extends DownloadQuestion {
    initial: DownloadFormat;
    onClose: (format?: DownloadFormat) => void;
  }

  const { count, info, hasVideo = false, initial, onClose }: Props = $props();

  // svelte-ignore state_referenced_locally
  let format = $state(initial);
  let open = $state(true);
  let chosen: DownloadFormat | undefined;
  let sizes = $state<Partial<Record<DownloadFormat, number>>>({});

  const label = (id: DownloadFormat) => $t(`frameleaf_download_format_${id}` as Translations);
  const note = (id: DownloadFormat) => $t(`frameleaf_download_format_${id}_note` as Translations);
  const several = $derived(count === undefined ? !!info?.albumId : count > 1);
  const hint = $derived(
    [
      hasVideo && format !== DownloadFormat.Original ? $t('frameleaf_download_format_videos') : '',
      several ? $t('frameleaf_download_format_zip') : '',
      authManager.authenticated ? $t('frameleaf_download_format_default', { values: { format: label(initial) } }) : '',
    ]
      .filter(Boolean)
      .join(' '),
  );

  onMount(() => {
    if (!info) {
      return;
    }
    const controller = new AbortController();
    for (const id of DOWNLOAD_FORMATS) {
      getDownloadInfo(
        { ...authManager.params, downloadInfoDto: { ...info, format: id } },
        { signal: controller.signal },
      )
        .then((response) => (sizes = { ...sizes, [id]: response.totalSize }))
        // The size is a help, not a need: without it the choice still works.
        .catch(() => {});
    }
    return () => controller.abort();
  });

  const choose = (event: KeyboardEvent) => {
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
    if (!step) {
      return;
    }
    event.preventDefault();
    const next = (DOWNLOAD_FORMATS.indexOf(format) + step + DOWNLOAD_FORMATS.length) % DOWNLOAD_FORMATS.length;
    format = DOWNLOAD_FORMATS[next];
    (event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
  };
</script>

<Dialog
  title={count !== undefined && count > 1
    ? $t('frameleaf_download_format_title_count', { values: { count } })
    : $t('download')}
  closeLabel={$t('close')}
  bind:open
  onClosed={() => onClose(chosen)}
>
  <div class="formats" role="radiogroup" aria-label={$t('frameleaf_download_format_group')} onkeydown={choose}>
    {#each DOWNLOAD_FORMATS as id (id)}
      <button
        type="button"
        role="radio"
        aria-checked={format === id}
        tabindex={format === id ? 0 : -1}
        class="format"
        class:on={format === id}
        onclick={() => (format = id)}
      >
        <Icon icon={format === id ? mdiRadioboxMarked : mdiRadioboxBlank} size="20" aria-hidden="true" />
        <span class="words">
          <b>{label(id)}</b>
          <small>{note(id)}</small>
        </span>
        {#if sizes[id] !== undefined}
          <span class="size">
            {$t('frameleaf_download_format_about', { values: { size: getByteUnitString(sizes[id] ?? 0, $locale) } })}
          </span>
        {/if}
      </button>
    {/each}
  </div>
  <p class="hint">{hint}</p>
  {#snippet actions()}
    <Button onclick={() => (open = false)}>{$t('cancel')}</Button>
    <Button
      variant="primary"
      initialFocus
      onclick={() => {
        chosen = format;
        open = false;
      }}
    >
      <Icon icon={mdiDownloadOutline} size="18" aria-hidden="true" />
      {$t('download')}
    </Button>
  {/snippet}
</Dialog>

<style>
  /* The prototype's `.qw-formats`, `.qw-format`, `.qw-format-size`, `.qw-format-hint` (quick-wins.css). */
  .formats {
    display: grid;
    gap: 8px;
  }
  .format {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 56px;
    padding: 12px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    background: var(--fl-panel);
    color: inherit;
    font: inherit;
    text-align: start;
    cursor: pointer;
  }
  .format.on {
    border-color: var(--fl-accent);
    background: var(--fl-accent-soft);
  }
  .format :global(svg) {
    flex: none;
    color: var(--fl-muted);
  }
  .format.on :global(svg) {
    color: var(--fl-accent);
  }
  .words {
    display: grid;
    flex: 1;
    gap: 2px;
    min-width: 0;
  }
  .words small,
  .size {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .size {
    flex: none;
    font-variant-numeric: tabular-nums;
  }
  .hint {
    margin: 16px 0 0;
    color: var(--fl-muted);
    line-height: 1.5;
  }
  @media (max-width: 520px) {
    .format {
      flex-wrap: wrap;
    }
    .size {
      margin-inline-start: 32px;
    }
  }
</style>
