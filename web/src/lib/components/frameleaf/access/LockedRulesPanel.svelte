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
   *
   * Drawn as the approved prototype's `AlwaysLocked` (`settings-v2/cloud/Personal.jsx`): a hero with
   * what is kept Locked (or "Unlock to see or change these"), "Whose photos, and which tags" (People,
   * Pets and Tags, each showing what is chosen and opening its list with Change), and "Where they're
   * hidden" with Save. The prototype's "Ask for my PIN before these can be changed" is not drawn: the
   * server always asks, so there is nothing to turn off.
   */
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Spinner from '$lib/components/frameleaf/Spinner.svelte';
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
    countLockedRules,
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
  } from '@frameleaf/sdk';
  import Choice from '$lib/components/frameleaf/settings/kit/Choice.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import Said from '$lib/components/frameleaf/settings/kit/Said.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import { mdiLockCheckOutline, mdiLockOutline } from '@mdi/js';
  import { locale } from '$lib/stores/preferences.store';
  import { onDestroy, onMount, type Snippet } from 'svelte';
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
  let generation = 0;
  let disposed = false;
  const ownerId = authManager.authenticated ? authManager.user.id : undefined;
  const capture = () => {
    const current = generation;
    const isCurrentSession = authManager.captureSession();
    return () => !disposed && current === generation && isCurrentSession();
  };

  $effect(() => {
    const currentOwner = authManager.authenticated ? authManager.user.id : undefined;
    if (currentOwner !== ownerId) {
      relock();
    }
  });

  const isStatus = (error: unknown, status: number) => isHttpError(error) && error.status === status;

  /** Forget everything the unlocked session revealed. */
  const drop = () => {
    generation++;
    searchController?.abort();
    searchController = undefined;
    clearTimeout(searchTimer);
    searchingPeople = false;
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

  const resolvePeople = async (ids: string[], isCurrent: () => boolean) => {
    const results = await Promise.allSettled(ids.map((id) => getPerson({ id })));
    if (!isCurrent()) {
      return;
    }
    const resolved: Record<string, PersonResponseDto | null> = {};
    for (const [index, id] of ids.entries()) {
      const result = results[index];
      resolved[id] = result.status === 'fulfilled' ? result.value : null;
    }
    people = resolved;
  };

  const applyLoaded = async (preferences: UserPreferencesResponseDto, isCurrent: () => boolean) => {
    baseline = lockedRulesFrom(preferences);
    draft = lockedRulesFrom(preferences);
    revision = preferences.revision;
    conflict = false;
    await resolvePeople(baseline.personIds, isCurrent);
  };

  /** Load the rules; only while the session is unlocked before and after the read. */
  const load = async () => {
    generation++;
    const isCurrent = capture();
    if (!isCurrent()) {
      return;
    }
    error = '';
    try {
      const before = await getAuthStatus();
      if (!isCurrent()) {
        return;
      }
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
      if (!isCurrent()) {
        return;
      }
      const after = await getAuthStatus();
      if (!isCurrent()) {
        return;
      }
      // The read itself says whether it named the rules: a session that locked and unlocked again
      // between the two status checks still gets blanked rules here, never an editable empty draft.
      if (!after.isElevated || !preferences.lockedRulesRevealed) {
        relock($t('frameleaf_locked_rules_unlock_again'));
        return;
      }

      tags = allTags;
      pets = allPets;
      allPeople = peoplePage.people;
      await applyLoaded(preferences, isCurrent);
      if (!isCurrent()) {
        return;
      }
      tagQuery = '';
      personQuery = '';
      personResults = [];
      notice = '';
      phase = 'ready';
    } catch {
      if (!isCurrent()) {
        return;
      }
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
    const isCurrent = capture();
    if (!isCurrent()) {
      return;
    }

    saving = true;
    error = '';
    notice = '';
    try {
      const status = await getAuthStatus();
      if (!isCurrent()) {
        return;
      }
      if (!status.isElevated) {
        relock($t('frameleaf_locked_rules_unlock_again'));
        return;
      }

      let response: UserPreferencesResponseDto;
      try {
        response = await updateMyPreferences({ userPreferencesUpdateDto: lockedRulesUpdate(draft, revision) });
      } catch (error_) {
        if (!isCurrent()) {
          return;
        }
        if (!isStatus(error_, 409)) {
          throw error_;
        }
        const latest = await getMyPreferences();
        if (!isCurrent()) {
          return;
        }
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

      if (!isCurrent()) {
        return;
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
      if (!isCurrent()) {
        return;
      }
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
    const isCurrent = capture();
    try {
      // An unlock that expired while away is not a change made elsewhere: lock the panel instead.
      const status = await getAuthStatus();
      if (!isCurrent()) {
        return;
      }
      if (!status.isElevated) {
        relock($t('frameleaf_locked_rules_unlock_again'));
        return;
      }
      const latest = await getMyPreferences();
      if (!isCurrent()) {
        return;
      }
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
    const isCurrent = capture();
    if (!isCurrent() || phase !== 'ready') {
      return;
    }
    const name = tagQuery.trim();
    if (!canCreateTag(tags, name) || creatingTag) {
      return;
    }
    creatingTag = true;
    error = '';
    try {
      const created = await upsertTags({ tagUpsertDto: { tags: [name] } });
      if (!isCurrent()) {
        return;
      }
      const known = new Set(tags.map((tag) => tag.id));
      tags = [...tags, ...created.filter((tag) => !known.has(tag.id))];
      const leaf = created.find((tag) => tag.value.toLocaleLowerCase() === name.toLocaleLowerCase()) ?? created.at(-1);
      if (leaf && !draft.tagIds.includes(leaf.id)) {
        toggle('tagIds', leaf.id);
      }
      tagQuery = '';
    } catch {
      if (!isCurrent()) {
        return;
      }
      error = $t('frameleaf_locked_rules_tag_create_failed');
    } finally {
      creatingTag = false;
    }
  };

  const runPersonSearch = async (name: string) => {
    const isCurrent = capture();
    if (!isCurrent() || phase !== 'ready') {
      return;
    }
    const controller = new AbortController();
    searchController = controller;
    searchingPeople = true;
    try {
      const results = await searchPerson({ name, withHidden: true }, { signal: controller.signal });
      if (isCurrent() && searchController === controller) {
        personResults = results.filter((person) => !draft.personIds.includes(person.id));
      }
    } catch {
      if (isCurrent() && !controller.signal.aborted) {
        personResults = [];
      }
    } finally {
      if (isCurrent() && searchController === controller) {
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
    disposed = true;
    drop();
  });

  const anyChosen = $derived(baseline.personIds.length + baseline.petIds.length + baseline.tagIds.length > 0);
  const changed = $derived(JSON.stringify(draft) !== JSON.stringify(baseline));
  /** "2 people, 1 pet and 1 tag", from the saved rules (the prototype's hero). */
  const chosenWords = $derived(
    new Intl.ListFormat($locale, { type: 'conjunction' }).format(
      [
        baseline.personIds.length > 0
          ? $t('frameleaf_locked_rules_n_people', { values: { count: baseline.personIds.length } })
          : '',
        baseline.petIds.length > 0
          ? $t('frameleaf_locked_rules_n_pets', { values: { count: baseline.petIds.length } })
          : '',
        baseline.tagIds.length > 0
          ? $t('frameleaf_locked_rules_n_tags', { values: { count: baseline.tagIds.length } })
          : '',
      ].filter(Boolean),
    ),
  );
  /** What the saved rules keep Locked, for the hero; the count follows the draft until it is saved. */
  let savedCount = $state<{ photos: number; videos: number } | null>(null);
  $effect(() => {
    if (lockedCount && !changed) {
      savedCount = lockedCount;
    }
  });

  // FL-541: what the draft would keep Locked, counted on the server as the rules are edited (only
  // the owner's own photos and videos; the rules need an unlocked session, so does the count).
  let lockedCount = $state<{ photos: number; videos: number } | null>(null);
  const draftKey = $derived(JSON.stringify([draft.personIds, draft.tagIds, draft.petIds]));
  $effect(() => {
    if (phase !== 'ready') {
      return;
    }
    const [personIds, tagIds, petIds] = JSON.parse(draftKey) as [string[], string[], string[]];
    const timer = setTimeout(() => {
      void (async () => {
        try {
          lockedCount = (await countLockedRules({ lockedRulesDraftDto: { personIds, tagIds, petIds } })) ?? null;
        } catch {
          lockedCount = null;
        }
      })();
    }, 400);
    return () => clearTimeout(timer);
  });
</script>

<OnEvents
  onSessionLocked={() => relock()}
  onSessionAccessChanged={({ isElevated }) => (isElevated ? void load() : relock())}
  onUserPinCodeReset={() => void load()}
  onUserPinCodeCreated={() => void load()}
/>

{#snippet unlockAction()}
  <Button variant="primary" onclick={unlock}>{$t('frameleaf_locked_rules_unlock')}</Button>
{/snippet}
{#snippet pinAction()}
  <Button variant="primary" onclick={openPinSettings}>{$t('frameleaf_locked_rules_pin_settings')}</Button>
{/snippet}
{#snippet retryAction()}
  <Button onclick={() => void load()}>{$t('frameleaf_locked_rules_try_again')}</Button>
{/snippet}
{#snippet hideAction()}
  <Button onclick={hideLocked}>{$t('frameleaf_locked_rules_hide')}</Button>
{/snippet}
{#snippet reloadAction()}
  <Button onclick={() => void load()}>{$t('frameleaf_locked_rules_reload')}</Button>
{/snippet}

{#snippet chips(items: { key: string; name: string; image?: string }[])}
  {#if items.length === 0}
    <span class="none">{$t('frameleaf_locked_rules_none')}</span>
  {:else}
    <span class="chips">
      {#each items as item (item.key)}
        <span class="chip" class:is-plain={!item.image}>
          {#if item.image}<img class="fl-squircle" src={item.image} alt="" loading="lazy" />{/if}
          {item.name}
        </span>
      {/each}
    </span>
  {/if}
{/snippet}

{#snippet pick(label: string, help: string, chosen: { key: string; name: string; image?: string }[], body: Snippet)}
  <details class="pick">
    <summary>
      <span class="copy">
        <strong>{label}</strong>
        <small>{help}</small>
      </span>
      <span class="chosen">
        {@render chips(chosen)}
        <span class="change" aria-hidden="true"
          >{chosen.length === 0 ? $t('frameleaf_locked_rules_choose') : $t('frameleaf_locked_rules_change')}</span
        >
      </span>
    </summary>
    <div class="picker">{@render body()}</div>
  </details>
{/snippet}

{#snippet peoplePicker()}
  <label class="field">
    <span>{$t('frameleaf_locked_rules_find_person')}</span>
    <input type="search" autocomplete="off" bind:value={personQuery} oninput={onPersonQuery} />
  </label>
  <div class="options">
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
    {#each personOptions as person (person.id)}
      <label class="option">
        <input type="checkbox" checked={false} onchange={() => togglePerson(person)} />
        <img class="fl-squircle" src={getPeopleThumbnailUrl(person)} alt="" loading="lazy" />
        <span>{personName(person)}</span>
      </label>
    {/each}
  </div>
  {#if searchingPeople}
    <Spinner size="md" label={$t('loading')} />
  {/if}
  {#if draft.personIds.length === 0 && personOptions.length === 0 && !searchingPeople}
    <p class="muted">{$t('frameleaf_locked_rules_people_empty')}</p>
  {/if}
{/snippet}

{#snippet petsPicker()}
  <div class="options">
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
  </div>
  {#if pets.length === 0 && missingPetIds.length === 0}
    <p class="muted">{$t('frameleaf_locked_rules_pets_empty')}</p>
  {/if}
{/snippet}

{#snippet tagsPicker()}
  <label class="field">
    <span>{$t('frameleaf_locked_rules_find_tag')}</span>
    <input type="search" autocomplete="off" maxlength={100} bind:value={tagQuery} />
  </label>
  <div class="options">
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
  </div>
  {#if showCreateTag}
    <div>
      <Button disabled={creatingTag} onclick={createTag}>
        {$t('frameleaf_locked_rules_create_tag', { values: { name: tagQuery.trim() } })}
      </Button>
    </div>
  {/if}
{/snippet}

<KitPage>
  {#if phase !== 'ready'}
    {#if phase === 'no-pin'}
      <Hero
        tone="quiet"
        icon={mdiLockOutline}
        title={$t('frameleaf_locked_rules_hero_no_pin')}
        body={$t('frameleaf_locked_rules_set_up_pin')}
        label={$t('frameleaf_locked_rules_title')}
        actions={pinAction}
      />
    {:else if phase === 'unavailable'}
      <Hero
        tone="warn"
        icon={mdiLockOutline}
        title={$t('frameleaf_locked_rules_hero_locked')}
        body={$t('frameleaf_locked_rules_session_unavailable')}
        label={$t('frameleaf_locked_rules_title')}
        actions={retryAction}
      />
    {:else}
      <Hero
        tone="quiet"
        icon={mdiLockOutline}
        title={$t('frameleaf_locked_rules_hero_locked')}
        body={$t('frameleaf_locked_rules_locked_description')}
        label={$t('frameleaf_locked_rules_title')}
        actions={phase === 'locked' ? unlockAction : undefined}
      >
        {#if phase === 'loading'}
          <div class="loading"><Spinner size="lg" label={$t('loading')} /></div>
        {/if}
      </Hero>
    {/if}
    <Said message={notice} onDismiss={() => (notice = '')} />
    {#if error}
      <div role="alert"><Notice tone="warn" title={error} /></div>
    {/if}
  {:else}
    <Hero
      tone={anyChosen ? 'good' : 'quiet'}
      icon={anyChosen ? mdiLockCheckOutline : mdiLockOutline}
      title={!anyChosen
        ? $t('frameleaf_locked_rules_hero_none')
        : savedCount && savedCount.photos + savedCount.videos > 0
          ? savedCount.videos === 0
            ? $t('frameleaf_locked_rules_hero_photos', { values: savedCount })
            : savedCount.photos === 0
              ? $t('frameleaf_locked_rules_hero_videos', { values: savedCount })
              : $t('frameleaf_locked_rules_hero_count', { values: savedCount })
          : $t('frameleaf_locked_rules_hero_some')}
      body={anyChosen
        ? $t('frameleaf_locked_rules_hero_because', { values: { chosen: chosenWords } })
        : $t('frameleaf_locked_rules_hero_none_body')}
      label={$t('frameleaf_locked_rules_title')}
      actions={hideAction}
    />

    {#if conflict}
      <div role="alert">
        <Notice tone="warn" title={$t('frameleaf_locked_rules_conflict')} action={reloadAction} />
      </div>
    {/if}
    <Said message={notice} onDismiss={() => (notice = '')} />
    {#if error}
      <div role="alert"><Notice tone="warn" title={error} /></div>
    {/if}

    <Section title={$t('frameleaf_locked_rules_whose')}>
      {@render pick(
        $t('frameleaf_locked_rules_people'),
        $t('frameleaf_locked_rules_people_help'),
        draft.personIds.map((id) => {
          const person = people[id];
          return {
            key: id,
            name: person ? personName(person) : $t('frameleaf_locked_rules_unavailable_person'),
            image: person ? getPeopleThumbnailUrl(person) : undefined,
          };
        }),
        peoplePicker,
      )}
      {@render pick(
        $t('frameleaf_locked_rules_pets'),
        $t('frameleaf_locked_rules_people_help'),
        draft.petIds.map((id) => {
          const pet = pets.find((item) => item.id === id);
          return {
            key: id,
            name: pet
              ? isUnnamedPet(pet)
                ? $t('frameleaf_pets_unnamed')
                : pet.name
              : $t('frameleaf_locked_rules_unavailable_pet'),
          };
        }),
        petsPicker,
      )}
      {@render pick(
        $t('frameleaf_locked_rules_tags'),
        $t('frameleaf_locked_rules_tags_help'),
        tagEntries
          .filter((entry) => entry.selected)
          .map((entry) => ({
            key: entry.id,
            name: entry.available ? entry.label : $t('frameleaf_locked_rules_unavailable_tag'),
          })),
        tagsPicker,
      )}
    </Section>

    <Section title={$t('frameleaf_locked_rules_scope')}>
      <Choice
        label={$t('frameleaf_locked_rules_scope')}
        value={draft.scope}
        options={[
          {
            value: SuppressionScope.Owned,
            label: $t('frameleaf_locked_rules_scope_owned'),
            detail: $t('frameleaf_locked_rules_scope_owned_detail'),
          },
          {
            value: SuppressionScope.Visible,
            label: $t('frameleaf_locked_rules_scope_visible'),
            detail: $t('frameleaf_locked_rules_scope_visible_detail'),
          },
        ]}
        onChange={(value) => (draft.scope = value as SuppressionScope)}
      />
      {#if lockedCount}
        <div class="count">
          <Notice
            title={lockedCount.photos + lockedCount.videos === 0
              ? $t('frameleaf_locked_rules_count_none')
              : lockedCount.videos === 0
                ? $t('frameleaf_locked_rules_count_photos', { values: lockedCount })
                : lockedCount.photos === 0
                  ? $t('frameleaf_locked_rules_count_videos', { values: lockedCount })
                  : $t('frameleaf_locked_rules_count', { values: lockedCount })}
          >
            {changed ? $t('frameleaf_locked_rules_count_draft') : $t('frameleaf_locked_rules_count_now')}
          </Notice>
        </div>
      {/if}
      <div class="actions">
        <!-- As the prototype: nothing to save or undo until something changes. -->
        <Button variant="primary" disabled={conflict || saving || !changed} onclick={save}>
          {$t('frameleaf_locked_rules_save')}
        </Button>
        <Button disabled={saving || !changed} onclick={() => (draft = $state.snapshot(baseline))}
          >{$t('frameleaf_locked_rules_discard')}</Button
        >
      </div>
    </Section>
  {/if}
</KitPage>

<style>
  .loading {
    padding: 0 var(--fl-space-6) var(--fl-space-5);
  }
  .pick {
    border-top: 1px solid var(--fl-border);
  }
  .pick > summary {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--fl-space-6);
    padding: var(--fl-space-4) 0;
    cursor: pointer;
    list-style: none;
  }
  .pick > summary::-webkit-details-marker {
    display: none;
  }
  .pick > summary:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
    border-radius: var(--fl-radius-sm);
  }
  .copy {
    display: grid;
    gap: var(--fl-space-2);
    min-width: 0;
  }
  .copy strong {
    font-size: var(--fl-font-callout);
    font-weight: 600;
  }
  .copy small {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.5;
  }
  .chosen {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: var(--fl-space-2);
    min-width: 0;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: var(--fl-space-2);
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: var(--fl-space-2);
    min-height: 32px;
    padding: 0 var(--fl-space-3) 0 var(--fl-space-1);
    font-size: var(--fl-font-small);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: 999px;
  }
  .chip.is-plain {
    padding-inline-start: var(--fl-space-3);
  }
  .chip img {
    width: 24px;
    height: 24px;
    object-fit: cover;
    border-radius: 999px;
  }
  .none {
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
  }
  /* Drawn like the kit's buttons; the whole row opens the list, so it is not a button of its own. */
  .change {
    display: inline-flex;
    align-items: center;
    min-height: var(--fl-control-height);
    padding: 0 var(--fl-space-3);
    color: var(--fl-text);
    font-size: var(--fl-font-callout);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .pick > summary:hover .change {
    border-color: var(--fl-border-strong, var(--fl-border));
  }
  .pick[open] .change {
    background: var(--fl-panel);
  }
  .picker {
    display: grid;
    gap: var(--fl-space-3);
    padding: 0 0 var(--fl-space-4);
  }
  .options {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr));
    gap: 0 var(--fl-space-4);
    max-height: 22rem;
    overflow-y: auto;
  }
  .muted {
    margin: 0;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .field {
    display: grid;
    gap: var(--fl-space-2);
    color: var(--fl-text);
    font-size: var(--fl-font-small);
  }
  .field span {
    font-weight: 600;
  }
  input[type='search'] {
    width: 100%;
    max-width: 28rem;
    min-height: var(--fl-control-height);
    padding: 0 var(--fl-space-3);
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    font: inherit;
  }
  .option {
    display: flex;
    align-items: center;
    gap: var(--fl-space-2);
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
  .count {
    margin-top: var(--fl-space-3);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-2);
    padding: var(--fl-space-4) 0 var(--fl-space-5);
  }
  @container kit (max-width: 620px) {
    .pick > summary {
      grid-template-columns: 1fr;
      gap: var(--fl-space-3);
    }
    .chosen,
    .chips {
      justify-content: flex-start;
    }
  }
</style>
