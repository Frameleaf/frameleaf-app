<script lang="ts">
  /**
   * Moments inside videos for a search (FL-59, `REC-101`).
   *
   * A strip above the search results: each hit is a time inside one of the person's own videos,
   * found by meaning against the frame index or by the words of a caption or typed transcript.
   * Choosing one opens the video at that moment instead of at its start. Nothing is shown when
   * there are no hits, so a search without video moments looks exactly as it did.
   */
  import VideoMomentHits from '$lib/components/frameleaf/VideoMomentHits.svelte';
  import { searchVideoMoments, type VideoMomentSearchHitDto } from '@immich/sdk';
  import { t } from 'svelte-i18n';

  let { query }: { query: string } = $props();

  let hits = $state<VideoMomentSearchHitDto[]>([]);
  let requested = '';

  $effect(() => {
    const text = query.trim();
    requested = text;
    if (!text) {
      hits = [];
      return;
    }
    searchVideoMoments({ videoMomentSearchDto: { query: text, limit: 12 } })
      .then((response) => {
        if (requested === text) {
          hits = response.hits;
        }
      })
      .catch(() => {
        // Moments are an addition to the results, never a reason for the search to fail.
        if (requested === text) {
          hits = [];
        }
      });
  });
</script>

{#if hits.length > 0}
  <VideoMomentHits {hits} title={$t('frameleaf_moments_search_title')} />
{/if}
