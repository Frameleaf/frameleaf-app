<script lang="ts">
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { ageInYears, isUnnamedPerson } from '$lib/frameleaf/people';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import { updatePerson, type PersonResponseDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiDeleteOutline } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { t } from 'svelte-i18n';

  /**
   * "Date of birth" (FL-37, PD-5), ported from `BirthdayDialog` in
   * design/frameleaf/template/src/People.jsx:538-585. It replaces the legacy
   * `PersonEditBirthDateModal`: a native date field capped at today, a live age hint, and
   * Remove when a date is already set. Saving writes `birthDate` through `updatePerson` and
   * announces the change with the existing `PersonUpdate` event.
   */
  interface Props {
    person: PersonResponseDto;
    open?: boolean;
    onSaved?: (person: PersonResponseDto, birthDate: string | null) => void;
  }

  let { person, open = $bindable(false), onSaved }: Props = $props();

  let value = $state('');
  let busy = $state(false);
  const today = DateTime.now().toISODate();
  const name = $derived(isUnnamedPerson(person) ? $t('unnamed_person') : person.name);
  const valid = $derived(value === '' || (/^\d{4}-\d{2}-\d{2}$/.test(value) && value <= today));
  const age = $derived(valid && value ? ageInYears(value) : null);
  const unchanged = $derived((value || null) === (person.birthDate || null));

  $effect(() => {
    if (open) {
      value = person.birthDate ?? '';
    }
  });

  const save = async (birthDate: string | null) => {
    busy = true;
    try {
      const updated = await updatePerson({ id: person.id, personUpdateDto: { birthDate } });
      eventManager.emit('PersonUpdate', updated);
      open = false;
      onSaved?.(updated, birthDate);
    } catch (error) {
      handleError(error, $t('errors.unable_to_save_date_of_birth'));
    } finally {
      busy = false;
    }
  };
</script>

<Dialog title={$t('date_of_birth')} closeLabel={$t('close')} bind:open>
  <label class="field">
    <span>{$t('frameleaf_people_birthday_label', { values: { name } })}</span>
    <input type="date" max={today} bind:value data-initial-focus />
  </label>
  <p class="hint" aria-live="polite">
    {#if !valid}
      {$t('frameleaf_people_birthday_future')}
    {:else if value && age !== null}
      {$t('frameleaf_people_birthday_age', { values: { name, age } })}
    {:else}
      {$t('frameleaf_people_birthday_hint')}
    {/if}
  </p>
  {#snippet actions()}
    <Button onclick={() => (open = false)}>{$t('cancel')}</Button>
    {#if person.birthDate}
      <Button disabled={busy} onclick={() => save(null)}>
        <Icon icon={mdiDeleteOutline} size="18" aria-hidden="true" />
        {$t('remove')}
      </Button>
    {/if}
    <Button variant="primary" disabled={!valid || unchanged || busy} onclick={() => save(value || null)}>
      {$t('save')}
    </Button>
  {/snippet}
</Dialog>

<style>
  /* template/src/people.css `.pp-field`, `.pp-dialog-hint`. */
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
    min-height: 44px;
    font-size: var(--fl-font-size);
  }
  .hint {
    margin: 16px 0 0;
    color: var(--fl-muted);
    line-height: 1.5;
  }
</style>
