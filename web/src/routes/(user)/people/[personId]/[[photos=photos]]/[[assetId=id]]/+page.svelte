<script lang="ts">
  import { afterNavigate, goto, invalidateAll } from '$app/navigation';
  import { page } from '$app/stores';
  import { scrollMemoryClearer } from '$lib/actions/scroll-memory';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import LibraryView from '$lib/components/frameleaf/LibraryView.svelte';
  import PersonHero from '$lib/components/frameleaf/people/PersonHero.svelte';
  import TimelineAssetViewer from '$lib/components/timeline/TimelineAssetViewer.svelte';
  import { OpenQueryParam, QueryParameter } from '$lib/constants';
  import Portal from '$lib/elements/Portal.svelte';
  import { namedArchiveName } from '$lib/frameleaf/archive-name';
  import { librarySession } from '$lib/frameleaf/library-session.svelte';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
  import { Route } from '$lib/route';
  import { navigate } from '$lib/utils/navigation';
  import { AssetVisibility, type PersonResponseDto } from '@immich/sdk';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  /**
   * The person page (FL-37): the Frameleaf hero (`PersonHero`, ported from `PersonHeader` in
   * design/frameleaf/template/src/PersonDetail.jsx) above the person's timeline. Every person
   * action lives in the hero and its Frameleaf dialogs; the legacy select-featured-photo page
   * mode, full-screen merge selector, name input and unmerge selector are gone.
   */

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  let statistics = $derived(data.statistics);
  let person = $derived(data.person);

  let timelineManager = $state<TimelineManager>() as TimelineManager;
  let viewerInvisible = $state(false);
  const options = $derived({ visibility: AssetVisibility.Timeline, personId: data.person.id, withPartners: true });

  let previousRoute = $state<string>(Route.explore());
  let refresh = $state(0);

  onMount(() => {
    const fallbackRoute = $page.params.assetId ? Route.viewPerson(data.person) : Route.explore();
    previousRoute = Route.continue($page.url.searchParams.get(QueryParameter.PREVIOUS_ROUTE), fallbackRoute).toString();
  });

  afterNavigate(({ from }) => {
    // Prevent setting previousRoute to the current page.
    if (from?.url && from.route.id !== $page.route.id) {
      previousRoute = from.url.href;
    }
  });

  const handleEscape = async () => {
    if (librarySession.selection.length > 0) {
      librarySession.clearSelection();
      return;
    }
    await goto(previousRoute);
  };

  const updateAssetCount = async () => {
    await invalidateAll();
  };

  const onPersonUpdate = (response: PersonResponseDto) => {
    if (response.id !== person.id) {
      return;
    }
    person = response;
  };

  // A new featured photo is cut into the person thumbnail by a job; the avatar re-reads it once ready.
  const onPersonThumbnailReady = ({ id }: { id: string }) => {
    if (id === person.id) {
      person = { ...person, updatedAt: new Date().toISOString() };
    }
  };

  // Faces moved to this person from elsewhere (a merge into them, a face reassigned in the viewer):
  // re-read the count and the photos. The hero's own changes already do this through `onFacesChanged`.
  const onPersonFacesChange = ({
    personIds,
    removedPersonIds,
  }: {
    personIds: string[];
    removedPersonIds?: string[];
  }) => {
    if (personIds.includes(person.id) && !removedPersonIds?.includes(person.id)) {
      void updateAssetCount();
    }
  };

  const handlePersonAssetDelete = async ({ id, assetId }: { id: string; assetId: string }) => {
    if (id !== person.id) {
      return;
    }
    timelineManager.removeAssets([assetId]);
    await updateAssetCount();
  };
</script>

<OnEvents
  {onPersonUpdate}
  {onPersonThumbnailReady}
  {onPersonFacesChange}
  onPersonAssetDelete={handlePersonAssetDelete}
  onAssetsDelete={updateAssetCount}
  onAssetsArchive={updateAssetCount}
  onAssetsUnarchive={updateAssetCount}
/>

<main
  class="relative z-0 h-dvh overflow-hidden px-2 pt-(--navbar-height) md:px-6 md:pt-(--navbar-height-md)"
  use:scrollMemoryClearer={{ routeStartsWith: Route.people() }}
>
  {#key `${person.id}:${refresh}`}
    <LibraryView
      enableRouting
      selectAll="loaded"
      bind:timelineManager
      {options}
      destination={{ kind: 'person', id: person.id }}
      downloadFileName={namedArchiveName(person.name, $t('frameleaf_archive_name_person'))}
      onOpen={(asset) => void navigate({ targetRoute: 'current', assetId: asset.id })}
      onShortcut={(shortcut) => {
        // Escape with nothing open and nothing selected leaves the person, as it did before.
        if (shortcut.id === 'close') {
          void handleEscape();
        }
      }}
    >
      <PersonHero
        {person}
        {statistics}
        onBack={() => goto(previousRoute)}
        onPersonChange={(updated) => (person = updated)}
        onMergedAway={(target) => goto(Route.viewPerson(target), { replaceState: true })}
        onFacesChanged={async () => {
          // Photos whose only face of this person moved away leave the timeline: re-read both.
          await updateAssetCount();
          refresh++;
        }}
        onOpenAsset={(assetId) => void navigate({ targetRoute: 'current', assetId })}
        onOpenRecognitionGroups={() => goto(Route.userSettings({ isOpen: OpenQueryParam.SHARING }))}
      />

      {#snippet viewer()}
        <Portal target="body">
          {#if assetViewerManager.isViewing}
            <TimelineAssetViewer bind:invisible={viewerInvisible} {timelineManager} {person} />
          {/if}
        </Portal>
      {/snippet}
    </LibraryView>
  {/key}
</main>
