<script lang="ts">
  import Button from '$lib/components/frameleaf/Button.svelte';
  import PersonAvatar from '$lib/components/frameleaf/PersonAvatar.svelte';
  import AddRelationshipDialog from '$lib/components/frameleaf/people/AddRelationshipDialog.svelte';
  import { isUnnamedPerson } from '$lib/frameleaf/people';
  import { Route } from '$lib/route';
  import { handleError } from '$lib/utils/handle-error';
  import {
    deletePersonRelationship,
    getPersonRelationships,
    type PersonRelationshipsResponseDto,
    type PersonRelativeDto,
    type PersonResponseDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiClose, mdiFamilyTree, mdiPlus } from '@mdi/js';
  import { t } from 'svelte-i18n';

  /**
   * The Family section of the person page (FL-842), as `FamilySection` in the prototype's FamilyArchive.jsx, without
   * its Family tree button (that page is a later story). The page's person read carries the family; a person
   * replaced by an edit does not, so it is then asked for.
   */
  interface Props {
    person: PersonResponseDto;
  }

  type Relation = 'mother' | 'father' | 'parent' | 'child' | 'partner' | 'sibling';
  type Relative = { person: PersonRelativeDto; relation: Relation; removable: boolean };

  let { person }: Props = $props();

  let fetched = $state<{ id: string; family: PersonRelationshipsResponseDto }>();
  let adding = $state(false);
  let status = $state('');
  let request = 0;

  const family = $derived(fetched?.id === person.id ? fetched.family : person.relationships);
  const name = $derived(person.name);

  const parentRelation = (role: string): Relation => (role === 'mother' || role === 'father' ? role : 'parent');
  // the form that reads correctly inside a sentence; a label's capitals can't simply be lowered (German "Mutter")
  const sentenceValues = (relative: Relative) => ({
    name: relative.person.name,
    person: name,
    relation: $t(`frameleaf_people_family_relation_inline_${relative.relation}`),
  });

  const groups = $derived.by(() => {
    if (!family) {
      return [];
    }
    const inferred = new Set(family.inferredSiblingIds);
    const partnerTitle = family.partners.length === 1 ? 'partner' : 'partners';
    const all: Array<{ id: string; title: string; relatives: Relative[] }> = [
      {
        id: 'parents',
        title: $t('frameleaf_people_family_group_parents'),
        relatives: family.parents.map(({ person, parentRole }) => ({
          person,
          relation: parentRelation(parentRole),
          removable: true,
        })),
      },
      {
        id: 'partners',
        title: $t(`frameleaf_people_family_group_${partnerTitle}`),
        relatives: family.partners.map((person) => ({
          person,
          relation: 'partner',
          removable: true,
        })),
      },
      {
        id: 'children',
        title: $t('frameleaf_people_family_group_children'),
        relatives: family.children.map(({ person }) => ({
          person,
          relation: 'child',
          removable: true,
        })),
      },
      {
        id: 'siblings',
        title: $t('frameleaf_people_family_group_siblings'),
        // someone who only shares a parent has no relationship of their own to remove
        relatives: family.siblings.map((person) => ({
          person,
          relation: 'sibling',
          removable: !inferred.has(person.id),
        })),
      },
    ];
    return all.filter((group) => group.relatives.length > 0);
  });
  const total = $derived(groups.reduce((sum, group) => sum + group.relatives.length, 0));

  const load = async (id: string) => {
    const current = ++request;
    try {
      const loaded = await getPersonRelationships({ id });
      if (current === request) {
        fetched = { id, family: loaded };
      }
    } catch (error) {
      handleError(error, $t('frameleaf_people_family_load_failed'));
    }
  };

  $effect(() => {
    if (!family && !isUnnamedPerson(person)) {
      void load(person.id);
    }
  });

  const remove = async (relative: Relative) => {
    const values = sentenceValues(relative);
    try {
      await deletePersonRelationship({ id: person.id, relatedPersonId: relative.person.id });
      // read it back: removing a parent can also change who counts as a sibling
      await load(person.id);
      status = $t('frameleaf_people_family_removed', { values });
    } catch (error) {
      handleError(error, $t('frameleaf_people_family_remove_failed'));
    }
  };
</script>

{#if !isUnnamedPerson(person)}
  <section class="family" aria-label={$t('frameleaf_people_family_label', { values: { person: name } })}>
    <header class="head">
      <div>
        <h2>{$t('frameleaf_people_family')}</h2>
        {#if total > 0}
          <p>{$t('frameleaf_people_family_count', { values: { count: total } })}</p>
        {/if}
      </div>
      {#if total > 0}
        <Button onclick={() => (adding = true)}>
          <Icon icon={mdiPlus} size="18" aria-hidden="true" />
          {$t('frameleaf_people_family_add')}
        </Button>
      {/if}
    </header>
    {#if family && total === 0}
      <div class="empty">
        <span class="empty-icon" aria-hidden="true"><Icon icon={mdiFamilyTree} size="24" /></span>
        <div>
          <strong>{$t('frameleaf_people_family_empty_title')}</strong>
          <p>{$t('frameleaf_people_family_empty_body', { values: { person: name } })}</p>
        </div>
        <Button variant="primary" onclick={() => (adding = true)}>
          <Icon icon={mdiPlus} size="18" aria-hidden="true" />
          {$t('frameleaf_people_family_add')}
        </Button>
      </div>
    {:else if total > 0}
      <div class="groups">
        {#each groups as group (group.id)}
          <div class="group">
            <h3>{group.title}</h3>
            <ul>
              {#each group.relatives as relative (relative.person.id)}
                {@const values = sentenceValues(relative)}
                <li class="chip">
                  <a
                    class="chip-main"
                    href={Route.viewPerson(relative.person)}
                    aria-label={$t('frameleaf_people_family_open', { values })}
                  >
                    <PersonAvatar person={relative.person as PersonResponseDto} size={44} />
                    <span>
                      <strong>{relative.person.name}</strong>
                      <small>{$t(`frameleaf_people_family_relation_${relative.relation}`)}</small>
                    </span>
                  </a>
                  {#if relative.removable}
                    <button
                      type="button"
                      class="chip-remove"
                      aria-label={$t('frameleaf_people_family_remove', { values })}
                      title={$t('frameleaf_people_family_remove_title')}
                      onclick={() => remove(relative)}
                    >
                      <Icon icon={mdiClose} size="16" aria-hidden="true" />
                    </button>
                  {/if}
                </li>
              {/each}
            </ul>
          </div>
        {/each}
      </div>
    {/if}
    <p class="status" role="status" aria-live="polite">{status}</p>
    {#if adding}
      <AddRelationshipDialog
        {person}
        onAdded={(next, message) => {
          request++;
          fetched = { id: person.id, family: next };
          status = message;
        }}
        onClosed={() => (adding = false)}
      />
    {/if}
  </section>
{/if}

<style>
  /* The prototype's family-archive.css `.fa-family`; the side gutter is the person header's. */
  .family {
    padding: 24px calc(var(--fl-space-2) + var(--fl-page-inline)) 28px;
    background: var(--fl-canvas);
    border-bottom: 1px solid var(--fl-border);
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    min-height: 34px;
    margin-bottom: 20px;
  }
  .head h2 {
    margin: 0;
    font-size: 18px;
    font-weight: var(--fl-weight-semibold);
  }
  .head p {
    margin: 4px 0 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .groups {
    display: flex;
    flex-wrap: wrap;
    gap: 24px 40px;
  }
  .group h3 {
    margin: 0 0 12px;
    color: var(--fl-muted);
    font-size: 11px;
    font-weight: var(--fl-weight-semibold);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .group ul {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .chip {
    display: flex;
    align-items: center;
    min-height: 60px;
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  .chip:hover,
  .chip:focus-within {
    border-color: var(--fl-border-strong);
  }
  .chip-main {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 148px;
    padding: 8px;
    color: var(--fl-text);
    text-decoration: none;
    border-radius: var(--fl-radius-card);
  }
  .chip-main > span {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .chip-main strong {
    font-weight: var(--fl-weight-semibold);
  }
  .chip-main small {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .chip-remove {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    margin-right: 8px;
    color: var(--fl-muted);
    background: none;
    border: 0;
    border-radius: 50%;
    cursor: pointer;
  }
  .chip-remove:hover,
  .chip-remove:focus-visible {
    color: var(--fl-text);
    background: var(--fl-hover);
  }
  .empty {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 20px 24px;
    border: 1px dashed var(--fl-border-strong);
    border-radius: var(--fl-radius-card);
  }
  .empty > div {
    flex: 1;
    min-width: 0;
  }
  .empty strong {
    font-weight: var(--fl-weight-semibold);
  }
  .empty p {
    margin: 4px 0 0;
    color: var(--fl-muted);
    line-height: 1.5;
  }
  .empty-icon {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    width: 48px;
    height: 48px;
    color: var(--fl-muted);
    background: var(--fl-raised);
    border-radius: 50%;
  }
  .status {
    margin: 16px 0 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .status:empty {
    display: none;
  }
  @media (max-width: 640px) {
    .family {
      padding: 20px 16px 24px;
    }
    .head {
      flex-wrap: wrap;
    }
    .groups {
      flex-direction: column;
      gap: 20px;
    }
    .group ul {
      flex-direction: column;
    }
    .chip-main {
      flex: 1;
    }
    .empty {
      flex-direction: column;
      align-items: flex-start;
    }
  }
</style>
