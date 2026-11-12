<script lang="ts">
  /**
   * FL-943: one thing the Date & Time Doctor found (after the approved prototype `settings-v2/care/doctor.jsx`,
   * FL-773): what went wrong in a sentence, a strip of photos with the time each has now and the time the fix gives
   * it, a zone where the zone is what's wrong, and Fix / Not now. The strip is the server's preview (FL-930), so the
   * times shown are the times the fix writes, daylight saving included.
   *
   * A card whose photos have nothing to go on (a reset or future date with no date in the name) can't be fixed
   * here: it says so and points at Library, where they are grouped under "Dates to check" with Change date.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import DateFixStrip from '$lib/components/frameleaf/DateFixStrip.svelte';
  import Picker from '$lib/components/frameleaf/Picker.svelte';
  import TextLink from '$lib/components/frameleaf/settings/kit/TextLink.svelte';
  import { cardBodyKey, cardTitle, STRIP_SIZE, UNDO_DAYS, type DateFixCard } from '$lib/frameleaf/date-doctor';
  import { timeZoneChoices } from '$lib/frameleaf/time-zones';
  import { Route } from '$lib/route';
  import { locale } from '$lib/stores/preferences.store';
  import {
    previewDateFix,
    type DateDoctorFixDto,
    type DateDoctorPreviewItemDto,
    type DateDoctorTimeDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiCalendarAlert, mdiCameraTimer, mdiEarth, mdiFileDocumentOutline } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { t } from 'svelte-i18n';

  let {
    card,
    busy = false,
    onFix,
    onLater,
  }: {
    card: DateFixCard;
    busy?: boolean;
    onFix: (fix: DateDoctorFixDto) => void;
    onLater: () => void;
  } = $props();

  const titleId = $props.id();
  const lang = $derived($locale ?? 'en');
  const count = $derived(card.findings.length);
  const title = $derived(cardTitle(card, lang));
  const icon = $derived(
    card.cause === 'burst-drift'
      ? mdiCameraTimer
      : card.zoneChoice
        ? mdiEarth
        : card.cause === 'filename-date'
          ? mdiFileDocumentOutline
          : mdiCalendarAlert,
  );

  /** The zone chosen on the card; the Doctor's own proposal until somebody picks another. */
  /** A zone the person picked; a re-read of the findings (every few seconds while checking) never resets it. */
  let picked = $state<string>();
  const zone = $derived(picked ?? card.zone ?? '');
  const chosen = $derived(card.zoneChoice && zone !== '' && zone !== card.zone);

  const fix = $derived<DateDoctorFixDto>({
    assetIds: card.findings.map((finding) => finding.assetId),
    ...(chosen ? { timeZone: zone, keepWallTime: card.keepWallTime } : { useProposal: true }),
  });

  /** How each photo is dated now, for a card the server has no fix to preview for. */
  const asNow = (date: string, zoneName: string | null): DateDoctorTimeDto => ({
    date,
    zone: zoneName,
    local: DateTime.fromISO(date, { zone: zoneName ?? 'utc' }).toFormat("yyyy-MM-dd'T'HH:mm:ss"),
  });
  const sample = $derived(card.findings.slice(0, STRIP_SIZE));
  let preview = $state<DateDoctorPreviewItemDto[]>([]);
  /** A preview is on its way for the current choice: Fix waits for it, so what's shown is what's applied. */
  let previewing = $state(false);
  let previewFailed = $state(false);
  let reads = 0;
  $effect(() => {
    if (!card.fixable) {
      return;
    }
    const body = { ...fix, assetIds: sample.map((finding) => finding.assetId) };
    const read = ++reads;
    previewing = true;
    void (async () => {
      try {
        const { items } = await previewDateFix({ dateDoctorFixDto: body });
        if (read === reads) {
          preview = items;
          previewFailed = false;
        }
      } catch {
        if (read === reads) {
          preview = [];
          previewFailed = true;
        }
      } finally {
        if (read === reads) {
          previewing = false;
        }
      }
    })();
  });
  const strip = $derived(
    card.fixable && preview.length > 0
      ? preview
      : sample.map((finding) => ({
          assetId: finding.assetId,
          before: asNow(finding.currentDate, finding.currentZone),
        })),
  );

  const zoneOptions = $derived(
    card.zoneChoice
      ? timeZoneChoices({ wallTime: strip[0]?.before.local.slice(0, 16), locale: lang }).map((choice) => ({
          id: choice.value,
          value: choice.value,
          label: choice.label,
        }))
      : [],
  );
  const selectedZone = $derived(zoneOptions.find((option) => option.value === zone));
</script>

<article class="card" aria-labelledby={titleId}>
  <header>
    <span class="icon" aria-hidden="true"><Icon {icon} size="22" /></span>
    <div>
      <h3 id={titleId}>{$t(title.key, { values: title.values })}</h3>
      <span class="count">{$t('frameleaf_date_doctor_photos', { values: { count } })}</span>
    </div>
  </header>
  <p class="body">{$t(cardBodyKey(card), { values: { count } })}</p>

  <DateFixStrip items={strip} busy={previewing} />
  {#if previewFailed}
    <p class="hint" role="status">{$t('frameleaf_date_doctor_preview_failed')}</p>
  {/if}

  {#if card.zoneChoice && card.fixable}
    <div class="zone">
      <Picker
        label={$t('frameleaf_date_doctor_taken_in')}
        options={zoneOptions}
        selectedOption={selectedZone}
        onSelect={(option) => {
          if (option) {
            picked = option.value;
          }
        }}
      />
      <span class="hint">{$t('frameleaf_date_doctor_taken_in_hint')}</span>
    </div>
  {/if}

  <div class="actions">
    {#if card.fixable}
      <Button variant="primary" disabled={busy || previewing} onclick={() => onFix(fix)}>
        {$t('frameleaf_date_doctor_fix', { values: { count } })}
      </Button>
    {:else}
      <TextLink href={Route.photos()}>{$t('frameleaf_date_doctor_show_in_library')}</TextLink>
    {/if}
    <Button disabled={busy} onclick={onLater}>{$t('frameleaf_date_doctor_not_now')}</Button>
  </div>
  {#if card.fixable}
    <p class="hint">{$t('frameleaf_date_doctor_promise', { values: { days: UNDO_DAYS } })}</p>
  {/if}
</article>

<style>
  .card {
    display: grid;
    gap: var(--fl-space-4);
    padding: var(--fl-space-5);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  header {
    display: flex;
    align-items: flex-start;
    gap: var(--fl-space-3);
  }
  .icon {
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    flex: none;
    color: var(--fl-accent);
    background: var(--fl-accent-soft);
    border-radius: var(--fl-radius-control);
  }
  h3 {
    margin: 0;
    font-size: 1rem;
    line-height: 1.35;
  }
  .count,
  .hint {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .body {
    max-width: 760px;
    margin: 0;
    color: var(--fl-muted);
    line-height: 1.5;
  }
  .zone {
    display: grid;
    gap: var(--fl-space-2);
    max-width: 480px;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fl-space-2);
  }
  p.hint {
    margin: 0;
  }
  @container kit (max-width: 620px) {
    .card {
      padding: var(--fl-space-4);
    }
  }
</style>
