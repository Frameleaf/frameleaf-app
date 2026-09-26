<script lang="ts">
  /**
   * Locked tags and people (FL-67), ported from the design template's `ProtectedContent.jsx`.
   *
   * While the session is not unlocked nothing about the rules is shown: the server blanks the
   * rule ids for such a session and refuses to change them. Once unlocked, the rules load with the
   * preferences revision they belong to and are edited as one draft:
   *
   * - People, pets and tags that no longer resolve stay in the rules, marked unavailable, until the
   *   owner removes them; saving another change never unlocks them silently.
   * - A tag inside a Locked tag shows that it is Locked through it.
   * - Save checks that the session is still unlocked, then sends the whole rules with the loaded
   *   revision. If only unrelated preferences changed meanwhile it saves against the new revision;
   *   if the rules themselves changed in another tab or device the draft stays and the owner
   *   decides to reload. A session locked during the save drops the draft and asks to unlock again.
   * - Coming back to the page checks whether the rules changed elsewhere.
   * - Every read checks `lockedRulesRevealed`: rules the server blanked (the session locked between
   *   the status check and the read) are never shown or edited, so they can never be saved back.
   * - As in the template, People lists the account's people (filtered by "Find a person"; a name
   *   beyond the loaded list is found by a search), and Save is disabled only by a conflict.
   * - Pets are a production extension of the template (`privacy.suppression.petIds`, FL-58).
   *
   * The Locked ids are never written into the session-wide preferences store.
   */
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import {
    canCreateTag,
    decideAfterConflict,
    emptyLockedRules,
    lockedRulesFrom,
    lockedRulesUpdate,
    tagRuleEntries,
    toggleLockedRule,
    withoutLockedRuleIds,
    type LockedRuleField,
    type LockedRules,
  } from '$lib/frameleaf/locked-rules';
  import { isUnnamedPet, sortPets } from '$lib/frameleaf/pets';
  import { requestSessionLock } from '$lib/frameleaf/session-lock';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Route } from '$lib/route';
  import { getPeopleThumbnailUrl } from '$lib/utils';
  import {
    getAllPeople,
    getAllPets,
    getAllTags,
    getAuthStatus,
    getMyPreferences,
    getPerson,
    isHttpError,
    searchPerson,
    SuppressionScope,
    updateMyPreferences,
    upsertTags,
    type PersonResponseDto,
    type PetResponseDto,
    type TagResponseDto,
    type UserPreferencesResponseDto,
  } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiLockOutline } from '@mdi/js';
  import { onDestroy, onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  type Phase = 'loading' | 'unavailable' | 'no-pin' | 'locked' | 'ready';

  const RULES_SECTION = 'suppressed-content';
  const PIN_SECTION = 'user-pin-code-settings';

  /** How many of the account's people the list loads before a search is needed (UT-26). */
  const PEOPLE_PAGE_SIZE = 500;

  let phase = $state<Phase>('loading');
  let baseline = $state<LockedRules>(emptyLockedRules());
  let draft = $state<LockedRules>(emptyLockedRules());
  let revision = $state('');
  let conflict = $state(false);
  let saving = $state(false);
  let notice = $state('');
  let error = $state('');

  let tags = $state<TagResponseDto[]>([]);
  let pets = $state<PetResponseDto[]>([]);
  /** Resolved people by id; `null` marks an id that no longer resolves. */
  let people = $state<Record<string, PersonResponseDto | null>>({});

  let tagQuery = $state('');
  let personQuery = $state('');
  let personResults = $state<PersonResponseDto[]>([]);
  /** The account's people, listed before any search as the template does (UT-26). */
  let allPeople = $state<PersonResponseDto[]>([]);
  let searchingPeople = $state(false);
  let creatingTag = $state(false);
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let searchController: AbortController | undefined;

  const tagEntries = $derived(tagRuleEntries(tags, draft.tagIds, tagQuery));
  const showCreateTag = $derived(canCreateTag(tags, tagQuery));
  const petIds = $derived(new Set(pets.map((pet) => pet.id)));
  const missingPetIds = $derived(draft.petIds.filter((id) => !petIds.has(id)));
  const sortedPets = $derived(sortPets(pets));

  const isStatus = (error: unknown, status: number) => isHttpError(error) && error.status === status;

  /** Forget everything the unlocked session revealed. */
  const drop = () => {
    baseline = emptyLockedRules();
    draft = emptyLockedRules();
    revision = '';
    conflict = false;
    tags = [];
    pets = [];
    people = {};
    tagQuery = '';
    personQuery = '';
    personResults = [];
    allPeople = [];
    error = '';
  };

  const relock = (message = '') => {
    drop();
    phase = 'locked';
    notice = message;
  };

  const resolvePeople = async (ids: string[]) => {
    const results = await Promise.allSettled(ids.map((id) => getPerson({ id })));
    const resolved: Record<string, PersonResponseDto | null> = {};
    for (const [index, id] of ids.entries()) {
      const result = results[index];
      resolved[id] = result.status === 'fulfilled' ? result.value : null;
    }
    people = resolved;
  };

  const applyLoaded = async (preferences: UserPreferencesResponseDto) => {
    baseline = lockedRulesFrom(preferences);
    draft = lockedRulesFrom(preferences);
    revision = preferences.revision;
    conflict = false;
    await resolvePeople(baseline.personIds);
  };

  /** Load the rules; only while the session is unlocked before and after the read. */
  const load = async () => {
    error = '';
    try {
      const before = await getAuthStatus();
      if (!before.pinCode) {
        drop();
        phase = 'no-pin';
        return;
      }
      if (!before.isElevated) {
        relock(notice);
        return;
      }

      const [preferences, allTags, allPets, peoplePage] = await Promise.all([
        getMyPreferences(),
        getAllTags(),
        getAllPets({ withHidden: true }),
        getAllPeople({ withHidden: true, size: PEOPLE_PAGE_SIZE }),
      ]);
      const after = await getAuthStatus();
      // The read itself says whether it named the rules: a session that locked and unlocked again
      // between the two status checks still gets blanked rules here, never an editable empty draft.
      if (!after.isElevated || !preferences.lockedRulesRevealed) {
        relock($t('frameleaf_locked_rules_unlock_again'));
        return;
      }

      tags = allTags;
      pets = allPets;
      allPeople = peoplePage.people;
      await applyLoaded(preferences);
      tagQuery = '';
      personQuery = '';
      personResults = [];
      notice = '';
      phase = 'ready';
    } catch {
      // Never leave an editable draft on screen that was not loaded: saving it would replace the
      // stored rules with whatever it holds.
      drop();
      phase = 'unavailable';
      error = $t('frameleaf_locked_rules_load_failed');
    }
  };

  const save = async () => {
    if (phase !== 'ready' || saving || conflict) {
      return;
    }

    saving = true;
    error = '';
    notice = '';
    try {
      const status = await getAuthStatus();
      if (!status.isElevated) {
        relock($t('frameleaf_locked_rules_unlock_again'));
        return;
      }

      let response: UserPreferencesResponseDto;
      try {
        response = await updateMyPreferences({ userPreferencesUpdateDto: lockedRulesUpdate(draft, revision) });
      } catch (error_) {
        if (!isStatus(error_, 409)) {
          throw error_;
        }
        const latest = await getMyPreferences();
        if (!latest.lockedRulesRevealed) {
          relock($t('frameleaf_locked_rules_unlock_again'));
          return;
        }
        const decision = decideAfterConflict(baseline, latest);
        if (decision.action === 'conflict') {
          conflict = true;
          return;
        }
        response = await updateMyPreferences({ userPreferencesUpdateDto: lockedRulesUpdate(draft, decision.revision) });
      }

      if (!response.lockedRulesRevealed) {
        relock($t('frameleaf_locked_rules_unlock_again'));
        return;
      }
      baseline = lockedRulesFrom(response);
      draft = lockedRulesFrom(response);
      revision = response.revision;
      authManager.setPreferences(withoutLockedRuleIds(response));
      notice = $t('frameleaf_locked_rules_saved');
    } catch (error_) {
      if (isStatus(error_, 403) || isStatus(error_, 401)) {
        relock($t('frameleaf_locked_rules_unlock_again'));
      } else if (isStatus(error_, 409)) {
        conflict = true;
      } else {
        error = $t('frameleaf_locked_rules_save_failed');
      }
    } finally {
      saving = false;
    }
  };

  /** Coming back to the page: notice a change made in another tab or on another device. */
  const checkForOutsideChanges = async () => {
    if (phase !== 'ready' || saving || document.visibilityState !== 'visible') {
      return;
    }
    try {
      // An unlock that expired while away is not a change made elsewhere: lock the panel instead.
      if (!(await getAuthStatus()).isElevated) {
        relock($t('frameleaf_locked_rules_unlock_again'));
        return;
      }
      const latest = await getMyPreferences();
      if (!latest.lockedRulesRevealed) {
        relock($t('frameleaf_locked_rules_unlock_again'));
        return;
      }
      if (latest.revision === revision) {
        return;
      }
      const decision = decideAfterConflict(baseline, latest);
      if (decision.action === 'retry') {
        revision = decision.revision;
      } else {
        conflict = true;
      }
    } catch {
      // The next save reports a problem; a background check stays quiet.
    }
  };

  const hideLocked = async () => {
    // FL-83: the shared lock owns failures (root shield with Retry) instead of a local error line
    await requestSessionLock();
  };

  const unlock = () => goto(Route.pinPrompt({ continue: `${page.url.pathname}?isOpen=${RULES_SECTION}` }));
  const openPinSettings = () => goto(`${page.url.pathname}?isOpen=${PIN_SECTION}`);

  const toggle = (field: LockedRuleField, id: string) => {
    draft = toggleLockedRule(draft, field, id);
  };

  const createTag = async () => {
    const name = tagQuery.trim();
    if (!canCreateTag(tags, name) || creatingTag) {
      return;
    }
    creatingTag = true;
    error = '';
    try {
      const created = await upsertTags({ tagUpsertDto: { tags: [name] } });
      const known = new Set(tags.map((tag) => tag.id));
      tags = [...tags, ...created.filter((tag) => !known.has(tag.id))];
      const leaf = created.find((tag) => tag.value.toLocaleLowerCase() === name.toLocaleLowerCase()) ?? created.at(-1);
      if (leaf && !draft.tagIds.includes(leaf.id)) {
        toggle('tagIds', leaf.id);
      }
      tagQuery = '';
    } catch {
      error = $t('frameleaf_locked_rules_tag_create_failed');
    } finally {
      creatingTag = false;
    }
  };

  const runPersonSearch = async (name: string) => {
    const controller = new AbortController();
    searchController = controller;
    searchingPeople = true;
    try {
      const results = await searchPerson({ name, withHidden: true }, { signal: controller.signal });
      if (searchController === controller) {
        personResults = results.filter((person) => !draft.personIds.includes(person.id));
      }
    } catch {
      if (!controller.signal.aborted) {
        personResults = [];
      }
    } finally {
      if (searchController === controller) {
        searchingPeople = false;
        searchController = undefined;
      }
    }
  };

  const onPersonQuery = () => {
    searchController?.abort();
    searchController = undefined;
    clearTimeout(searchTimer);
    const name = personQuery.trim();
    if (!name) {
      personResults = [];
      searchingPeople = false;
      return;
    }
    searchTimer = setTimeout(() => void runPersonSearch(name), 250);
  };

  /**
   * People offered for a rule (UT-26): the loaded list filtered by the query, as the template
   * filters its list, plus any match the search found beyond the loaded page.
   */
  const personOptions = $derived.by(() => {
    const query = personQuery.trim().toLocaleLowerCase();
    const listed = allPeople.filter((person) => !query || personName(person).toLocaleLowerCase().includes(query));
    const seen = new Set(listed.map((person) => person.id));
    return [...listed, ...personResults.filter((person) => !seen.has(person.id))].filter(
      (person) => !draft.personIds.includes(person.id),
    );
  });

  const togglePerson = (person: PersonResponseDto) => {
    people = { ...people, [person.id]: person };
    toggle('personIds', person.id);
  };

  const personName = (person: PersonResponseDto) => person.name || $t('frameleaf_locked_rules_unnamed_person');

  onMount(() => {
    void load();
    const onVisible = () => void checkForOutsideChanges();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  });

  onDestroy(() => {
    searchController?.abort();
    clearTimeout(searchTimer);
  });
</script>

<OnEvents
  onSessionLocked={() => relock()}
  onSessionAccessChanged={({ isElevated }) => (isElevated ? void load() : relock())}
  onUserPinCodeReset={() => void load()}
  onUserPinCodeCreated={() => void load()}
/>

{#if phase !== 'ready'}
  <div class="lock">
    <Icon icon={mdiLockOutline} size="1.75rem" aria-hidden={true} />
    <h3>{$t('frameleaf_locked_rules_title')}</h3>
    <p>{$t('frameleaf_locked_rules_locked_description')}</p>
    {#if phase === 'loading'}
      <p role="status">{$t('loading')}</p>
    {:else if phase === 'unavailable'}
      <p>{$t('frameleaf_locked_rules_session_unavailable')}</p>
      <Button onclick={() => void load()}>{$t('frameleaf_locked_rules_try_again')}</Button>
    {:else if phase === 'no-pin'}
      <p>{$t('frameleaf_locked_rules_set_up_pin')}</p>
      <Button onclick={openPinSettings}>{$t('frameleaf_locked_rules_pin_settings')}</Button>
    {:else}
      <Button variant="primary" onclick={unlock}>{$t('frameleaf_locked_rules_unlock')}</Button>
    {/if}
    {#if notice}
      <p role="status">{notice}</p>
    {/if}
    {#if error}
      <p class="error" role="alert">{error}</p>
    {/if}
  </div>
{:else}
  <div class="rules">
    <div class="section-action">
      <p>{$t('frameleaf_locked_rules_revealed')}</p>
      <Button onclick={hideLocked}>{$t('frameleaf_locked_rules_hide')}</Button>
    </div>

    {#if conflict}
      <div class="notice" role="alert">
        <span>{$t('frameleaf_locked_rules_conflict')}</span>
        <Button onclick={() => void load()}>{$t('frameleaf_locked_rules_reload')}</Button>
      </div>
    {/if}
    {#if notice}
      <p class="notice" role="status">{notice}</p>
    {/if}
    {#if error}
      <p class="error" role="alert">{error}</p>
    {/if}

    <label class="field">
      <span>{$t('frameleaf_locked_rules_scope')}</span>
      <select bind:value={draft.scope}>
        <option value={SuppressionScope.Owned}>{$t('frameleaf_locked_rules_scope_owned')}</option>
        <option value={SuppressionScope.Visible}>{$t('frameleaf_locked_rules_scope_visible')}</option>
      </select>
    </label>

    <div class="grid">
      <section aria-labelledby="locked-rules-people">
        <h3 id="locked-rules-people">{$t('frameleaf_locked_rules_people')}</h3>
        <label class="field">
          <span>{$t('frameleaf_locked_rules_find_person')}</span>
          <input type="search" autocomplete="off" bind:value={personQuery} oninput={onPersonQuery} />
        </label>
        {#each draft.personIds as id (id)}
          {@const person = people[id]}
          <label class="option">
            <input type="checkbox" checked onchange={() => toggle('personIds', id)} />
            {#if person}
              <img class="fl-squircle" src={getPeopleThumbnailUrl(person)} alt="" loading="lazy" />
              <span>{personName(person)}</span>
            {:else}
              <span class="unavailable">
                {$t('frameleaf_locked_rules_unavailable_person')}
                <small>{$t('frameleaf_locked_rules_unavailable_help')}</small>
              </span>
            {/if}
          </label>
        {/each}
        {#if searchingPeople}
          <p class="muted" role="status">{$t('loading')}</p>
        {/if}
        {#each personOptions as person (person.id)}
          <label class="option">
            <input type="checkbox" checked={false} onchange={() => togglePerson(person)} />
            <img class="fl-squircle" src={getPeopleThumbnailUrl(person)} alt="" loading="lazy" />
            <span>{personName(person)}</span>
          </label>
        {/each}
        {#if draft.personIds.length === 0 && personOptions.length === 0 && !searchingPeople}
          <p class="muted">{$t('frameleaf_locked_rules_people_empty')}</p>
        {/if}
      </section>

      <section aria-labelledby="locked-rules-tags">
        <h3 id="locked-rules-tags">{$t('frameleaf_locked_rules_tags')}</h3>
        <label class="field">
          <span>{$t('frameleaf_locked_rules_find_tag')}</span>
          <input type="search" autocomplete="off" maxlength={100} bind:value={tagQuery} />
        </label>
        {#each tagEntries as entry (entry.id)}
          <label class="option">
            <input
              type="checkbox"
              checked={entry.selected || !!entry.lockedThrough}
              disabled={!entry.selected && !!entry.lockedThrough}
              onchange={() => toggle('tagIds', entry.id)}
            />
            {#if entry.available}
              <span>
                {entry.label}
                {#if entry.lockedThrough}
                  <small>{$t('frameleaf_locked_rules_locked_through', { values: { tag: entry.lockedThrough } })}</small>
                {/if}
              </span>
            {:else}
              <span class="unavailable">
                {$t('frameleaf_locked_rules_unavailable_tag')}
                <small>{$t('frameleaf_locked_rules_unavailable_help')}</small>
              </span>
            {/if}
          </label>
        {/each}
        {#if showCreateTag}
          <Button disabled={creatingTag} onclick={createTag}>
            {$t('frameleaf_locked_rules_create_tag', { values: { name: tagQuery.trim() } })}
          </Button>
        {/if}
      </section>

      <section aria-labelledby="locked-rules-pets">
        <h3 id="locked-rules-pets">{$t('frameleaf_locked_rules_pets')}</h3>
        {#each sortedPets as pet (pet.id)}
          <label class="option">
            <input type="checkbox" checked={draft.petIds.includes(pet.id)} onchange={() => toggle('petIds', pet.id)} />
            <span>{isUnnamedPet(pet) ? $t('frameleaf_pets_unnamed') : pet.name}</span>
          </label>
        {/each}
        {#each missingPetIds as id (id)}
          <label class="option">
            <input type="checkbox" checked onchange={() => toggle('petIds', id)} />
            <span class="unavailable">
              {$t('frameleaf_locked_rules_unavailable_pet')}
              <small>{$t('frameleaf_locked_rules_unavailable_help')}</small>
            </span>
          </label>
        {/each}
        {#if pets.length === 0 && missingPetIds.length === 0}
          <p class="muted">{$t('frameleaf_locked_rules_pets_empty')}</p>
        {/if}
      </section>
    </div>

    <div class="section-action end">
      <Button disabled={saving} onclick={() => void load()}>{$t('frameleaf_locked_rules_discard')}</Button>
      <Button variant="primary" disabled={conflict || saving} onclick={save}>
        {$t('frameleaf_locked_rules_save')}
      </Button>
    </div>
  </div>
{/if}

<style>
  .lock {
    display: grid;
    justify-items: start;
    gap: 0.5rem;
    margin: 1rem 0;
    padding: 1rem;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  h3 {
    margin: 0;
    font-size: 1rem;
    color: var(--fl-text);
  }
  p {
    margin: 0;
    color: var(--fl-text);
  }
  .rules {
    display: grid;
    gap: 1rem;
    margin: 1rem 0;
  }
  .section-action {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .section-action.end {
    justify-content: flex-end;
  }
  .notice {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.625rem;
    padding: 0.75rem;
    font-size: var(--fl-font-small);
    color: var(--fl-text);
    background: var(--fl-raised);
    border-left: 2px solid var(--fl-accent);
  }
  .error {
    font-size: var(--fl-font-small);
    color: var(--fl-danger);
  }
  .muted {
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .field {
    display: grid;
    gap: 0.375rem;
    color: var(--fl-text);
  }
  .field span {
    font-weight: 550;
  }
  select,
  input[type='search'] {
    width: 100%;
    max-width: 28rem;
    padding: 0.5rem 0.75rem;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    font: inherit;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
    gap: 1rem;
  }
  .grid section {
    display: grid;
    align-content: start;
    gap: 0.5rem;
    min-width: 0;
  }
  .option {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-height: 2.75rem;
    color: var(--fl-text);
  }
  .option span {
    display: grid;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .option small {
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .option img {
    width: 2rem;
    height: 2rem;
    object-fit: cover;
  }
  .unavailable {
    color: var(--fl-muted);
  }
</style>
