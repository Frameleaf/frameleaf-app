<script lang="ts">
  import ImageThumbnail from '$lib/components/assets/thumbnail/ImageThumbnail.svelte';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import PersonFaceActions from '$lib/components/frameleaf/PersonFaceActions.svelte';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Route } from '$lib/route';
  import { faceManager } from '$lib/stores/face.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { getAssetMediaUrl, getPeopleThumbnailUrl } from '$lib/utils';
  import { AssetMediaSize, type AssetFaceResponseDto, type AssetResponseDto } from '@immich/sdk';
  import { Button, Icon, Text } from '@immich/ui';
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

  const people = $derived(Array.from(faceManager.people));
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
  const onPersonFacesChange = () => {
    if (!authManager.isSharedLink) {
      void refreshChips();
    }
  };

  const hiddenCount = $derived(people.filter((person) => person.isHidden).length + hiddenFaces.length);
  const visiblePeople = $derived(
    people
      .filter((p) => assetViewerManager.isShowingHiddenPeople || !p.isHidden)
      .map((person) => {
        if (!person.birthDate) {
          return { formattedBirthDate: undefined, formattedAge: undefined, ...person };
        }
        const personBirthDate = DateTime.fromISO(person.birthDate);
        const ageInYears = Math.floor(DateTime.fromISO(asset.localDateTime).diff(personBirthDate, 'years').years);
        const ageInMonths = Math.floor(DateTime.fromISO(asset.localDateTime).diff(personBirthDate, 'months').months);

        let formattedAge;
        if (ageInYears < 0) {
          return { formattedBirthDate: undefined, formattedAge: undefined, ...person };
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
        return { formattedBirthDate, formattedAge, ...person };
      }),
  );
</script>

<OnEvents {onPersonUpdate} {onPersonFacesChange} />

{#if !authManager.isSharedLink}
  <section class="px-4 pt-4 text-sm">
    {#if isOwner || visiblePeople.length > 0 || unassignedFaces.length > 0}
      <div class="flex h-10 w-full items-center justify-between">
        <Text size="small" color="muted">{$t('people')}</Text>
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

    <div
      class="mt-2 grid {visiblePeople.length + unassignedFaces.length + shownHiddenFaces.length <= 6
        ? 'grid-cols-3 gap-3'
        : 'grid-cols-4 gap-2'}"
    >
      {#each visiblePeople as person (person.id)}
        {@const personFaces = faceManager.facesByPersonId.get(person.id) ?? []}
        {@const primaryFace = personFaces[0]}
        {@const isHighlighted = personFaces.some((f) => assetViewerManager.highlightedFaces.some((b) => b.id === f.id))}
        <div class="relative">
          <!--
            FL-37: people photos in the information panel are squircles (apple-style.css:137-148).
            The mask clips rings and outlines, so the face highlight is a squircle backing behind
            the photo and the focus ring sits on the link.
          -->
          <a
            class="group block rounded-xl outline-offset-2 outline-immich-primary focus-visible:outline-2 dark:outline-immich-dark-primary"
            href={Route.viewPerson(person, { previousRoute })}
            onfocus={() => assetViewerManager.setHighlightedFaces(personFaces)}
            onblur={() => assetViewerManager.clearHighlightedFaces()}
            onpointerenter={() => assetViewerManager.setHighlightedFaces(personFaces)}
            onpointerleave={() => assetViewerManager.clearHighlightedFaces()}
          >
            <span
              class="fl-squircle relative block p-1 {isHighlighted
                ? 'bg-immich-primary dark:bg-immich-dark-primary'
                : ''}"
              data-highlighted={isHighlighted || undefined}
            >
              <ImageThumbnail
                url={getPeopleThumbnailUrl(person)}
                altText={person.name}
                title={person.name}
                widthStyle="100%"
                hidden={person.isHidden}
                class="fl-squircle"
              />
            </span>
            <p class="mt-1 truncate font-medium" title={person.name}>{person.name}</p>
            {#if person.birthDate && person.formattedAge}
              <p class="font-light {visiblePeople.length > 6 ? 'text-xs' : ''}" title={person.formattedBirthDate!}>
                {person.formattedAge}
              </p>
            {/if}
          </a>
          {#if isOwner && primaryFace}
            <div class="absolute -inset-e-1 -top-1">
              <PersonFaceActions {person} face={primaryFace} {previousRoute} {onFacesChanged} />
            </div>
          {/if}
        </div>
      {/each}
      {#each unassignedFaces as face (face.id)}
        {@const isHighlighted = assetViewerManager.highlightedFaces.some((b) => b.id === face.id)}
        <div
          class="relative"
          data-testid="unassigned-face"
          role="presentation"
          onpointerenter={() => assetViewerManager.setHighlightedFaces([face])}
          onpointerleave={() => assetViewerManager.clearHighlightedFaces()}
          onfocusin={() => assetViewerManager.setHighlightedFaces([face])}
          onfocusout={() => assetViewerManager.clearHighlightedFaces()}
        >
          <div>
            <span
              class="fl-squircle block p-1 {isHighlighted ? 'bg-immich-primary dark:bg-immich-dark-primary' : ''}"
              data-highlighted={isHighlighted || undefined}
            >
              <span
                class="fl-squircle block aspect-square w-full bg-gray-200 bg-no-repeat dark:bg-gray-700"
                style={faceCropStyle(face)}
                aria-hidden="true"
              ></span>
            </span>
            <p class="mt-1 truncate font-medium">{$t('unnamed_person')}</p>
          </div>
          <div class="absolute -inset-e-1 -top-1">
            <PersonFaceActions person={null} {face} {previousRoute} {onFacesChanged} />
          </div>
        </div>
      {/each}
      {#each shownHiddenFaces as face (face.id)}
        {@const isHighlighted = assetViewerManager.highlightedFaces.some((b) => b.id === face.id)}
        {@const label = face.person?.name || $t('unnamed_person')}
        <div
          class="relative"
          data-testid="hidden-face"
          role="presentation"
          onpointerenter={() => assetViewerManager.setHighlightedFaces([face])}
          onpointerleave={() => assetViewerManager.clearHighlightedFaces()}
          onfocusin={() => assetViewerManager.setHighlightedFaces([face])}
          onfocusout={() => assetViewerManager.clearHighlightedFaces()}
        >
          <div class="opacity-60">
            <span
              class="fl-squircle block p-1 {isHighlighted ? 'bg-immich-primary dark:bg-immich-dark-primary' : ''}"
              data-highlighted={isHighlighted || undefined}
            >
              <span
                class="fl-squircle block aspect-square w-full bg-gray-200 bg-no-repeat dark:bg-gray-700"
                style={faceCropStyle(face)}
                aria-hidden="true"
              ></span>
            </span>
            <p class="mt-1 flex items-center gap-1 truncate font-medium" title={label}>
              <span class="truncate">{label}</span>
              <Icon icon={mdiEyeOffOutline} size="13" aria-label={$t('frameleaf_faces_hidden_label')} />
            </p>
          </div>
          <div class="absolute -inset-e-1 -top-1">
            <PersonFaceActions person={face.person} {face} {previousRoute} {onFacesChanged} />
          </div>
        </div>
      {/each}
    </div>
  </section>
{/if}
