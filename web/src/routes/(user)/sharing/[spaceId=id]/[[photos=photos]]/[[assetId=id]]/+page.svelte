<script lang="ts">
  import { afterNavigate, beforeNavigate, invalidate } from '$app/navigation';
  import SharedSpaceDetail from '$lib/components/frameleaf/SharedSpaceDetail.svelte';
  import Theme from '$lib/components/frameleaf/Theme.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import UserSidebar from '$lib/components/shared-components/side-bar/UserSidebar.svelte';
  import { isEnteringViewer, isLeavingViewer } from '$lib/frameleaf/space-viewer';
  import { Theme as AppTheme, themeManager } from '@immich/ui';
  import { tick } from 'svelte';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  // Membership changes re-run this route's loader, the pattern the shared
  // spaces workspace and the Albums page both use.
  const refresh = () => invalidate('space:data');

  /*
   * The space's viewer is this same page with an item in the address, so the page, its open panel
   * and everything it has loaded stay put underneath. What does not survive is the scroll position:
   * the page is hidden while the viewer is open, and a hidden scroller forgets where it was. So it is
   * remembered on the way in and put back on the way out, and the last item looked at is brought
   * into view if paging through the viewer went past what was on screen.
   */
  let scroller: HTMLElement | undefined;
  let savedTop = 0;

  const captureScroller = (node: HTMLElement) => {
    scroller = node;
    return {
      destroy() {
        if (scroller === node) {
          scroller = undefined;
        }
      },
    };
  };

  const restoreScroll = (lastAssetId: string | undefined) => {
    if (!scroller) {
      return;
    }
    scroller.scrollTop = savedTop;
    if (!lastAssetId) {
      return;
    }
    const tile = scroller.querySelector<HTMLElement>(`[data-asset-id="${CSS.escape(lastAssetId)}"]`);
    if (!tile) {
      return;
    }
    const view = scroller.getBoundingClientRect();
    const box = tile.getBoundingClientRect();
    if (box.top < view.top || box.bottom > view.bottom) {
      tile.scrollIntoView({ block: 'center' });
    }
  };

  const sameSpace = (
    from: { params?: Record<string, string> | null } | null,
    to: { params?: Record<string, string> | null } | null,
  ) => !!from?.params?.spaceId && from.params.spaceId === to?.params?.spaceId;

  beforeNavigate(({ from, to }) => {
    if (scroller && sameSpace(from, to) && isEnteringViewer(from, to)) {
      savedTop = scroller.scrollTop;
    }
  });

  afterNavigate(({ from, to }) => {
    if (!sameSpace(from, to) || !isLeavingViewer(from, to)) {
      return;
    }
    const lastAssetId = from?.params?.assetId;
    void tick().then(() => requestAnimationFrame(() => restoreScroll(lastAssetId)));
  });
</script>

<UserPageLayout use={[captureScroller]}>
  {#snippet sidebar()}
    <UserSidebar />
  {/snippet}

  <Theme theme={themeManager.value === AppTheme.Dark ? 'dark' : 'light'}>
    <SharedSpaceDetail
      space={data.space}
      members={data.members}
      albums={data.albums}
      linkedAlbums={data.linkedAlbums}
      people={data.people}
      newSince={data.newSince}
      activity={data.activity}
      onRefresh={refresh}
    />
  </Theme>
</UserPageLayout>
