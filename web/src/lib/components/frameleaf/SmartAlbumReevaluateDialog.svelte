<script lang="ts">
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import RuleChips from '$lib/components/frameleaf/RuleChips.svelte';
  import Status from '$lib/components/frameleaf/Status.svelte';
  import { fromResponse } from '$lib/frameleaf/classification-rules';
  import type { RuleSources } from '$lib/frameleaf/classification-sources';
  import { getAssetMediaUrl } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import {
    applyClassificationRule,
    AssetMediaSize,
    ClassificationRuleAction,
    createBulkMediaOperation,
    MediaOperationBulkAction,
    planClassificationRule,
    type ClassificationPlanResponseDto,
    type ClassificationRuleResponseDto,
  } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiMinus, mdiPlus, mdiRefresh } from '@mdi/js';
  import { t } from 'svelte-i18n';

  /**
   * Re-evaluate a smart album (FL-60), ported from `ReevaluateDialog` in `CollectionHeader.jsx`.
   *
   * Opening it asks the server for a plan, which writes nothing: what matches now, what would be
   * added (or suggested, for a review rule) and what the rule applied that no longer matches. Manual
   * decisions are never in the plan. Apply changes up to 500 items at once; a larger plan runs as a
   * durable bulk job whose progress shows in Activity.
   */
  interface Props {
    rule: ClassificationRuleResponseDto;
    sources: RuleSources;
    open?: boolean;
    onApplied: (message: string) => void;
  }

  let { rule, sources, open = $bindable(false), onApplied }: Props = $props();

  let plan = $state<ClassificationPlanResponseDto | undefined>();
  let error = $state('');
  let busy = $state(false);

  $effect(() => {
    if (!open) {
      return;
    }
    plan = undefined;
    error = '';
    void planClassificationRule({ id: rule.id })
      .then((result) => (plan = result))
      .catch((error_) => {
        error = $t('frameleaf_rules_plan_failed');
        handleError(error_, $t('frameleaf_rules_plan_failed'));
      });
  });

  const suggests = $derived(rule.action === ClassificationRuleAction.Review);

  const apply = async () => {
    if (!plan) {
      return;
    }
    busy = true;
    try {
      if (plan.durable) {
        await createBulkMediaOperation({
          mediaOperationBulkCreateDto: {
            action: MediaOperationBulkAction.ApplyClassificationRule,
            assetIds: plan.assetIds,
            payload: { classificationRuleId: rule.id },
            requestId: crypto.randomUUID(),
            submittedTotal: plan.assetIds.length,
            truncated: plan.truncated,
          },
        });
        onApplied($t('frameleaf_rules_applied_durable', { values: { count: plan.assetIds.length } }));
      } else {
        const result = await applyClassificationRule({
          id: rule.id,
          classificationApplyDto: { assetIds: plan.assetIds },
        });
        if (plan.assetIds.length === 0) {
          onApplied($t('frameleaf_rules_up_to_date'));
          open = false;
          return;
        }
        onApplied(
          $t('frameleaf_rules_applied', {
            values: { added: result.added, suggested: result.suggested, removed: result.removed },
          }),
        );
      }
      open = false;
    } catch (error_) {
      handleError(error_, $t('frameleaf_rules_apply_failed'));
    } finally {
      busy = false;
    }
  };
</script>

<Dialog title={$t('frameleaf_rules_reevaluate_title')} closeLabel={$t('close')} bind:open>
  <div class="body">
    <RuleChips rule={fromResponse(rule)} people={sources.people} tags={sources.tags} />
    {#if error}
      <Status message={error} />
    {:else if !plan}
      <Status message={$t('frameleaf_rules_plan_loading')} busy />
    {:else}
      <p class="lead">
        <strong>{$t('frameleaf_rules_item_count', { values: { count: plan.matched } })}</strong>
        {$t('frameleaf_rules_match_right_now')}
      </p>
      <ul class="diff">
        <li>
          <Icon icon={mdiPlus} size="16" />
          {suggests
            ? $t('frameleaf_rules_would_suggest', { values: { count: plan.added } })
            : $t('frameleaf_rules_would_add', { values: { count: plan.added } })}
        </li>
        <li>
          <Icon icon={mdiMinus} size="16" />
          {$t('frameleaf_rules_no_longer_match', { values: { count: plan.removed } })}
        </li>
      </ul>
      {#if plan.items.length > 0}
        <div class="thumbs" aria-label={$t('frameleaf_rules_new_matches')}>
          {#each plan.items.slice(0, 8) as item (item.assetId)}
            <img src={getAssetMediaUrl({ id: item.assetId, size: AssetMediaSize.Thumbnail })} alt="" loading="lazy" />
          {/each}
        </div>
      {/if}
      {#if plan.added === 0 && plan.removed === 0}
        <p class="muted">{$t('frameleaf_rules_already_up_to_date')}</p>
      {/if}
      {#if plan.durable}
        <p class="muted">{$t('frameleaf_rules_durable_note', { values: { count: plan.assetIds.length } })}</p>
      {/if}
    {/if}
    <div class="buttons">
      <button type="button" onclick={() => (open = false)} disabled={busy}>{$t('cancel')}</button>
      <button type="button" class="primary" disabled={busy || !plan} onclick={() => void apply()}>
        <Icon icon={mdiRefresh} size="16" />
        {$t('frameleaf_rules_apply')}
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
    width: min(32rem, 100%);
  }
  .lead {
    margin: 0.5rem 0 0;
  }
  .diff {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .diff li {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .thumbs {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .thumbs img {
    width: 64px;
    height: 64px;
    object-fit: cover;
    border-radius: var(--fl-radius-control);
  }
  .muted {
    margin: 0;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
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
  .buttons button {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
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
