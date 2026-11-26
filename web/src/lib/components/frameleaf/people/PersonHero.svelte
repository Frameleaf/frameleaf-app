<script lang="ts">
  import { formatLuxon } from '$lib/frameleaf/date-format';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import IconButton from '$lib/components/frameleaf/IconButton.svelte';
  import PersonAvatar from '$lib/components/frameleaf/PersonAvatar.svelte';
  import BirthdayDialog from '$lib/components/frameleaf/people/BirthdayDialog.svelte';
  import CorrectionHistoryPanel from '$lib/components/frameleaf/people/CorrectionHistoryPanel.svelte';
  import FeaturedPhotoDialog from '$lib/components/frameleaf/people/FeaturedPhotoDialog.svelte';
  import FixMatchPanel from '$lib/components/frameleaf/people/FixMatchPanel.svelte';
  import MergePeopleDialog from '$lib/components/frameleaf/people/MergePeopleDialog.svelte';
  import PersonNameField from '$lib/components/frameleaf/people/PersonNameField.svelte';
  import { ageInYears, isUnnamedPerson, lifespan } from '$lib/frameleaf/people';
  import { toastUndo } from '$lib/frameleaf/toast';
  import { ICON_SIZE } from '$lib/frameleaf/tokens';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { getPeopleThumbnailUrl } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import { normalizeSearchString } from '$lib/utils/string-utils';
  import { searchPerson, updatePerson, type PersonResponseDto, type PersonStatisticsResponseDto } from '@frameleaf/sdk';
  import { Icon, toastManager } from '@frameleaf/ui';
  import {
    mdiArrowLeft,
    mdiCakeVariantOutline,
    mdiFlowerTulipOutline,
    mdiCallMerge,
    mdiCameraOutline,
    mdiEyeOffOutline,
    mdiEyeOutline,
    mdiFaceRecognition,
    mdiHeart,
    mdiHeartOutline,
    mdiImageMultipleOutline,
    mdiPencilOutline,
  } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { t } from 'svelte-i18n';

  /**
   * The person page hero (FL-37, PD-1/PD-2/PD-7/PD-8), ported from `PersonHeader` in
   * design/frameleaf/template/src/PersonDetail.jsx:214-499: back button, featured-face avatar
   * (opens the featured photo dialog), inline name editor, facts line (count, date of birth
   * with age or "Add date of birth", "Hidden from People") and the toolbar. The dialogs and the "Fix incorrect match" panel are the Frameleaf ports.
   *
   * The count reads "N photos · N videos" (PersonDetail.jsx:257-264) from the person statistics.
   * Every change here is announced: `PersonUpdate` for an edit, `PersonFacesChange` when faces
   * moved (Fix incorrect match) or a merge folded this person into someone else, so the People
   * grid, open viewer face chips and search chips re-read what they show.
   *
   * FL-1813 (owner 2026-11-26, prototype `personV2`): four buttons and no "…" menu: Merge people,
   * Hide, Favorite and Fix recognition. Each task has one way in: the featured photo is changed by
   * clicking the photo, and dates from the line under the name. Fix recognition opens one side panel
   * with two tabs, "Wrong faces" (FixMatchPanel) and "Changes made" (CorrectionHistoryPanel), and a
   * "How faces are grouped" link beside Done.
   *
   * The buttons are one row (DISCOVERY-P6): the hero spans the page, edge to edge as the prototype's
   * does, so they fit on a desktop; on a phone the row scrolls sideways (people.css:1081-1087). What
   * an action did is said in a toast (with Undo for hide and favorite), which is also what a screen
   * reader hears.
   */
  interface Props {
    person: PersonResponseDto;
    statistics: PersonStatisticsResponseDto;
    onBack: () => void;
    onPersonChange: (person: PersonResponseDto) => void;
    /** A merge moved this person into `target`; the page follows them. */
    onMergedAway: (target: PersonResponseDto) => void;
    /** Faces moved away from this person; the page re-reads its photos and count. */
    onFacesChanged: () => void;
    onOpenAsset: (assetId: string) => void;
    onOpenRecognitionGroups: () => void;
  }

  let {
    person,
    statistics,
    onBack,
    onPersonChange,
    onMergedAway,
    onFacesChanged,
    onOpenAsset,
    onOpenRecognitionGroups,
  }: Props = $props();

  let editing = $state(false);
  let featuredOpen = $state(false);
  let mergeOpen = $state(false);
  let mergeChoice: string | null = $state(null);
  let birthdayOpen = $state(false);
  /** Which tab of the "Fix recognition" panel is open, if it is. */
  let recognition = $state<'faces' | 'history'>();
  const RECOGNITION_TABS = [
    ['faces', 'frameleaf_people_fix_tab_faces'],
    ['history', 'frameleaf_people_fix_tab_history'],
  ] as const;

  const assetCount = $derived(statistics.assets);
  const countLabel = $derived(
    [
      statistics.photos ? $t('frameleaf_people_photos_count', { values: { count: statistics.photos } }) : '',
      statistics.videos ? $t('frameleaf_people_videos_count', { values: { count: statistics.videos } }) : '',
    ]
      .filter(Boolean)
      .join(' · '),
  );
  const unnamed = $derived(isUnnamedPerson(person));
  const name = $derived(unnamed ? $t('unnamed_person') : person.name);
  // FL-864: once someone has passed, their page shows a lifespan, never an age.
  const span = $derived(lifespan(person.birthDate, person.deathDate));
  const age = $derived(ageInYears(person.birthDate));
  const birthday = $derived(
    person.birthDate ? formatLuxon(DateTime.fromISO(person.birthDate), DateTime.DATE_FULL, $locale) : undefined,
  );

  /** Says what happened in a toast (a live region); `undo` offers to put it back. */
  const announce = (message: string, undo?: () => unknown) => {
    if (undo) {
      toastUndo(message, undo);
    } else {
      toastManager.primary(message);
    }
  };

  const update = async (
    personUpdateDto: Parameters<typeof updatePerson>[0]['personUpdateDto'],
    message: string,
    errorMessage: string,
    undo?: () => unknown,
  ) => {
    try {
      const updated = await updatePerson({ id: person.id, personUpdateDto });
      eventManager.emit('PersonUpdate', updated);
      onPersonChange(updated);
      announce(message, undo);
      return updated;
    } catch (error) {
      handleError(error, errorMessage);
    }
  };

  /**
   * Faces changed from the fix-match or history panel: announced once, from here only (the panels
   * report the people involved and do not emit themselves), then this page re-reads its photos.
   */
  const announceFaceChanges = (personIds: string[]) => {
    eventManager.emit('PersonFacesChange', { personIds: [...new Set([person.id, ...personIds])] });
    onFacesChanged();
  };

  const setHidden = (isHidden: boolean, undoable = true) =>
    update(
      { isHidden },
      isHidden
        ? $t('frameleaf_people_hidden_detail_status', { values: { name } })
        : $t('frameleaf_people_unhidden_detail_status', { values: { name } }),
      $t('errors.unable_to_hide_person'),
      undoable ? () => void setHidden(!isHidden, false) : undefined,
    );
  const toggleHidden = () => setHidden(!person.isHidden);

  const setFavorite = (isFavorite: boolean, undoable = true) =>
    update(
      { isFavorite },
      isFavorite
        ? $t('frameleaf_people_favorited_status', { values: { name } })
        : $t('frameleaf_people_unfavorited_status', { values: { name } }),
      $t('errors.unable_to_add_remove_favorites', { values: { favorite: !isFavorite } }),
      undoable ? () => void setFavorite(!isFavorite, false) : undefined,
    );
  const toggleFavorite = () => setFavorite(!person.isFavorite);

  // A rename to another person's exact name offers the Frameleaf merge dialog with that
  // person already chosen, replacing the legacy `PersonMergeSuggestionModal`.
  const rename = async (next: string) => {
    editing = false;
    if (next === person.name) {
      return;
    }
    const updated = await update(
      { name: next },
      unnamed
        ? $t('frameleaf_people_named_status', { values: { name: next } })
        : $t('frameleaf_people_renamed_detail_status', { values: { name: next } }),
      $t('errors.unable_to_save_name'),
    );
    if (!updated || !next) {
      return;
    }
    try {
      const normalized = normalizeSearchString(next);
      const match = (await searchPerson({ name: next, withHidden: true })).find(
        (candidate) => candidate.id !== person.id && normalizeSearchString(candidate.name) === normalized,
      );
      if (match) {
        mergeChoice = match.id;
        mergeOpen = true;
      }
    } catch {
      // The rename landed; the merge offer is only a convenience.
    }
  };

  const openMerge = () => {
    mergeChoice = null;
    mergeOpen = true;
  };
</script>

<section class="pd-hero" aria-label={$t('frameleaf_people_details_label', { values: { name } })}>
  <div class="pd-backdrop" style:background-image="url({getPeopleThumbnailUrl(person)})" aria-hidden="true"></div>
  <div class="pd-hero-content">
    <div class="pd-back">
      <IconButton variant="default" label={$t('frameleaf_people_back')} onclick={onBack}>
        <Icon icon={mdiArrowLeft} size="20" aria-hidden="true" />
      </IconButton>
    </div>
    <button
      type="button"
      class="pd-avatar"
      aria-label={$t('frameleaf_people_select_featured_for', { values: { name } })}
      disabled={assetCount === 0}
      onclick={() => (featuredOpen = true)}
    >
      <PersonAvatar {person} size={128} heroKey="person:{person.id}" heroPage />
      <span class="pd-avatar-edit" aria-hidden="true"><Icon icon={mdiCameraOutline} size="16" /></span>
      {#if person.isFavorite}
        <span class="pd-badge" title={$t('favorite')}><Icon icon={mdiHeart} size="14" aria-hidden="true" /></span>
      {/if}
    </button>
    <div class="pd-identity">
      {#if editing}
        <div class="pd-name-editor">
          <PersonNameField
            {person}
            placeholder={unnamed ? $t('add_a_name') : $t('name')}
            onCommit={(next) => void rename(next)}
            onCancel={() => (editing = false)}
          />
        </div>
      {:else}
        <button
          type="button"
          class="pd-name"
          class:is-unnamed={unnamed}
          aria-label={unnamed ? $t('add_a_name') : $t('frameleaf_people_rename_person', { values: { name } })}
          onclick={() => (editing = true)}
        >
          <h1>{unnamed ? $t('add_a_name') : name}</h1>
          <Icon icon={mdiPencilOutline} size="16" aria-hidden="true" />
        </button>
      {/if}
      <div class="pd-facts">
        <span class="pd-fact">
          <Icon icon={mdiImageMultipleOutline} size="15" aria-hidden="true" />
          {countLabel ||
            (assetCount > 0
              ? $t('frameleaf_people_items_count', { values: { count: assetCount } })
              : $t('frameleaf_people_no_photos_yet'))}
        </span>
        <button type="button" class="pd-fact pd-fact-link" onclick={() => (birthdayOpen = true)}>
          <Icon icon={span ? mdiFlowerTulipOutline : mdiCakeVariantOutline} size="15" aria-hidden="true" />
          {#if span}
            {span.born ? span.years : $t('frameleaf_people_died_year', { values: { year: span.years } })}
          {:else if birthday}
            {age === null
              ? $t('frameleaf_people_born', { values: { date: birthday } })
              : $t('frameleaf_people_born_age', { values: { date: birthday, age } })}
          {:else}
            {$t('frameleaf_people_add_birthday')}
          {/if}
        </button>
        {#if person.isHidden}
          <span class="pd-fact pd-fact-flag">
            <Icon icon={mdiEyeOffOutline} size="15" aria-hidden="true" />
            {$t('frameleaf_people_hidden_from_people')}
          </span>
        {/if}
      </div>
    </div>
    <div class="pd-actions" role="toolbar" aria-label={$t('frameleaf_people_person_actions', { values: { name } })}>
      <Button onclick={openMerge}>
        <Icon icon={mdiCallMerge} size={ICON_SIZE.lg} aria-hidden="true" />
        {$t('merge_people')}
      </Button>
      <Button onclick={() => void toggleHidden()}>
        <Icon icon={person.isHidden ? mdiEyeOutline : mdiEyeOffOutline} size={ICON_SIZE.lg} aria-hidden="true" />
        {person.isHidden ? $t('frameleaf_people_unhide') : $t('frameleaf_people_hide')}
      </Button>
      <Button onclick={() => void toggleFavorite()}>
        <span class="pd-favorite" class:is-on={person.isFavorite}>
          <Icon icon={person.isFavorite ? mdiHeart : mdiHeartOutline} size={ICON_SIZE.lg} aria-hidden="true" />
        </span>
        {person.isFavorite ? $t('unfavorite') : $t('favorite')}
      </Button>
      <!-- With no photos there are no faces to look through, but past changes can still be undone. -->
      <Button onclick={() => (recognition = assetCount === 0 ? 'history' : 'faces')}>
        <Icon icon={mdiFaceRecognition} size={ICON_SIZE.lg} aria-hidden="true" />
        {$t('frameleaf_people_fix_recognition')}
      </Button>
    </div>
  </div>
</section>

<FeaturedPhotoDialog
  {person}
  bind:open={featuredOpen}
  onSelected={(updated) => {
    onPersonChange(updated);
    announce($t('frameleaf_people_featured_updated'));
  }}
/>
<MergePeopleDialog
  {person}
  initialChoice={mergeChoice}
  bind:open={mergeOpen}
  onMerged={(target) => onMergedAway(target)}
/>
<BirthdayDialog
  {person}
  bind:open={birthdayOpen}
  onSaved={(updated, hasDates) => {
    onPersonChange(updated);
    announce(hasDates ? $t('frameleaf_people_dates_saved') : $t('frameleaf_people_dates_removed'));
  }}
/>
{#snippet recognitionTabs()}
  <div class="pd-fix-tabs" role="tablist" aria-label={$t('frameleaf_people_fix_recognition')}>
    {#each RECOGNITION_TABS as [id, label] (id)}
      <button type="button" role="tab" aria-selected={recognition === id} onclick={() => (recognition = id)}>
        {$t(label)}
      </button>
    {/each}
  </div>
{/snippet}
{#snippet groupsLink()}
  <button type="button" class="pd-fix-link" onclick={onOpenRecognitionGroups}>
    {$t('frameleaf_people_how_faces_grouped')}
  </button>
{/snippet}
{#if recognition === 'faces'}
  <FixMatchPanel
    {person}
    {onOpenAsset}
    onChanged={announceFaceChanges}
    close={() => (recognition = undefined)}
    title={$t('frameleaf_people_fix_recognition')}
    tabs={recognitionTabs}
    footerLink={groupsLink}
  />
{:else if recognition === 'history'}
  <CorrectionHistoryPanel
    {person}
    {onOpenAsset}
    onChanged={announceFaceChanges}
    close={() => (recognition = undefined)}
    title={$t('frameleaf_people_fix_recognition')}
    tabs={recognitionTabs}
    footerLink={groupsLink}
  />
{/if}

<style>
  /* template/src/people.css "person hero". */
  .pd-hero {
    position: relative;
    isolation: isolate;
    /* Edge to edge, as the prototype's hero in `.media-scroll`: out through the library's page gutter. */
    margin-inline: calc(-1 * var(--fl-library-gutter-start, 0px)) calc(-1 * var(--fl-library-gutter-end, 0px));
    /* PersonDetail.jsx: the Timeline / Browse / Work row sits right under the hero. Take back the
       library header's 12px so the toolbar's own top hairline is the hero's bottom edge, instead of
       a hairline, an empty 28px band and a second hairline. */
    margin-bottom: calc(-1 * var(--fl-space-3));
    background: var(--fl-panel);
  }
  .pd-backdrop {
    position: absolute;
    inset: -40px;
    z-index: 0;
    background-position: center 40%;
    background-size: cover;
    filter: blur(28px) saturate(0.9);
    opacity: 0.35;
    pointer-events: none;
    /*
     * Cut back to the hero's own box (it reaches 40px past each edge so the blur has no soft rim).
     */
    clip-path: inset(40px);
  }
  .pd-hero::after {
    content: '';
    position: absolute;
    inset: 0;
    z-index: 0;
    background: linear-gradient(
      to right,
      color-mix(in srgb, var(--fl-panel), transparent 10%),
      color-mix(in srgb, var(--fl-panel), transparent 45%)
    );
    pointer-events: none;
  }
  .pd-hero-content {
    position: relative;
    z-index: 1;
    display: grid;
    grid-template-areas: 'back avatar identity' 'back actions actions';
    grid-template-columns: auto auto 1fr;
    align-items: center;
    gap: 16px 22px;
    /* The hero runs edge to edge; its content keeps to the one page gutter (8px page area +
       --fl-page-inline = 24px desktop, 16px phone), in line with the toolbar and grid below. */
    padding: 22px calc(var(--fl-space-2) + var(--fl-page-inline)) 20px;
  }
  .pd-back {
    grid-area: back;
    align-self: start;
  }
  .pd-avatar {
    position: relative;
    display: inline-flex;
    grid-area: avatar;
    padding: 0;
    background: none;
    border: 0;
    border-radius: 50%;
  }
  .pd-avatar :global(.avatar) {
    border: 3px solid var(--fl-panel);
    box-shadow: var(--fl-shadow-1);
  }
  .pd-avatar-edit {
    position: absolute;
    right: 4px;
    bottom: 4px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 2px solid var(--fl-panel);
    border-radius: 50%;
    opacity: 0;
    transition: opacity var(--fl-motion) var(--fl-ease);
  }
  .pd-avatar:hover .pd-avatar-edit,
  .pd-avatar:focus-visible .pd-avatar-edit {
    opacity: 1;
  }
  .pd-avatar:disabled {
    cursor: default;
  }
  /* Touch has no hover to reveal it: the camera mark stays, so the avatar reads as a control. */
  @media (hover: none) {
    .pd-avatar:not(:disabled) .pd-avatar-edit {
      opacity: 1;
    }
  }
  .pd-favorite {
    display: inline-flex;
  }
  .pd-favorite.is-on {
    color: var(--fl-danger);
  }
  .pd-badge {
    position: absolute;
    left: 4px;
    bottom: 4px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    color: var(--fl-danger);
    background: var(--fl-raised);
    border: 2px solid var(--fl-panel);
    border-radius: 50%;
  }
  .pd-identity {
    display: flex;
    flex-direction: column;
    grid-area: identity;
    gap: 8px;
    min-width: 0;
  }
  .pd-name {
    display: inline-flex;
    align-items: center;
    align-self: flex-start;
    gap: 10px;
    max-width: 100%;
    padding: 2px 10px 2px 0;
    color: var(--fl-text);
    background: none;
    border: 0;
    border-radius: var(--fl-radius-control);
  }
  .pd-name h1 {
    margin: 0;
    overflow: hidden;
    font-size: 26px;
    font-weight: 600;
    line-height: 1.2;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pd-name :global(svg) {
    color: var(--fl-muted);
    opacity: 0;
    transition: opacity var(--fl-motion) var(--fl-ease);
  }
  .pd-name:hover :global(svg),
  .pd-name:focus-visible :global(svg) {
    opacity: 1;
  }
  .pd-name.is-unnamed h1 {
    color: var(--fl-muted);
    font-weight: 500;
  }
  .pd-name-editor :global(input) {
    min-height: 38px;
    font-size: 18px;
  }
  .pd-facts {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 16px;
    color: var(--fl-muted);
  }
  .pd-fact {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: var(--fl-font-size);
  }
  .pd-fact-link {
    margin-inline-start: calc(-1 * var(--fl-space-2));
    padding: 2px var(--fl-space-2);
    color: var(--fl-muted);
    /* A birthday that wraps on a phone reads from the start edge, like the fact beside it. */
    text-align: start;
    background: none;
    border: 0;
    border-radius: var(--fl-radius-control);
  }
  .pd-fact-link:hover {
    color: var(--fl-text);
    background: var(--fl-raised);
  }
  .pd-fact-flag {
    color: var(--fl-warning);
  }
  .pd-actions {
    display: flex;
    flex-wrap: wrap;
    grid-area: actions;
    gap: var(--fl-space-3) var(--fl-space-2);
  }
  /* FL-1813: the two recognition lists share one panel (prototype people.css `.pd-fix-tabs`, `.pd-fix-link`). */
  .pd-fix-tabs {
    display: flex;
    align-items: center;
    gap: var(--fl-space-2);
    padding: var(--fl-space-3) var(--fl-space-5);
    border-bottom: 1px solid var(--fl-border);
  }
  .pd-fix-tabs button {
    position: relative;
    padding: var(--fl-space-2) var(--fl-space-3);
    border: 1px solid transparent;
    border-radius: var(--fl-radius-pill);
    background: transparent;
    color: var(--fl-muted);
    font: inherit;
    font-size: var(--fl-font-small);
    cursor: pointer;
  }
  /* The pill is drawn small; what can be pressed is 44 high. */
  .pd-fix-tabs button::after {
    content: '';
    position: absolute;
    inset: 50% 0 auto;
    height: 44px;
    transform: translateY(-50%);
  }
  .pd-fix-tabs button[aria-selected='true'] {
    border-color: var(--fl-border);
    background: var(--fl-raised);
    color: var(--fl-text);
    font-weight: var(--fl-weight-semibold);
  }
  .pd-fix-link {
    min-height: 44px;
    margin-inline-start: auto;
    padding: 0;
    border: 0;
    background: none;
    color: var(--fl-muted);
    font: inherit;
    font-size: var(--fl-font-small);
    text-decoration: underline;
    cursor: pointer;
  }
  .pd-fix-link:hover {
    color: var(--fl-text);
  }
  /* Phones: the library header also insets its content by 8px (LibraryView `.fl-library-header`); out through that too. */
  @media (max-width: 767px) {
    .pd-hero {
      margin-inline: calc(-1 * (var(--fl-library-gutter-start, 0px) + var(--fl-space-2)))
        calc(-1 * (var(--fl-library-gutter-end, 0px) + var(--fl-space-2)));
    }
  }
  @media (max-width: 1000px) {
    .pd-hero-content {
      padding-block: 20px 18px;
    }
  }
  @media (max-width: 700px) {
    .pd-backdrop {
      display: none;
    }
    .pd-hero-content {
      grid-template-areas: 'back back' 'avatar identity' 'actions actions';
      grid-template-columns: auto 1fr;
      gap: 12px 14px;
      padding-block: 14px;
    }
    .pd-avatar :global(.avatar) {
      width: 96px !important;
      height: 96px !important;
    }
    .pd-name h1 {
      font-size: 20px;
      white-space: normal;
    }
    /* people.css:1081-1087: one row whose buttons scroll sideways from the screen's edge. */
    .pd-actions {
      flex-wrap: nowrap;
      margin-inline-start: calc(-1 * var(--fl-space-4));
      padding: 2px 0 2px var(--fl-space-4);
      overflow-x: auto;
      scrollbar-width: none;
    }
    .pd-actions::-webkit-scrollbar {
      display: none;
    }
    .pd-actions > :global(*) {
      flex-shrink: 0;
    }
  }
</style>
