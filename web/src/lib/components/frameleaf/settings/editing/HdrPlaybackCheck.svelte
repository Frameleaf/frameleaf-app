<script lang="ts">
  /**
   * FL-977: Video playback copies › Speed › HDR videos, after the approved prototype (FL-773,
   * `settings-v2/care/doctor.jsx`, `HdrCheck`): whether the graphics card plays HDR correctly or HDR
   * videos are converted on the processor, from the server's playback self-test, with Check again.
   * While a check runs it is read again every two seconds.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Pill, { type KitTone } from '$lib/components/frameleaf/settings/kit/Pill.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { handleError } from '$lib/utils/handle-error';
  import { HDR_CASES, hdrCheckState } from '$lib/components/frameleaf/settings/editing/hdr-playback-check';
  import {
    getPlaybackSelfTest,
    PlaybackSelfTestStatus,
    startPlaybackSelfTest,
    type PlaybackSelfTestResponseDto,
  } from '@frameleaf/sdk';
  import { DateTime } from 'luxon';
  import { onDestroy, onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  let {
    card,
    slowdown = null,
    disabled = false,
  }: {
    /** The name of the graphics card the copies are made with, as the switch above says it. */
    card: string;
    /** About how many times slower the processor is, when the card test measured it. */
    slowdown?: number | null;
    disabled?: boolean;
  } = $props();

  let result = $state<PlaybackSelfTestResponseDto>();
  let starting = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let destroyed = false;

  const phase = $derived(starting ? 'running' : hdrCheckState(result));

  const read = async () => {
    clearTimeout(timer);
    try {
      result = (await getPlaybackSelfTest()) ?? undefined;
    } catch {
      // Without the result the row says the check has not run.
    }
    if (!destroyed && result?.status === PlaybackSelfTestStatus.Running) {
      timer = setTimeout(() => void read(), 2000);
    }
  };

  const checkAgain = async () => {
    starting = true;
    try {
      result = await startPlaybackSelfTest();
      timer = setTimeout(() => void read(), 2000);
    } catch (error) {
      handleError(error, $t('frameleaf_play_hdr_check_error'));
    } finally {
      starting = false;
    }
  };

  onMount(() => void read());
  onDestroy(() => {
    destroyed = true;
    clearTimeout(timer);
  });

  const testedOn = $derived.by(() => {
    if (!result?.finishedAt) {
      return '';
    }
    const finished = DateTime.fromISO(result.finishedAt, { locale: $locale });
    return finished.hasSame(DateTime.now(), 'day')
      ? $t('frameleaf_play_hdr_hardware_help_today', { values: { card } })
      : $t('frameleaf_play_hdr_hardware_help_on', {
          values: { card, date: finished.toLocaleString({ month: 'short', day: 'numeric' }) },
        });
  });

  /** Kinds of video other than HDR that the check also put on the processor. */
  const others = $derived(
    (result?.softwareFallback ?? []).some((kind) => !HDR_CASES.has(kind)) ? $t('frameleaf_play_hdr_others') : '',
  );

  const words = $derived.by((): { tone: KitTone; title: string; help: string } => {
    switch (phase) {
      case 'hardware': {
        return { tone: 'good', title: $t('frameleaf_play_hdr_hardware'), help: testedOn };
      }
      case 'software': {
        return {
          tone: 'warn',
          title: $t('frameleaf_play_hdr_software'),
          help: slowdown
            ? $t('frameleaf_play_hdr_software_help', { values: { times: Math.round(slowdown) } })
            : $t('frameleaf_play_hdr_software_help_plain'),
        };
      }
      case 'running': {
        return { tone: 'off', title: $t('frameleaf_play_hdr_running'), help: $t('frameleaf_play_hdr_running_help') };
      }
      case 'failed': {
        return { tone: 'warn', title: $t('frameleaf_play_hdr_failed'), help: $t('frameleaf_play_hdr_failed_help') };
      }
      default: {
        return { tone: 'off', title: $t('frameleaf_play_hdr_none'), help: $t('frameleaf_play_hdr_none_help') };
      }
    }
  });
</script>

<Row
  label={$t('frameleaf_play_hdr')}
  help={others && phase !== 'running' ? `${words.help} ${others}`.trim() : words.help}
>
  <span class="hdr">
    <Pill tone={words.tone}>{words.title}</Pill>
    <Button disabled={disabled || phase === 'running'} onclick={checkAgain}>
      {phase === 'running'
        ? $t('frameleaf_play_hdr_checking')
        : phase === 'none'
          ? $t('frameleaf_play_hdr_check_now')
          : $t('frameleaf_play_hdr_check_again')}
    </Button>
  </span>
</Row>

<style>
  .hdr {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: var(--fl-space-3);
  }
  @media (max-width: 640px) {
    .hdr {
      justify-content: flex-start;
    }
  }
</style>
