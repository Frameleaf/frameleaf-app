<script lang="ts">
  import PersonAvatar from '$lib/components/frameleaf/PersonAvatar.svelte';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import PersonFaceActions from '$lib/components/frameleaf/PersonFaceActions.svelte';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Route } from '$lib/route';
  import { faceManager } from '$lib/stores/face.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { getAssetMediaUrl } from '$lib/utils';
  import { AssetMediaSize, type AssetFaceResponseDto, type AssetResponseDto } from '@frameleaf/sdk';
  import { Button, Icon, Text } from '@frameleaf/ui';
  import { mdiEye, mdiEyeOff, mdiEyeOffOutline, mdiPlus } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { t } from 'svelte-i18n';

  type Props = {
    asset: AssetResponseDto;
    isOwner: boolean;
    previousRoute: string;
    /**
     * FL-38: re-reads the asset and its faces from the server after an inline reassign,
     * create-person, remove or hide action lands. `DetailPanel.svelte` passes its
     * `handleRefreshPeople`.
     */
    onFacesChanged: () => void | Promise<void>;
  };

  const { asset, isOwner, previousRoute, onFacesChanged }: Props = $props();

  let people = $derived(Array.from(faceManager.people));
  /**
   * FL-38 (V-22): with the legacy "Edit people" side panel gone, a detected face nobody is
   * assigned to gets its own "Unnamed person" chip and chip menu, as the prototype's
   * `peopleChips` does (media-viewer.mjs:451; MediaViewer.jsx PeopleSection 2071-2285).
   */
  const unassignedFaces = $derived(isOwner ? faceManager.data.filter((face) => !face.person) : []);
  /**
   * FL-38: faces the owner hid ("Hide face" is restorable). They count toward the prototype's
   * "Show hidden (n)" toggle (MediaViewer.jsx:2820-2833) and, while it is on, get a dimmed chip
   * whose menu offers "Show face", like a hidden person's chip (`mv-chip-wrap hidden-person`).
   */
  // Hovering a chip highlights its face box on a photo (PhotoViewer). A video's faces were found
  // on its preview still, one frame of the video, so their boxes are not drawn over playback.
  const hiddenFaces = $derived(isOwner ? faceManager.hiddenFaces : []);
  const shownHiddenFaces = $derived(assetViewerManager.isShowingHiddenPeople ? hiddenFaces : []);
  $effect(() => {
    // re-read whenever the viewer re-reads the asset's faces (after any face change)
    void faceManager.data;
    if (isOwner && !authManager.isSharedLink) {
      void faceManager.loadHiddenFaces(asset.id);
    }
  });
  const previewUrl = $derived(
    getAssetMediaUrl({ id: asset.id, size: AssetMediaSize.Preview, cacheKey: asset.thumbhash }),
  );

  /** Crops the asset preview to one face with CSS, so an unnamed chip shows whose face it is. */
  const faceCropStyle = (face: AssetFaceResponseDto) => {
    const width = Math.max(1, face.boundingBoxX2 - face.boundingBoxX1);
    const height = Math.max(1, face.boundingBoxY2 - face.boundingBoxY1);
    const offset = (start: number, size: number, total: number) =>
      total > size ? `${(start / (total - size)) * 100}%` : '50%';
    return [
      `background-image: url("${previewUrl}")`,
      `background-size: ${(face.imageWidth / width) * 100}% ${(face.imageHeight / height) * 100}%`,
      `background-position: ${offset(face.boundingBoxX1, width, face.imageWidth)} ${offset(face.boundingBoxY1, height, face.imageHeight)}`,
    ].join('; ');
  };
  /**
   * FL-37: a person on this photo was renamed, hidden, given a birthday or a featured photo, or
   * faces moved between people (a merge, Fix incorrect match) somewhere else: re-read this photo's
   * faces so the chips show current names and photos. Only what the server returns for this photo
   * is drawn, so no other person's (or anyone's private) thumbnail can appear here.
   */
  const refreshChips = async () => {
    try {
      await onFacesChanged();
    } catch {
      // the chips keep what they showed; opening the next photo reads its faces again
    }
  };
  const onPersonUpdate = ({ id }: { id: string }) => {
    if (!authManager.isSharedLink && people.some((person) => person.id === id)) {
      void refreshChips();
    }
  };
  const onPersonThumbnailReady = ({ id }: { id: string }) => {
    if (!authManager.isSharedLink && people.some((person) => person.id === id)) {
      const updatedAt = new Date().toISOString();
      people = people.map((person) => (person.id === id ? { ...person, updatedAt } : person));
    }
  };
  const onPersonFacesChange = () => {
    if (!authManager.isSharedLink) {
      void refreshChips();
    }
  };

  const hiddenCount = $derived(people.reduce((count, person) => count + (person.isHidden ? 1 : 0), hiddenFaces.length));
  const visiblePeople = $derived.by(() => {
    const visible = [];
    const showHidden = assetViewerManager.isShowingHiddenPeople;
    let assetDate: DateTime | undefined;
    for (const person of people) {
      if (!showHidden && person.isHidden) {
        continue;
      }
      if (!person.birthDate) {
        visible.push({ formattedBirthDate: undefined, formattedAge: undefined, ...person });
        continue;
      }
      const personBirthDate = DateTime.fromISO(person.birthDate);
      assetDate ??= DateTime.fromISO(asset.localDateTime);
      const ageInYears = Math.floor(assetDate.diff(personBirthDate, 'years').years);
      const ageInMonths = Math.floor(assetDate.diff(personBirthDate, 'months').months);

      let formattedAge;
      if (ageInYears < 0) {
        visible.push({ formattedBirthDate: undefined, formattedAge: undefined, ...person });
        continue;
      }
      if (ageInMonths < 12) {
        formattedAge = $t('age_months', { values: { months: ageInMonths } });
      } else if (ageInMonths > 12 && ageInMonths < 24) {
        formattedAge = $t('age_year_months', { values: { months: ageInMonths - 12 } });
      } else {
        formattedAge = $t('age_years', { values: { years: ageInYears } });
      }

      const formattedBirthDate = personBirthDate.toLocaleString(
        {
          month: 'long',
          day: 'numeric',
          year: 'numeric',
        },
        { locale: $locale },
      );
      visible.push({ formattedBirthDate, formattedAge, ...person });
    }
    return visible;
  });
</script>

<OnEvents {onPersonUpdate} {onPersonFacesChange} {onPersonThumbnailReady} />

{#if !authManager.isSharedLink}
  <section class="text-sm">
    {#if isOwner || visiblePeople.length > 0 || unassignedFaces.length > 0}
      <div class="fl-info-heading-row">
        <h3 class="fl-info-heading">{$t('people')}</h3>
        <div class="flex items-center gap-2">
          {#if isOwner}
            {#if hiddenCount > 0}
              <Button
                size="small"
                color="secondary"
                variant="ghost"
                leadingIcon={assetViewerManager.isShowingHiddenPeople ? mdiEyeOff : mdiEye}
                aria-pressed={assetViewerManager.isShowingHiddenPeople}
                onclick={() => assetViewerManager.toggleHiddenPeople()}
              >
                {assetViewerManager.isShowingHiddenPeople
                  ? $t('frameleaf_viewer_hide_hidden_people')
                  : $t('frameleaf_viewer_show_hidden_people', { values: { count: hiddenCount } })}
              </Button>
            {/if}
            <Button
              size="small"
              color="secondary"
              variant="ghost"
              leadingIcon={mdiPlus}
              aria-label={$t('frameleaf_viewer_add_person_label')}
              onclick={() => assetViewerManager.toggleFaceEditMode()}
            >
              {$t('frameleaf_viewer_add_person')}
            </Button>
          {/if}
        </div>
      </div>
      {#if visiblePeople.length === 0 && unassignedFaces.length === 0 && shownHiddenFaces.length === 0}
        <Text size="small" color="muted">{$t('frameleaf_viewer_no_people')}</Text>
      {/if}
    {/if}

    <!--
      MediaViewer.jsx `.mv-people-list`: one pill per person, the squircle face (FL-37), the name
      (and age), and the face's own "⋮" menu at its end. Hovering or focusing a pill outlines the face.
    -->
    <div class="fl-people-list">
      {#each visiblePeople as person (person.id)}
        {@const personFaces = faceManager.facesByPersonId.get(person.id) ?? []}
        {@const primaryFace = personFaces[0]}
        {@const isHighlighted = personFaces.some((f) => assetViewerManager.highlightedFaces.some((b) => b.id === f.id))}
        <div class="fl-person-chip" class:is-hidden={person.isHidden} data-highlighted={isHighlighted || undefined}>
          <a
            class="fl-person-link"
            href={Route.viewPerson(person, { previousRoute })}
            title={person.formattedBirthDate ? `${person.name} · ${person.formattedBirthDate}` : person.name}
            onfocus={() => assetViewerManager.setHighlightedFaces(personFaces)}
            onblur={() => assetViewerManager.clearHighlightedFaces()}
            onpointerenter={() => assetViewerManager.setHighlightedFaces(personFaces)}
            onpointerleave={() => assetViewerManager.clearHighlightedFaces()}
          >
            <span class="fl-squircle fl-person-face" data-highlighted={isHighlighted || undefined}>
              <PersonAvatar {person} size={32} />
            </span>
            <p class="fl-person-name">{person.name}</p>
            {#if person.birthDate && person.formattedAge}
              <p class="fl-person-age">{person.formattedAge}</p>
            {/if}
            {#if person.isHidden}
              <Icon icon={mdiEyeOffOutline} size="13" aria-label={$t('frameleaf_faces_hidden_label')} />
            {/if}
          </a>
          {#if isOwner && primaryFace}
            <PersonFaceActions {person} face={primaryFace} {previousRoute} {onFacesChanged} />
          {/if}
        </div>
      {/each}
      {#each unassignedFaces as face (face.id)}
        {@const isHighlighted = assetViewerManager.highlightedFaces.some((b) => b.id === face.id)}
        <div
          class="fl-person-chip"
          data-testid="unassigned-face"
          data-highlighted={isHighlighted || undefined}
          role="presentation"
          onpointerenter={() => assetViewerManager.setHighlightedFaces([face])}
          onpointerleave={() => assetViewerManager.clearHighlightedFaces()}
          onfocusin={() => assetViewerManager.setHighlightedFaces([face])}
          onfocusout={() => assetViewerManager.clearHighlightedFaces()}
        >
          <span class="fl-person-link">
            <span class="fl-squircle fl-person-face fl-person-crop" style={faceCropStyle(face)} aria-hidden="true"
            ></span>
            <p class="fl-person-name">{$t('unnamed_person')}</p>
          </span>
          <PersonFaceActions person={null} {face} {previousRoute} {onFacesChanged} />
        </div>
      {/each}
      {#each shownHiddenFaces as face (face.id)}
        {@const isHighlighted = assetViewerManager.highlightedFaces.some((b) => b.id === face.id)}
        {@const label = face.person?.name || $t('unnamed_person')}
        <div
          class="fl-person-chip is-hidden"
          data-testid="hidden-face"
          data-highlighted={isHighlighted || undefined}
          role="presentation"
          onpointerenter={() => assetViewerManager.setHighlightedFaces([face])}
          onpointerleave={() => assetViewerManager.clearHighlightedFaces()}
          onfocusin={() => assetViewerManager.setHighlightedFaces([face])}
          onfocusout={() => assetViewerManager.clearHighlightedFaces()}
        >
          <span class="fl-person-link" title={label}>
            <span class="fl-squircle fl-person-face fl-person-crop" style={faceCropStyle(face)} aria-hidden="true"
            ></span>
            <p class="fl-person-name">{label}</p>
            <Icon icon={mdiEyeOffOutline} size="13" aria-label={$t('frameleaf_faces_hidden_label')} />
          </span>
          <PersonFaceActions person={face.person} {face} {previousRoute} {onFacesChanged} />
        </div>
      {/each}
    </div>
  </section>
{/if}

<style>
  /* .mv-people-list / .mv-chip-wrap / .mv-chip (media-viewer.css:1249-1330). */
  .fl-people-list {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-2);
    margin-top: var(--fl-space-2);
  }
  .fl-person-chip {
    display: inline-flex;
    align-items: center;
    gap: var(--fl-space-1);
    min-width: 0;
    max-width: 100%;
    padding-inline-end: var(--fl-space-1);
    border: 1px solid var(--fl-viewer-border);
    border-radius: 999px;
    background: color-mix(in srgb, var(--fl-viewer-text) 3%, transparent);
    transition:
      border-color var(--fl-motion-fast) var(--fl-ease),
      background-color var(--fl-motion-fast) var(--fl-ease);
  }
  .fl-person-chip:hover,
  .fl-person-chip:focus-within,
  .fl-person-chip[data-highlighted] {
    border-color: var(--fl-accent);
    background: var(--fl-accent-soft);
  }
  /* .mv-chip-more: the "⋮" sits in the pill with no fill of its own until it is pointed at. */
  .fl-person-chip :global(.fl-face-trigger .menu-root > button:not(:hover)) {
    background: transparent;
  }
  .fl-person-chip.is-hidden {
    opacity: 0.6;
  }
  .fl-person-link {
    display: inline-flex;
    align-items: center;
    gap: var(--fl-space-2);
    min-width: 0;
    min-height: 42px;
    padding: 3px var(--fl-space-2) 3px var(--fl-space-1);
    border-radius: 999px;
    color: var(--fl-viewer-text);
    font-size: var(--fl-font-small);
    text-decoration: none;
  }
  .fl-person-link:focus-visible {
    outline: 2px solid var(--fl-accent);
    outline-offset: 2px;
  }
  .fl-person-face {
    display: block;
    flex-shrink: 0;
    width: 32px;
    height: 32px;
  }
  .fl-person-crop {
    background-color: var(--fl-viewer-raised);
    background-repeat: no-repeat;
  }
  .fl-person-name {
    min-width: 0;
    margin: 0;
    overflow: hidden;
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fl-person-age::before {
    content: '· ';
  }
  .fl-person-age {
    flex-shrink: 0;
    margin: 0;
    color: var(--fl-viewer-muted);
    font-size: var(--fl-font-micro);
  }
</style>
