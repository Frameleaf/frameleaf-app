<script lang="ts">
  import type { TimelineManagerOptions } from '$lib/managers/timeline-manager/types';
  import ArchiveOperationsModal from '$lib/modals/ArchiveOperationsModal.svelte';
  import {
    type ArchiveOperationPrepareDto,
    AssetOrder,
    AssetOrderBy,
    TimeBucketDateType,
    ArchiveTimelineScope,
    ArchiveTimelineVisibility,
  } from '@immich/sdk';
  import { Button, modalManager } from '@immich/ui';
  import { t } from 'svelte-i18n';

  // Structural seam for FL31's route-owned LibraryTimelineQuery; never infer scope from loaded assets.
  let { query }: { query: { scope: { kind: string }; filters: TimelineManagerOptions } } = $props();
  const matchingQuery = (): ArchiveOperationPrepareDto['query'] => {
    const { scope, filters } = query;
    const allowed = new Set(['visibility', 'withStacked', 'withPartners', 'order', 'orderBy', 'dateType']);
    if (
      scope.kind !== 'library' ||
      Object.keys(scope).some((key) => key !== 'kind') ||
      Object.keys(filters).some((key) => !allowed.has(key)) ||
      filters.visibility !== 'timeline' ||
      filters.withStacked !== true
    ) {
      throw new Error('This scope does not support all-matching archive');
    }
    return {
      scope: { kind: ArchiveTimelineScope.Library },
      filters: {
        visibility: ArchiveTimelineVisibility.Timeline,
        withStacked: true,
        withPartners: filters.withPartners ?? false,
        order: filters.order ?? AssetOrder.Desc,
        orderBy: filters.orderBy ?? AssetOrderBy.TakenAt,
        dateType: filters.dateType ?? TimeBucketDateType.Taken,
      },
    };
  };
  const supported = $derived.by(() => {
    try {
      matchingQuery();
      return true;
    } catch {
      return false;
    }
  });
  const open = () => {
    const snapshot = structuredClone(matchingQuery());
    return modalManager.show(ArchiveOperationsModal, {
      matchingQuery: () => snapshot,
      currentMatchingQuery: matchingQuery,
    });
  };
</script>

<Button disabled={!supported} onclick={open}>
  {$t('archive_operations.matching_action')}
</Button>
