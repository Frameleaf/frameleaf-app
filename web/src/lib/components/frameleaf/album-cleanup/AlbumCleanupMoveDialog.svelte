<script lang="ts">
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import type { PlanNode } from '$lib/frameleaf/album-cleanup';
  import { Icon } from '@frameleaf/ui';
  import { mdiFolderMultipleOutline, mdiMagnify } from '@mdi/js';
  import { t } from 'svelte-i18n';

  /** "Move into…": pick a collection in the proposed structure. Searching finds any of them. */
  interface Props {
    node: PlanNode;
    structure: PlanNode[];
    open?: boolean;
    onPick: (target: string) => void;
  }

  const MAX_ROWS = 60;

  let { node, structure, open = $bindable(false), onPick }: Props = $props();

  let query = $state('');

  const options = $derived.by(() => {
    const out: { item: PlanNode; depth: number }[] = [];
    const walk = (list: PlanNode[], depth: number) => {
      for (const item of list) {
        if (item.kind !== 'collection' || item.id === node.id) {
          continue;
        }
        out.push({ item, depth });
        if (depth < 1) {
          walk(item.children, depth + 1);
        }
      }
    };
    walk(structure, 0);
    return out;
  });
  const needle = $derived(query.trim().toLowerCase());
  const shown = $derived(options.filter(({ item }) => !needle || item.name.toLowerCase().includes(needle)).slice(0, MAX_ROWS));
</script>

<Dialog title={$t('frameleaf_album_cleanup_move_title', { values: { name: node.name } })} closeLabel={$t('close')} bind:open>
  <label class="ac-search wide">
    <Icon icon={mdiMagnify} size="17" aria-hidden={true} />
    <input
      type="search"
      data-initial-focus
      bind:value={query}
      placeholder={$t('frameleaf_album_cleanup_search_collections')}
      aria-label={$t('frameleaf_album_cleanup_search_collections')}
      autocomplete="off"
    />
  </label>
  <ul class="ac-picker">
    {#each shown as { item, depth } (item.id)}
      <li>
        <button type="button" style={`--depth: ${depth}`} onclick={() => onPick(item.id)}>
          <Icon icon={mdiFolderMultipleOutline} size="18" aria-hidden={true} />
          <span>{item.name}</span>
          <small>{$t('frameleaf_album_cleanup_album_count', { values: { count: item.albumCount } })}</small>
        </button>
      </li>
    {:else}
      <li class="ac-empty">{$t('frameleaf_album_cleanup_no_groups')}</li>
    {/each}
  </ul>
  {#snippet actions()}
    <Button onclick={() => (open = false)}>{$t('cancel')}</Button>
  {/snippet}
</Dialog>
