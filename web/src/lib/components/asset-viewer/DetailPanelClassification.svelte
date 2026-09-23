<script lang="ts">
  /**
   * Which of the owner's smart album rules touched this item (FL-60): the smart album it put the item
   * in, the tag it added and whether it archived it, so a person can see why an item is where it is
   * and undo it from the album. Only the owner's own rules are ever returned.
   */
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Route } from '$lib/route';
  import {
    ClassificationMatchDecision,
    getAssetClassifications,
    type AssetResponseDto,
    type ClassificationContributionDto,
  } from '@immich/sdk';
  import { Icon, Text } from '@immich/ui';
  import { mdiAutoFix } from '@mdi/js';
  import { t } from 'svelte-i18n';

  interface Props {
    asset: AssetResponseDto;
    isOwner: boolean;
  }

  let { asset, isOwner }: Props = $props();

  let contributions = $state<ClassificationContributionDto[]>([]);

  $effect(() => {
    const id = asset.id;
    // Tags change when a rule applies; refetch with them.
    void asset.tags;
    if (!isOwner || authManager.isSharedLink) {
      contributions = [];
      return;
    }
    let current = true;
    void getAssetClassifications({ id })
      .then((result) => {
        if (current) {
          contributions = result;
        }
      })
      .catch(() => {
        if (current) {
          contributions = [];
        }
      });
    return () => {
      current = false;
    };
  });

  const detail = (item: ClassificationContributionDto) =>
    [
      item.decision === ClassificationMatchDecision.Suggested
        ? $t('frameleaf_rules_contribution_suggested')
        : item.decision === ClassificationMatchDecision.Accepted
          ? $t('frameleaf_rules_contribution_kept')
          : $t('frameleaf_rules_contribution_matched'),
      item.tag ? $t('frameleaf_rules_contribution_tag', { values: { tag: item.tag.name } }) : null,
      item.archived ? $t('frameleaf_rules_contribution_archived') : null,
    ]
      .filter(Boolean)
      .join(' · ');
</script>

{#if contributions.length > 0}
  <section class="mt-4 px-4" data-testid="detail-panel-classification">
    <div class="flex h-10 w-full items-center text-sm">
      <Text color="muted">{$t('frameleaf_rules_contributions')}</Text>
    </div>
    <ul class="flex flex-col gap-2 text-sm">
      {#each contributions as item (item.ruleId)}
        <li class="flex items-start gap-2">
          <span class="pt-0.5 opacity-70"><Icon icon={mdiAutoFix} size="16" /></span>
          <span class="flex flex-col">
            <a class="font-medium hover:underline" href={Route.viewAlbum({ id: item.albumId })}>{item.albumName}</a>
            <span class="text-xs opacity-70">{detail(item)}</span>
          </span>
        </li>
      {/each}
    </ul>
  </section>
{/if}
