<script lang="ts">
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import Status from '$lib/components/frameleaf/Status.svelte';
  import { getAssetMediaUrl } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import {
    AssetMediaSize,
    ClassificationMatchDecision,
    ClassificationReviewDecision,
    decideClassificationRuleMatches,
    getClassificationRuleMatches,
    type ClassificationMatchDto,
    type ClassificationRuleResponseDto,
  } from '@immich/sdk';
  import { t } from 'svelte-i18n';

  /**
   * Review a smart album rule's suggestions (FL-60). Accepted items join the album (with the rule's
   * tag and, when the rule archives, the archive) and stay whatever later processing finds; rejected
   * ones never come back. Nothing changes until the person decides.
   */
  interface Props {
    rule: ClassificationRuleResponseDto;
    open?: boolean;
    onDecided: (message: string) => void;
  }

  let { rule, open = $bindable(false), onDecided }: Props = $props();

  const PAGE = 60;
  let items = $state<ClassificationMatchDto[]>([]);
  let total = $state(0);
  let selected = $state<Set<string>>(new Set());
  let loading = $state(false);
  let busy = $state(false);

  const load = async () => {
    loading = true;
    try {
      const page = await getClassificationRuleMatches({
        id: rule.id,
        decision: ClassificationMatchDecision.Suggested,
        page: 1,
        size: PAGE,
      });
      items = page.items;
      total = page.total;
      selected = new Set(page.items.map(({ assetId }) => assetId));
    } catch (error) {
      handleError(error, $t('frameleaf_rules_review_failed'));
    } finally {
      loading = false;
    }
  };

  $effect(() => {
    if (open) {
      void load();
    }
  });

  const toggle = (assetId: string) => {
    const next = new Set(selected);
    if (next.has(assetId)) {
      next.delete(assetId);
    } else {
      next.add(assetId);
    }
    selected = next;
  };

  const decide = async (decision: ClassificationReviewDecision) => {
    const assetIds = [...selected];
    if (assetIds.length === 0) {
      return;
    }
    busy = true;
    try {
      const result = await decideClassificationRuleMatches({
        id: rule.id,
        classificationDecisionDto: { assetIds, decision },
      });
      onDecided(
        decision === ClassificationReviewDecision.Accepted
          ? $t('frameleaf_rules_accepted', { values: { count: result.updated } })
          : $t('frameleaf_rules_rejected', { values: { count: result.updated } }),
      );
      await load();
      if (total === 0) {
        open = false;
      }
    } catch (error) {
      handleError(error, $t('frameleaf_rules_review_failed'));
    } finally {
      busy = false;
    }
  };
</script>

<Dialog
  title={$t('frameleaf_rules_review_title', { values: { name: rule.albumName } })}
  closeLabel={$t('close')}
  wide
  bind:open
>
  <div class="body">
    {#if loading && items.length === 0}
      <Status message={$t('frameleaf_rules_review_loading')} busy />
    {:else if total === 0}
      <p class="muted">{$t('frameleaf_rules_review_empty')}</p>
    {:else}
      <p class="muted">
        {$t('frameleaf_rules_review_summary', { values: { count: total, shown: items.length } })}
      </p>
      <ul class="grid">
        {#each items as item (item.assetId)}
          {@const on = selected.has(item.assetId)}
          <li>
            <label class:on>
              <input type="checkbox" checked={on} onchange={() => toggle(item.assetId)} />
              <img src={getAssetMediaUrl({ id: item.assetId, size: AssetMediaSize.Thumbnail })} alt="" loading="lazy" />
              {#if item.score !== null && item.score !== undefined}
                <span class="score">{Math.round(item.score * 100)}%</span>
              {/if}
            </label>
          </li>
        {/each}
      </ul>
    {/if}
    <div class="buttons">
      <button type="button" onclick={() => (open = false)} disabled={busy}>{$t('close')}</button>
      <button
        type="button"
        disabled={busy || selected.size === 0}
        onclick={() => void decide(ClassificationReviewDecision.Rejected)}
      >
        {$t('frameleaf_rules_reject_selected', { values: { count: selected.size } })}
      </button>
      <button
        type="button"
        class="primary"
        disabled={busy || selected.size === 0}
        onclick={() => void decide(ClassificationReviewDecision.Accepted)}
      >
        {$t('frameleaf_rules_accept_selected', { values: { count: selected.size } })}
      </button>
    </div>
  </div>
</Dialog>

<style>
  .body {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin-block-start: 1rem;
    width: min(48rem, 100%);
  }
  .muted {
    margin: 0;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
    max-height: 60vh;
    overflow: auto;
  }
  label {
    position: relative;
    display: block;
    border: 2px solid transparent;
    border-radius: var(--fl-radius-control);
    cursor: pointer;
  }
  label.on {
    border-color: var(--fl-accent);
  }
  label:has(input:focus-visible) {
    outline: 2px solid var(--fl-accent);
    outline-offset: 2px;
  }
  input {
    position: absolute;
    top: 6px;
    left: 6px;
    accent-color: var(--fl-accent);
  }
  img {
    display: block;
    width: 100%;
    aspect-ratio: 1;
    object-fit: cover;
    border-radius: var(--fl-radius-control);
  }
  .score {
    position: absolute;
    right: 4px;
    bottom: 4px;
    padding: 0 6px;
    border-radius: var(--fl-radius-pill);
    background: var(--fl-panel);
    font-size: var(--fl-font-micro);
  }
  .buttons {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }
  .buttons button {
    padding: 0.375rem 1rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    background: var(--fl-raised);
    color: var(--fl-text);
  }
  .buttons .primary {
    background: var(--fl-accent);
    border-color: var(--fl-accent);
    color: var(--fl-accent-text);
  }
  .buttons button:disabled {
    opacity: 0.6;
  }
</style>
