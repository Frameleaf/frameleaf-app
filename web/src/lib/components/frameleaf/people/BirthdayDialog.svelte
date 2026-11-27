<script lang="ts">
  import Button from '$lib/components/frameleaf/Button.svelte';
  import DateField from '$lib/components/frameleaf/DateField.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import IconButton from '$lib/components/frameleaf/IconButton.svelte';
  import { isDateFieldValid, lifeDateField, lifeDateUpdate } from '$lib/frameleaf/date-field';
  import { ageInYears, datesProblem, isUnnamedPerson, lifespan } from '$lib/frameleaf/people';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import {
    updatePerson,
    type BirthDatePrecision,
    type DeathDatePrecision,
    type PersonResponseDto,
    type PersonUpdateDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiClose, mdiDeleteOutline, mdiPlus } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { tick } from 'svelte';
  import { t } from 'svelte-i18n';

  /**
   * "Dates" (FL-37 PD-5, FL-864), after `BirthdayDialog` in the prototype's `People.jsx`: the date of birth and an
   * optional date of passing, each in the one date field (FL-1814), which asks how sure you are first, so "around
   * 1950" is as easy to enter as a full date. With a date of passing the person's page shows a lifespan instead of
   * an age. Saving sends only what changed through `updatePerson` and announces it with `PersonUpdate`.
   */
  interface Props {
    person: PersonResponseDto;
    open?: boolean;
    onSaved?: (person: PersonResponseDto, hasDates: boolean) => void;
  }

  let { person, open = $bindable(false), onSaved }: Props = $props();

  let born = $state(lifeDateField(null, null));
  let passed = $state(lifeDateField(null, null));
  let showBorn = $state(false);
  let showPassed = $state(false);
  let busy = $state(false);
  const today = DateTime.now().toISODate();
  const thisYear = DateTime.now().year;
  const name = $derived(isUnnamedPerson(person) ? $t('unnamed_person') : person.name);

  const birth = $derived(showBorn ? lifeDateUpdate(born) : { date: null, precision: null });
  const passing = $derived(showPassed ? lifeDateUpdate(passed) : { date: null, precision: null });
  const exact = (value: { date: string | null; precision: string | null }) =>
    value.date && !value.precision ? value.date : '';
  // a half-typed day or year is never saved (it would read as no date, or the wrong one)
  const incomplete = $derived(
    (showBorn && !isDateFieldValid(born, 1, thisYear)) || (showPassed && !isDateFieldValid(passed, 1, thisYear)),
  );
  const problem = $derived(incomplete ? null : datesProblem(birth.date ?? '', passing.date ?? '', today));
  // a lifespan reads years only, so any precision gives one; an age needs the exact birthday
  const span = $derived(problem ? null : lifespan(birth.date, passing.date));
  const age = $derived(!problem && exact(birth) && !span ? ageInYears(exact(birth)) : null);
  const fieldId = $props.id();

  /** Adding a date puts the cursor on its first question; removing one puts it back on the add button. */
  const show = async (which: 'born' | 'passed', on: boolean) => {
    if (which === 'born') {
      showBorn = on;
    } else {
      showPassed = on;
    }
    await tick();
    document
      .querySelector<HTMLElement>(`#${CSS.escape(on ? `${fieldId}-${which}` : `${fieldId}-add-${which}`)}`)
      ?.focus();
  };
  const unchanged = $derived(
    birth.date === (person.birthDate || null) &&
      birth.precision === (person.birthDatePrecision ?? null) &&
      passing.date === (person.deathDate || null) &&
      passing.precision === (person.deathDatePrecision ?? null),
  );

  $effect(() => {
    if (open) {
      born = lifeDateField(person.birthDate, person.birthDatePrecision);
      passed = lifeDateField(person.deathDate, person.deathDatePrecision);
      showBorn = !!person.birthDate;
      showPassed = !!person.deathDate;
    }
  });

  const save = async (clear = false) => {
    const nextBirth = clear ? { date: null, precision: null } : birth;
    const nextPassing = clear ? { date: null, precision: null } : passing;
    const personUpdateDto: PersonUpdateDto = {};
    if (nextBirth.date !== (person.birthDate || null) || nextBirth.precision !== (person.birthDatePrecision ?? null)) {
      personUpdateDto.birthDate = nextBirth.date;
      personUpdateDto.birthDatePrecision = (nextBirth.date ? nextBirth.precision : null) as BirthDatePrecision | null;
    }
    if (
      nextPassing.date !== (person.deathDate || null) ||
      nextPassing.precision !== (person.deathDatePrecision ?? null)
    ) {
      personUpdateDto.deathDate = nextPassing.date;
      personUpdateDto.deathDatePrecision = (
        nextPassing.date ? nextPassing.precision : null
      ) as DeathDatePrecision | null;
    }
    busy = true;
    try {
      const updated = await updatePerson({ id: person.id, personUpdateDto });
      eventManager.emit('PersonUpdate', updated);
      open = false;
      onSaved?.(updated, !!(nextBirth.date || nextPassing.date));
    } catch (error) {
      handleError(error, $t('frameleaf_people_dates_save_failed'));
    } finally {
      busy = false;
    }
  };
</script>

<Dialog title={$t('frameleaf_people_dates')} closeLabel={$t('close')} bind:open>
  <div class="dates">
    {#if showBorn}
      <div class="row">
        <DateField
          label={$t('frameleaf_people_birthday_label', { values: { name } })}
          id="{fieldId}-born"
          focusOnOpen
          value={born}
          minYear={1}
          maxYear={thisYear}
          onChange={(value) => (born = value)}
        />
        <IconButton label={$t('frameleaf_people_birthday_remove')} onclick={() => show('born', false)}>
          <Icon icon={mdiClose} size="18" aria-hidden="true" />
        </IconButton>
      </div>
    {:else}
      <button type="button" class="add" id="{fieldId}-add-born" data-initial-focus onclick={() => show('born', true)}>
        <Icon icon={mdiPlus} size="16" aria-hidden="true" />
        {$t('frameleaf_people_birthday_label', { values: { name } })}
      </button>
    {/if}
    {#if showPassed}
      <div class="row">
        <DateField
          label={$t('frameleaf_people_passing_label')}
          id="{fieldId}-passed"
          value={passed}
          minYear={1}
          maxYear={thisYear}
          onChange={(value) => (passed = value)}
        />
        <IconButton label={$t('frameleaf_people_passing_remove')} onclick={() => show('passed', false)}>
          <Icon icon={mdiClose} size="18" aria-hidden="true" />
        </IconButton>
      </div>
    {:else}
      <button type="button" class="add" id="{fieldId}-add-passed" onclick={() => show('passed', true)}>
        <Icon icon={mdiPlus} size="16" aria-hidden="true" />
        {$t('frameleaf_people_passing_add')}
      </button>
    {/if}
  </div>
  <p class="hint" aria-live="polite">
    {#if problem}
      {$t(problem)}
    {:else if span}
      {$t('frameleaf_people_passing_hint', { values: { name, years: span.years } })}
    {:else if age !== null}
      {$t('frameleaf_people_birthday_age', { values: { name, age } })}
    {:else}
      {$t('frameleaf_people_birthday_hint')}
    {/if}
  </p>
  {#snippet actions()}
    <Button onclick={() => (open = false)}>{$t('cancel')}</Button>
    {#if person.birthDate || person.deathDate}
      <Button disabled={busy} onclick={() => save(true)}>
        <Icon icon={mdiDeleteOutline} size="18" aria-hidden="true" />
        {$t('frameleaf_people_dates_remove')}
      </Button>
    {/if}
    <Button variant="primary" disabled={incomplete || !!problem || unchanged || busy} onclick={() => save()}>
      {$t('save')}
    </Button>
  {/snippet}
</Dialog>

<style>
  /* The prototype's `.pp-dates`, `.pp-date-row`, `.pp-add-date`, `.pp-field`, `.pp-dialog-hint`. */
  .dates {
    display: grid;
    gap: var(--fl-space-6);
  }
  .row {
    display: flex;
    align-items: flex-start;
    gap: var(--fl-space-2);
  }
  .row > :global(.date-field) {
    flex: 1;
  }
  .add {
    display: inline-flex;
    align-items: center;
    justify-self: start;
    gap: var(--fl-space-2);
    min-height: 44px;
    padding: 0;
    border: 0;
    background: none;
    color: var(--fl-accent);
    font: inherit;
    cursor: pointer;
  }
  .hint {
    margin: var(--fl-space-4) 0 0;
    color: var(--fl-muted);
    line-height: 1.5;
  }
</style>
