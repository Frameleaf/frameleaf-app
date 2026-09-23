<script lang="ts">
  import ImageThumbnail from '$lib/components/assets/thumbnail/ImageThumbnail.svelte';
  import PersonFaceActions from '$lib/components/frameleaf/PersonFaceActions.svelte';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Route } from '$lib/route';
  import { faceManager } from '$lib/stores/face.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { getPeopleThumbnailUrl } from '$lib/utils';
  import { type AssetResponseDto } from '@immich/sdk';
  import { Button, IconButton, Text } from '@immich/ui';
  import { mdiEye, mdiEyeOff, mdiPencil, mdiPlus } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { t } from 'svelte-i18n';

  type Props = {
    asset: AssetResponseDto;
    isOwner: boolean;
    previousRoute: string;
    /**
     * FL-38: re-reads the asset and its faces from the server after an inline reassign,
     * create-person, remove or hide action lands. `DetailPanel.svelte` passes its existing
     * `handleRefreshPeople`, the same refresh the full "Edit people" panel already uses.
     */
    onFacesChanged: () => void | Promise<void>;
  };

  const { asset, isOwner, previousRoute, onFacesChanged }: Props = $props();

  const people = $derived(Array.from(faceManager.people));
  const hiddenCount = $derived(people.filter((person) => person.isHidden).length);
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

{#if !authManager.isSharedLink}
  <section class="px-4 pt-4 text-sm">
    {#if isOwner || visiblePeople.length > 0}
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

            {#if faceManager.data.length > 0}
              <IconButton
                aria-label={$t('edit_people')}
                icon={mdiPencil}
                size="medium"
                shape="round"
                color="secondary"
                variant="ghost"
                onclick={() => assetViewerManager.openEditFacesPanel()}
              />
            {/if}
          {/if}
        </div>
      </div>
      {#if visiblePeople.length === 0}
        <Text size="small" color="muted">{$t('frameleaf_viewer_no_people')}</Text>
      {/if}
    {/if}

    <div class="mt-2 grid {visiblePeople.length <= 6 ? 'grid-cols-3 gap-3' : 'grid-cols-4 gap-2'}">
      {#each visiblePeople as person (person.id)}
        {@const personFaces = faceManager.facesByPersonId.get(person.id) ?? []}
        {@const primaryFace = personFaces[0]}
        {@const isHighlighted = personFaces.some((f) => assetViewerManager.highlightedFaces.some((b) => b.id === f.id))}
        <div class="relative">
          <a
            class="group outline-none"
            href={Route.viewPerson(person, { previousRoute })}
            onfocus={() => assetViewerManager.setHighlightedFaces(personFaces)}
            onblur={() => assetViewerManager.clearHighlightedFaces()}
            onpointerenter={() => assetViewerManager.setHighlightedFaces(personFaces)}
            onpointerleave={() => assetViewerManager.clearHighlightedFaces()}
          >
            <ImageThumbnail
              curve
              shadow
              url={getPeopleThumbnailUrl(person)}
              altText={person.name}
              title={person.name}
              widthStyle="100%"
              hidden={person.isHidden}
              highlighted={isHighlighted}
              class="outline-offset-2 outline-immich-primary group-focus-visible:outline-2 dark:outline-immich-dark-primary"
            />
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
    </div>
  </section>
{/if}
