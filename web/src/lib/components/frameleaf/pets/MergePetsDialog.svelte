<script lang="ts">
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import PetThumbnail from '$lib/components/frameleaf/pets/PetThumbnail.svelte';
  import { filterPetsByName, sortPets } from '$lib/frameleaf/pets';
  import { ICON_SIZE } from '$lib/frameleaf/tokens';
  import type { PetResponseDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiArrowRight, mdiCheck, mdiPawOutline, mdiSetMerge } from '@mdi/js';
  import { t } from 'svelte-i18n';

  /**
   * "Merge into…" for pets, in the shape of `people/MergePeopleDialog.svelte` so the two sibling
   * screens merge the same way: a before-and-after preview with both photos, a search field and a
   * list to pick the pet that is kept. The caller performs the merge; the dialog stays open until
   * `onMerge` says it worked.
   */
  interface Props {
    pet: PetResponseDto;
    /** Every other pet the owner has, hidden ones included. */
    candidates: PetResponseDto[];
    open?: boolean;
    /** Merge `pet` into the chosen pet. Resolves true when it is done. */
    onMerge: (target: PetResponseDto) => Promise<boolean>;
  }

  let { pet, candidates, open = $bindable(false), onMerge }: Props = $props();

  let query = $state('');
  let choice = $state<string | null>(null);
  let busy = $state(false);

  const nameOf = (candidate: { name: string }) => candidate.name || $t('frameleaf_pets_unnamed');
  const countOf = (candidate: PetResponseDto) =>
    $t('frameleaf_pets_confirmed_photos', { values: { count: candidate.assetCount } });
  const rows = $derived(sortPets(filterPetsByName(candidates, query)).filter(({ id }) => id !== pet.id));
  const target = $derived(candidates.find(({ id }) => id === choice && id !== pet.id) ?? null);

  $effect(() => {
    if (!open) {
      return;
    }
    query = '';
    choice = null;
  });

  const merge = async () => {
    if (!target || busy) {
      return;
    }
    busy = true;
    try {
      if (await onMerge(target)) {
        open = false;
      }
    } finally {
      busy = false;
    }
  };
</script>

<Dialog title={$t('frameleaf_pets_merge_into')} closeLabel={$t('close')} bind:open>
  <div class="preview" aria-live="polite">
    <div class="side">
      <PetThumbnail assetId={pet.featuredAssetId} cacheKey={pet.updatedAt} size={72} />
      <strong>{nameOf(pet)}</strong>
      <span>{countOf(pet)}</span>
    </div>
    <span class="arrow" aria-hidden="true"><Icon icon={mdiArrowRight} size={ICON_SIZE.xl} /></span>
    <div class="side" class:empty={!target}>
      {#if target}
        <PetThumbnail assetId={target.featuredAssetId} cacheKey={target.updatedAt} size={72} />
        <strong>{nameOf(target)}</strong>
        <span>{countOf(target)}</span>
      {:else}
        <span class="placeholder" aria-hidden="true"><Icon icon={mdiPawOutline} size={ICON_SIZE.hero} /></span>
        <strong>{$t('frameleaf_pets_merge_target_placeholder')}</strong>
        <span>{$t('frameleaf_pets_merge_target')}</span>
      {/if}
    </div>
  </div>
  <p class="hint">{$t('frameleaf_pets_merge_prompt', { values: { name: nameOf(pet) } })}</p>
  <input
    type="search"
    class="search"
    aria-label={$t('frameleaf_pets_search_placeholder')}
    placeholder={$t('frameleaf_pets_search_placeholder')}
    bind:value={query}
    data-initial-focus
  />
  <ul class="list" aria-label={$t('frameleaf_pets_merge_target')}>
    {#each rows as candidate (candidate.id)}
      <li>
        <button type="button" aria-pressed={candidate.id === choice} onclick={() => (choice = candidate.id)}>
          <PetThumbnail assetId={candidate.featuredAssetId} cacheKey={candidate.updatedAt} size={40} />
          <span class="name" class:unnamed={!candidate.name}>{nameOf(candidate)}</span>
          <span class="count">{countOf(candidate)}</span>
          {#if candidate.id === choice}
            <Icon icon={mdiCheck} size={ICON_SIZE.lg} aria-hidden="true" />
          {/if}
        </button>
      </li>
    {:else}
      <li class="none">{$t('frameleaf_pets_no_matches')}</li>
    {/each}
  </ul>
  {#snippet actions()}
    <Button onclick={() => (open = false)}>{$t('cancel')}</Button>
    <Button variant="primary" disabled={!target || busy} onclick={merge}>
      <Icon icon={mdiSetMerge} size={ICON_SIZE.lg} aria-hidden="true" />
      {$t('frameleaf_pets_merge_confirm')}
    </Button>
  {/snippet}
</Dialog>

<style>
  /* The same layout as people/MergePeopleDialog.svelte (people.css `.pp-merge-*`). */
  .preview {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    gap: var(--fl-space-3);
    padding: var(--fl-space-4);
    margin-bottom: var(--fl-space-4);
    background: var(--fl-raised);
    border-radius: var(--fl-radius-card);
  }
  .side {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    min-width: 0;
    text-align: center;
  }
  .side strong {
    max-width: 100%;
    overflow: hidden;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .side span {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .side.empty strong {
    color: var(--fl-muted);
    font-weight: 500;
  }
  .arrow {
    display: inline-flex;
    color: var(--fl-muted);
  }
  .side .placeholder {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 72px;
    height: 72px;
    color: var(--fl-muted);
    border: 1px dashed var(--fl-border);
    border-radius: 50%;
  }
  .hint {
    margin: 0 0 var(--fl-space-4);
    color: var(--fl-muted);
    line-height: 1.5;
  }
  .search {
    width: 100%;
    min-height: var(--fl-control-height);
    margin-bottom: 10px;
    padding: 0 var(--fl-space-3);
    color: var(--fl-text);
    font-size: var(--fl-font-size);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: var(--fl-space-1);
    max-height: 300px;
    margin: 0;
    padding: 0;
    overflow: auto;
    list-style: none;
  }
  .list button {
    display: flex;
    align-items: center;
    gap: var(--fl-space-3);
    width: 100%;
    min-height: 52px;
    padding: 6px 10px;
    color: var(--fl-text);
    text-align: start;
    background: none;
    border: 1px solid transparent;
    border-radius: var(--fl-radius-control);
  }
  .list button:hover {
    background: var(--fl-raised);
  }
  .list button[aria-pressed='true'] {
    background: var(--fl-accent-soft);
    border-color: var(--fl-accent);
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .name.unnamed {
    color: var(--fl-muted);
    font-style: italic;
  }
  .count {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .none {
    padding: var(--fl-space-4);
    color: var(--fl-muted);
    text-align: center;
  }
  @media (max-width: 700px) {
    .preview {
      gap: var(--fl-space-2);
      padding: var(--fl-space-3);
    }
  }
</style>
