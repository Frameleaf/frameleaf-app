<script lang="ts">
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import PersonPicker from '$lib/components/frameleaf/people/PersonPicker.svelte';
  import { isUnnamedPerson } from '$lib/frameleaf/people';
  import { getServerErrorMessage, handleError } from '$lib/utils/handle-error';
  import {
    createPersonRelationship,
    type PersonRelationshipCreateDto,
    type PersonRelationshipsResponseDto,
    type PersonResponseDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiAlertCircleOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  /**
   * "Add relationship" (FL-842), as `AddRelationshipDialog` in the prototype's FamilyArchive.jsx: choose a person,
   * say what they are to this person. A refusal is the server's own sentence, shown here with nothing changed.
   */
  interface Props {
    person: PersonResponseDto;
    onAdded: (family: PersonRelationshipsResponseDto, message: string) => void;
    onClosed: () => void;
  }

  let { person, onAdded, onClosed }: Props = $props();

  const RELATIONS = ['mother', 'father', 'parent', 'child', 'partner', 'sibling'] as const;
  type Relation = (typeof RELATIONS)[number];

  let open = $state(true);
  let chosen = $state<{ id: string; name: string }>();
  let relation = $state<Relation>('mother');
  let refusal = $state('');
  let busy = $state(false);

  const labelOf = (value: Relation) => $t(`frameleaf_people_family_relation_${value}`);

  const add = async () => {
    if (!chosen) {
      return;
    }
    busy = true;
    refusal = '';
    try {
      const family = await createPersonRelationship({
        id: person.id,
        personRelationshipCreateDto: {
          relatedPersonId: chosen.id,
          relation: relation as PersonRelationshipCreateDto['relation'],
        },
      });
      onAdded(
        family,
        $t('frameleaf_people_family_added', {
          values: {
            name: chosen.name,
            person: person.name,
            relation: $t(`frameleaf_people_family_relation_inline_${relation}`),
          },
        }),
      );
      open = false;
    } catch (error) {
      if ((error as { status?: number }).status === 400) {
        refusal = getServerErrorMessage(error) ?? $t('frameleaf_people_family_add_failed');
      } else {
        handleError(error, $t('frameleaf_people_family_add_failed'));
      }
    } finally {
      busy = false;
    }
  };
</script>

<Dialog title={$t('frameleaf_people_family_add')} closeLabel={$t('close')} bind:open {onClosed}>
  <div class="relate">
    <div class="field">
      <span class="field-label">{$t('frameleaf_people_family_person')}</span>
      <PersonPicker
        excludeId={person.id}
        label={$t('frameleaf_people_family_person')}
        selectedId={chosen?.id ?? ''}
        namedOnly
        onPick={(picked) => {
          chosen = picked;
          refusal = '';
        }}
      />
    </div>
    <fieldset class="field">
      <legend class="field-label">
        {chosen && !isUnnamedPerson(chosen)
          ? $t('frameleaf_people_family_relation_prompt', { values: { name: chosen.name, person: person.name } })
          : $t('frameleaf_people_family_relation_prompt_none', { values: { person: person.name } })}
      </legend>
      <div class="choices">
        {#each RELATIONS as value (value)}
          <label class="choice" class:on={relation === value}>
            <input type="radio" name="family-relation" {value} bind:group={relation} onchange={() => (refusal = '')} />
            {labelOf(value)}
          </label>
        {/each}
      </div>
    </fieldset>
    {#if refusal}
      <p class="alert" role="alert">
        <Icon icon={mdiAlertCircleOutline} size="18" aria-hidden="true" />
        <span><strong>{$t('frameleaf_people_family_refused')}</strong>{refusal}</span>
      </p>
    {:else}
      <p class="hint">{$t('frameleaf_people_family_hint')}</p>
    {/if}
  </div>
  {#snippet actions()}
    <Button onclick={() => (open = false)}>{$t('cancel')}</Button>
    <Button variant="primary" disabled={!chosen || busy} onclick={add}>{$t('frameleaf_people_family_add')}</Button>
  {/snippet}
</Dialog>

<style>
  /* The prototype's family-archive.css `.fa-relate` and friends. */
  .relate {
    display: flex;
    flex-direction: column;
    gap: 20px;
  }
  .field {
    display: flex;
    flex-direction: column;
    min-width: 0;
    margin: 0;
    padding: 0;
    border: 0;
  }
  .field-label {
    margin: 0 0 8px;
    padding: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .choices {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
  }
  .choice {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 36px;
    padding: 0 12px;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    cursor: pointer;
  }
  .choice.on {
    color: var(--fl-accent);
    font-weight: 600;
    background: var(--fl-accent-soft);
    border-color: var(--fl-accent);
  }
  .choice input {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
    pointer-events: none;
  }
  .choice:has(input:focus-visible) {
    outline: 2px solid var(--fl-accent);
    outline-offset: 2px;
  }
  .hint {
    margin: 0;
    color: var(--fl-muted);
    line-height: 1.5;
  }
  .alert {
    display: flex;
    gap: 12px;
    margin: 0;
    padding: 12px 16px;
    line-height: 1.5;
    background: color-mix(in srgb, var(--fl-danger) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--fl-danger) 45%, var(--fl-border));
    border-radius: var(--fl-radius-card);
  }
  .alert :global(svg) {
    flex-shrink: 0;
    margin-top: 2px;
    color: var(--fl-danger);
  }
  .alert strong {
    display: block;
    font-weight: 600;
  }
</style>
