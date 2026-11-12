<script lang="ts">
  /**
   * Library care › Things to fix › Dates that look wrong: the Date & Time Doctor (FL-943, after the approved
   * prototype `settings-v2/care/doctor.jsx` DateDoctor, FL-773). Every account opens it for its own photos.
   *
   * The findings (FL-912) are shown as cards, one per thing that went wrong (`dateFixCards`), each with its fix
   * previewed on a strip of photos. Fix applies it (FL-930); Not now hides the card until the page is opened again.
   * Recent fixes lists the last 30 days' fixes, each with Undo.
   *
   * While a scan runs the page says so and reads the findings again every few seconds until it ends.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import LockedUnlockDialog from '$lib/components/frameleaf/LockedUnlockDialog.svelte';
  import DateDoctorCard from '$lib/components/frameleaf/settings/care/DateDoctorCard.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Pill from '$lib/components/frameleaf/settings/kit/Pill.svelte';
  import Said from '$lib/components/frameleaf/settings/kit/Said.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import { canUndo, dateFixCards, photoCount, UNDO_DAYS } from '$lib/frameleaf/date-doctor';
  import { sessionAccess } from '$lib/frameleaf/session-access.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { handleError } from '$lib/utils/handle-error';
  import {
    applyDateFix,
    getDateFixBatches,
    getDateDoctorFindings,
    isHttpError,
    scanDateDoctor,
    undoDateFix,
    type DateDoctorBatchDto,
    type DateDoctorFindingsResponseDto,
    type DateDoctorFixDto,
  } from '@frameleaf/sdk';
  import { mdiCalendarAlertOutline, mdiCalendarCheckOutline, mdiCalendarClock, mdiCalendarSearch } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { onDestroy } from 'svelte';
  import { t } from 'svelte-i18n';

  /** How often the findings are read again while a scan runs. */
  const POLL_MS = 5000;

  let findings = $state<DateDoctorFindingsResponseDto>();
  let batches = $state<DateDoctorBatchDto[]>([]);
  let batchesFailed = $state(false);
  let status = $state<'loading' | 'ready' | 'error'>('loading');
  /** The last read failed: shown even over findings already on the page, so a lost connection isn't a long scan. */
  let failed = $state(false);
  /** Asked for a scan from this page: the page waits for it even before the server says it started. */
  let asked = $state(false);
  let busy = $state(false);
  let said = $state('');
  /** Cards put off with Not now, until the page is opened again. */
  let later = $state<string[]>([]);
  let poll: ReturnType<typeof setTimeout> | undefined;
  let alive = true;

  /** Each read of the recent fixes is numbered; an older answer never replaces a newer one. */
  let batchReads = 0;
  const readBatches = async () => {
    const read = ++batchReads;
    try {
      const next = await getDateFixBatches();
      if (read === batchReads) {
        batches = next;
        batchesFailed = false;
      }
    } catch {
      // the findings stay usable without the list; the section says so and offers to read it again
      if (read === batchReads) {
        batchesFailed = true;
      }
    }
  };

  let reads = 0;
  const load = async () => {
    const read = ++reads;
    try {
      const next = await getDateDoctorFindings();
      if (read !== reads) {
        return;
      }
      findings = next;
      status = 'ready';
      failed = false;
      if (!next.scanning) {
        asked = false;
      }
    } catch {
      if (read === reads) {
        failed = true;
        status = status === 'loading' ? 'error' : status;
      }
    }
    clearTimeout(poll);
    if (alive && (findings?.scanning || asked)) {
      poll = setTimeout(() => void load(), POLL_MS);
    }
  };

  void load();
  void readBatches();
  onDestroy(() => {
    alive = false;
    clearTimeout(poll);
  });

  const scanning = $derived(!!findings?.scanning || asked);
  const cards = $derived(dateFixCards(findings?.groups ?? []).filter((card) => !later.includes(card.key)));
  /** Photos found, including cards put off with Not now: those dates still look wrong. */
  const found = $derived(photoCount((findings?.groups ?? []).flatMap((group) => group.findings)));

  const checkAgain = async () => {
    try {
      await scanDateDoctor();
      asked = true;
      await load();
    } catch (error) {
      handleError(error, $t('frameleaf_date_doctor_scan_failed'));
    }
  };

  const fix = async (body: DateDoctorFixDto) => {
    busy = true;
    try {
      // the server leaves a photo as it is when it already has that time or its date changed meanwhile (FL-930)
      const { batch, skipped } = await applyDateFix({ dateDoctorFixDto: body });
      said = [
        batch.count > 0 ? $t('frameleaf_date_doctor_fixed', { values: { count: batch.count, days: UNDO_DAYS } }) : '',
        skipped.length > 0 ? $t('frameleaf_date_doctor_skipped', { values: { count: skipped.length } }) : '',
      ]
        .filter(Boolean)
        .join(' ');
      await Promise.all([load(), readBatches()]);
    } catch (error) {
      handleError(error, $t('frameleaf_date_doctor_fix_failed'));
    } finally {
      busy = false;
    }
  };

  /** FL-930: a photo of the fix was Locked since, so Undo needs the PIN first, as any edit of a Locked photo does. */
  let unlocking = $state(false);
  let undoAfterUnlock: DateDoctorBatchDto | undefined;
  const needsUnlock = (error: unknown) =>
    !sessionAccess.isElevated &&
    isHttpError(error) &&
    error.status === 400 &&
    !!error.data?.message?.includes('asset.update');

  const undo = async (batch: DateDoctorBatchDto) => {
    busy = true;
    try {
      const undone = await undoDateFix({ id: batch.id });
      said = $t('frameleaf_date_doctor_undone', { values: { count: undone.restored ?? batch.count } });
      await Promise.all([load(), readBatches()]);
    } catch (error) {
      if (needsUnlock(error)) {
        undoAfterUnlock = batch;
        unlocking = true;
        return;
      }
      handleError(error, $t('frameleaf_date_doctor_undo_failed'));
    } finally {
      busy = false;
    }
  };

  const when = (value: string) =>
    DateTime.fromISO(value)
      .setLocale($locale ?? 'en')
      .toLocaleString(DateTime.DATETIME_MED);

  const hero = $derived.by(() => {
    if (status === 'error' || failed) {
      return {
        tone: 'warn' as const,
        icon: mdiCalendarAlertOutline,
        title: $t('frameleaf_date_doctor_load_failed'),
        body: $t('frameleaf_date_doctor_load_failed_body'),
      };
    }
    if (status === 'loading') {
      return { tone: 'quiet' as const, icon: mdiCalendarSearch, title: $t('frameleaf_date_doctor_loading') };
    }
    if (scanning) {
      return {
        tone: 'quiet' as const,
        icon: mdiCalendarSearch,
        title: $t('frameleaf_date_doctor_scanning'),
        body: $t('frameleaf_date_doctor_scanning_body'),
      };
    }
    if (found > 0) {
      return {
        tone: 'warn' as const,
        icon: mdiCalendarClock,
        title: $t('frameleaf_date_doctor_hero', { values: { count: found } }),
        body: $t('frameleaf_date_doctor_hero_body'),
      };
    }
    return {
      tone: 'good' as const,
      icon: mdiCalendarCheckOutline,
      title: $t('frameleaf_date_doctor_none'),
      body: $t('frameleaf_date_doctor_none_body'),
    };
  });
</script>

<LockedUnlockDialog
  bind:open={unlocking}
  onUnlocked={() => {
    const batch = undoAfterUnlock;
    undoAfterUnlock = undefined;
    if (batch) {
      void undo(batch);
    }
  }}
/>

<KitPage>
  <Said message={said} onDismiss={() => (said = '')} />

  <Hero tone={hero.tone} icon={hero.icon} title={hero.title} body={hero.body} label={$t('frameleaf_date_doctor_title')}>
    {#snippet actions()}
      {#if status === 'error' || failed}
        <Button variant="primary" onclick={() => void load()}>{$t('frameleaf_date_doctor_try_load')}</Button>
      {:else if status === 'ready' && !scanning}
        <Button onclick={() => void checkAgain()}>{$t('frameleaf_date_doctor_check_again')}</Button>
      {/if}
    {/snippet}
  </Hero>

  {#if status === 'ready' && cards.length > 0}
    <Section title={$t('frameleaf_date_doctor_found')}>
      <div class="cards">
        {#each cards as card (card.key)}
          <DateDoctorCard
            {card}
            {busy}
            onFix={(body) => void fix(body)}
            onLater={() => (later = [...later, card.key])}
          />
        {/each}
      </div>
    </Section>
  {/if}

  {#if batchesFailed}
    <Section title={$t('frameleaf_date_doctor_recent')}>
      <p class="explain">{$t('frameleaf_date_doctor_recent_failed')}</p>
      {#snippet action()}
        <Button onclick={() => void readBatches()}>{$t('frameleaf_date_doctor_try_load')}</Button>
      {/snippet}
    </Section>
  {:else if batches.length > 0}
    <Section
      title={$t('frameleaf_date_doctor_recent')}
      description={$t('frameleaf_date_doctor_recent_description', { values: { days: UNDO_DAYS } })}
    >
      <ul class="recent" aria-label={$t('frameleaf_date_doctor_recent')}>
        {#each batches as batch (batch.id)}
          <li>
            <div class="text">
              <strong>{$t('frameleaf_date_doctor_photos', { values: { count: batch.count } })}</strong>
              <span>{$t('frameleaf_date_doctor_recent_when', { values: { when: when(batch.createdAt) } })}</span>
            </div>
            {#if batch.undoneAt}
              <Pill tone="off">{$t('frameleaf_date_doctor_undone_pill')}</Pill>
            {:else if canUndo(batch)}
              <Button
                disabled={busy}
                label={$t('frameleaf_date_doctor_undo_named', { values: { count: batch.count } })}
                onclick={() => void undo(batch)}>{$t('frameleaf_date_doctor_undo')}</Button
              >
            {/if}
          </li>
        {/each}
      </ul>
    </Section>
  {/if}

  <Section title={$t('frameleaf_date_doctor_explain_title')}>
    <p class="explain">{$t('frameleaf_date_doctor_explain', { values: { days: UNDO_DAYS } })}</p>
  </Section>
</KitPage>

<style>
  .cards {
    display: grid;
    gap: var(--fl-space-4);
    margin-bottom: var(--fl-space-2);
  }
  .recent {
    display: grid;
    margin: 0 0 var(--fl-space-2);
    padding: 0;
    list-style: none;
  }
  .recent li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--fl-space-3) var(--fl-space-4);
    padding: var(--fl-space-3) 0;
    border-top: 1px solid var(--fl-border);
  }
  .recent li:first-child {
    border-top: 0;
  }
  .text {
    display: grid;
    gap: var(--fl-space-1);
    min-width: 0;
  }
  .text span {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .explain {
    max-width: 760px;
    margin: 0 0 var(--fl-space-5);
    color: var(--fl-muted);
    line-height: 1.55;
  }
</style>
