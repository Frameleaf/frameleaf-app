<script lang="ts">
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import RuleBuilder from '$lib/components/frameleaf/RuleBuilder.svelte';
  import Status from '$lib/components/frameleaf/Status.svelte';
  import { fromResponse, ruleProblem, toUpdate, type RuleDraft } from '$lib/frameleaf/classification-rules';
  import type { RuleSources } from '$lib/frameleaf/classification-sources';
  import { handleError } from '$lib/utils/handle-error';
  import { deleteClassificationRule, updateClassificationRule, type ClassificationRuleResponseDto } from '@immich/sdk';
  import { t } from 'svelte-i18n';

  /**
   * Edit a smart album's rule (FL-60): the design's edit dialog with the Smart album switch and rule
   * builder. Saving changes nothing in the library; re-evaluating applies the rule. Turning the rule
   * off keeps everything it applied. Turning Smart album off removes the rule and leaves an ordinary
   * album with everything still in it.
   */
  interface Props {
    rule: ClassificationRuleResponseDto;
    sources: RuleSources;
    open?: boolean;
    onSaved: (rule: ClassificationRuleResponseDto | null, message: string) => void;
  }

  let { rule, sources, open = $bindable(false), onSaved }: Props = $props();

  let draft = $state<RuleDraft>(fromResponse(rule));
  let smart = $state(true);
  let busy = $state(false);
  let error = $state('');

  $effect(() => {
    if (!open) {
      return;
    }

    draft = fromResponse(rule);
    smart = true;
    error = '';
  });

  const save = async (event: SubmitEvent) => {
    event.preventDefault();
    busy = true;
    error = '';
    try {
      if (!smart) {
        await deleteClassificationRule({ id: rule.id });
        onSaved(null, $t('frameleaf_rules_removed'));
        open = false;
        return;
      }
      const problem = ruleProblem(draft);
      if (problem) {
        error = $t(problem);
        return;
      }
      const updated = await updateClassificationRule({
        id: rule.id,
        classificationRuleUpdateDto: toUpdate(draft, rule),
      });
      onSaved(updated, $t('frameleaf_rules_saved'));
      open = false;
    } catch (error_) {
      handleError(error_, $t('frameleaf_rules_save_failed'));
    } finally {
      busy = false;
    }
  };
</script>

<Dialog
  title={$t('frameleaf_rules_edit_title', { values: { name: rule.albumName } })}
  closeLabel={$t('close')}
  wide
  bind:open
>
  <form class="form" onsubmit={save}>
    <label class="switch">
      <input type="checkbox" role="switch" bind:checked={smart} />
      <span>{$t('frameleaf_albums_smart_mark')}</span>
      <small>{smart ? $t('frameleaf_rules_smart_help') : $t('frameleaf_rules_smart_off_help')}</small>
    </label>
    {#if smart}
      <label class="switch">
        <input
          type="checkbox"
          role="switch"
          checked={draft.enabled}
          onchange={(event) => (draft = { ...draft, enabled: event.currentTarget.checked })}
        />
        <span>{$t('frameleaf_rules_enabled')}</span>
        <small>{$t('frameleaf_rules_enabled_help')}</small>
      </label>
      <RuleBuilder
        rule={draft}
        people={sources.people}
        tags={sources.tags}
        settings={sources.settings}
        onChange={(next) => (draft = next)}
      />
    {/if}
    {#if error}
      <Status message={error} />
    {/if}
    <div class="buttons">
      <button type="button" onclick={() => (open = false)} disabled={busy}>{$t('cancel')}</button>
      <button type="submit" class="primary" disabled={busy}>{$t('save')}</button>
    </div>
  </form>
</Dialog>

<style>
  .form {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin-block-start: 1rem;
    width: min(44rem, calc(100vw - 4rem));
  }
  .switch {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 4px 10px;
    align-items: center;
    cursor: pointer;
  }
  .switch small {
    grid-column: 2;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .switch input {
    width: 18px;
    height: 18px;
    margin: 0;
    accent-color: var(--fl-accent);
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
