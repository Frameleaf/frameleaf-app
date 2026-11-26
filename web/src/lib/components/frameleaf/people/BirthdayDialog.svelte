<script lang="ts">
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import IconButton from '$lib/components/frameleaf/IconButton.svelte';
  import { ageInYears, datesProblem, isUnnamedPerson, lifespan } from '$lib/frameleaf/people';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import { updatePerson, type PersonResponseDto, type PersonUpdateDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiClose, mdiDeleteOutline, mdiPlus } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { t } from 'svelte-i18n';

  /**
   * "Dates" (FL-37 PD-5, FL-864), after `BirthdayDialog` in the prototype's `People.jsx`: the date of
   * birth and an optional date of passing, each a native date field capped at today. With a date of
   * passing the person's page shows a lifespan instead of an age. Saving sends only the dates that
   * changed through `updatePerson` and announces the change with the existing `PersonUpdate` event;
   * `onSaved` hears whether any date is left.
   */
  interface Props {
    person: PersonResponseDto;
    open?: boolean;
    onSaved?: (person: PersonResponseDto, hasDates: boolean) => void;
  }

  let { person, open = $bindable(false), onSaved }: Props = $props();

  let value = $state('');
  let passed = $state('');
  let showPassed = $state(false);
  let busy = $state(false);
  // A half-typed date reads as empty; saving it would clear the stored date, so Save waits.
  let fields: HTMLElement | undefined = $state();
  let incomplete = $state(false);
  const checkInputs = () => {
    incomplete = [...(fields?.querySelectorAll('input') ?? [])].some((input) => input.validity.badInput);
  };
  const today = DateTime.now().toISODate();
  const name = $derived(isUnnamedPerson(person) ? $t('unnamed_person') : person.name);
  const passing = $derived(showPassed ? passed : '');
  const problem = $derived(datesProblem(value, passing, today));
  const span = $derived(problem ? null : lifespan(value, passing));
  const age = $derived(!problem && value && !span ? ageInYears(value) : null);
  const unchanged = $derived(
    (value || null) === (person.birthDate || null) && (passing || null) === (person.deathDate || null),
  );

  $effect(() => {
    if (open) {
      value = person.birthDate ?? '';
      passed = person.deathDate ?? '';
      showPassed = !!person.deathDate;
      incomplete = false;
    }
  });

  const save = async (birthDate: string | null, deathDate: string | null) => {
    const personUpdateDto: PersonUpdateDto = {};
    if (birthDate !== (person.birthDate || null)) {
      personUpdateDto.birthDate = birthDate;
    }
    if (deathDate !== (person.deathDate || null)) {
      personUpdateDto.deathDate = deathDate;
    }
    busy = true;
    try {
      const updated = await updatePerson({ id: person.id, personUpdateDto });
      eventManager.emit('PersonUpdate', updated);
      open = false;
      onSaved?.(updated, !!(birthDate || deathDate));
    } catch (error) {
      handleError(error, $t('frameleaf_people_dates_save_failed'));
    } finally {
      busy = false;
    }
  };
</script>

<Dialog title={$t('frameleaf_people_dates')} closeLabel={$t('close')} bind:open>
  <div class="dates" bind:this={fields} oninput={checkInputs}>
    <label class="field">
      <span>{$t('frameleaf_people_birthday_label', { values: { name } })}</span>
      <input type="date" max={today} bind:value data-initial-focus />
    </label>
    {#if showPassed}
      <div class="row">
        <label class="field">
          <span>{$t('frameleaf_people_passing_label')}</span>
          <input type="date" min={value || undefined} max={today} bind:value={passed} />
        </label>
        <IconButton
          label={$t('frameleaf_people_passing_remove')}
          onclick={() => {
            showPassed = false;
            incomplete = false;
          }}
        >
          <Icon icon={mdiClose} size="18" aria-hidden="true" />
        </IconButton>
      </div>
    {:else}
      <button type="button" class="add" onclick={() => (showPassed = true)}>
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
    {:else if value && age !== null}
      {$t('frameleaf_people_birthday_age', { values: { name, age } })}
    {:else}
      {$t('frameleaf_people_birthday_hint')}
    {/if}
  </p>
  {#snippet actions()}
    <Button onclick={() => (open = false)}>{$t('cancel')}</Button>
    {#if person.birthDate || person.deathDate}
      <Button disabled={busy} onclick={() => save(null, null)}>
        <Icon icon={mdiDeleteOutline} size="18" aria-hidden="true" />
        {$t('frameleaf_people_dates_remove')}
      </Button>
    {/if}
    <Button
      variant="primary"
      disabled={!!problem || incomplete || unchanged || busy}
      onclick={() => save(value || null, passing || null)}
    >
      {$t('save')}
    </Button>
  {/snippet}
</Dialog>

<style>
  /* The prototype's `.pp-dates`, `.pp-date-row`, `.pp-add-date`, `.pp-field`, `.pp-dialog-hint`. */
  .dates {
    display: grid;
    gap: 16px;
  }
  .row {
    display: flex;
    align-items: flex-end;
    gap: 8px;
  }
  .row .field {
    flex: 1;
  }
  .add {
    display: inline-flex;
    align-items: center;
    justify-self: start;
    gap: 8px;
    min-height: 40px;
    padding: 0;
    border: 0;
    background: none;
    color: var(--fl-accent);
    font: inherit;
    cursor: pointer;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .field span {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .field input {
    min-height: var(--fl-control-height);
    font-size: var(--fl-font-size);
  }
  .hint {
    margin: 16px 0 0;
    color: var(--fl-muted);
    line-height: 1.5;
  }
</style>
