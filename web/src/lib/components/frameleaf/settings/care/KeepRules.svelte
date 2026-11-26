<script lang="ts">
  /**
   * Which copy to suggest keeping (FL-832), after `KeepRules` in the approved prototype's
   * `settings-v2/quick-wins.jsx`: the signed-in account's own ordered rules
   * (`duplicates.keepRules`), moved by dragging or with the arrows and saved as they change, beside
   * an example that shows which rule decides. The default order is saved as an empty list, which is
   * what the server reads as "the default".
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import IconButton from '$lib/components/frameleaf/IconButton.svelte';
  import Pill from '$lib/components/frameleaf/settings/kit/Pill.svelte';
  import {
    dropKeepRule,
    isDefaultKeepOrder,
    KEEP_EXAMPLE,
    KEEP_RULE_WORDS,
    keepOrder,
    moveKeepRule,
    suggestKeep,
    type KeepCopy,
  } from '$lib/frameleaf/keep-rules';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import { handleError } from '$lib/utils/handle-error';
  import { updateMyPreferences, type DuplicateKeepRule } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiChevronDown, mdiChevronUp, mdiDragVertical, mdiRestore } from '@mdi/js';
  import { t, type Translations } from 'svelte-i18n';

  const savedOrder = () => keepOrder(authManager.authenticated ? authManager.preferences.duplicates?.keepRules : []);

  let order = $state(savedOrder());
  let dragging: DuplicateKeepRule | undefined = $state();
  let saves = 0;

  const usual = $derived(isDefaultKeepOrder(order));
  const example = $derived(suggestKeep(KEEP_EXAMPLE, order));
  const label = (rule: DuplicateKeepRule) => $t(`frameleaf_keep_rule_${KEEP_RULE_WORDS[rule]}` as Translations);
  const help = (rule: DuplicateKeepRule) => $t(`frameleaf_keep_rule_${KEEP_RULE_WORDS[rule]}_help` as Translations);

  /** Saves the order on screen; of several saves under way, only the last one's answer is kept. */
  const save = async () => {
    const run = ++saves;
    try {
      const preferences = await updateMyPreferences({
        userPreferencesUpdateDto: { duplicates: { keepRules: usual ? [] : order } },
      });
      if (run === saves) {
        authManager.setPreferences(preferences);
      }
    } catch (error) {
      if (run === saves) {
        order = savedOrder();
        handleError(error, $t('frameleaf_keep_save_failed'));
      }
    }
  };

  const set = (next: DuplicateKeepRule[]) => {
    if (next.join(',') !== order.join(',')) {
      order = next;
      void save();
    }
  };

  const facts = (copy: KeepCopy) => [
    `${copy.format} · ${getByteUnitString(copy.bytes, $locale)}`,
    `${copy.width} × ${copy.height}`,
    copy.inAlbum ? $t('frameleaf_keep_fact_album') : $t('frameleaf_keep_fact_no_album'),
    ...(copy.favorite ? [$t('frameleaf_keep_fact_favorite')] : []),
    ...(copy.edited ? [$t('frameleaf_keep_fact_edited')] : []),
  ];
</script>

<div class="keep">
  <div class="heading">
    <div>
      <strong id="keep-rules-title">{$t('frameleaf_keep_title')}</strong>
      <p>{$t('frameleaf_keep_help')}</p>
    </div>
    <Button disabled={usual} onclick={() => set(keepOrder())}>
      <Icon icon={mdiRestore} size="18" aria-hidden="true" />
      {$t('frameleaf_keep_reset')}
    </Button>
  </div>
  <div class="body">
    <ol class="rules" aria-labelledby="keep-rules-title">
      {#each order as rule, index (rule)}
        <li
          class:deciding={rule === example.rule}
          class:dragging={rule === dragging}
          draggable="true"
          ondragstart={() => (dragging = rule)}
          ondragover={(event) => {
            event.preventDefault();
            if (dragging) {
              order = dropKeepRule(order, dragging, rule);
            }
          }}
          ondragend={() => {
            dragging = undefined;
            if (order.join(',') !== savedOrder().join(',')) {
              void save();
            }
          }}
        >
          <span class="grip" aria-hidden="true"><Icon icon={mdiDragVertical} size="18" /></span>
          <span class="number" aria-hidden="true">{index + 1}</span>
          <span class="text">
            <b>{label(rule)}</b>
            <small>{help(rule)}</small>
          </span>
          {#if rule === example.rule}
            <Pill tone="good">{$t('frameleaf_keep_decides')}</Pill>
          {/if}
          <span class="move">
            <IconButton
              variant="default"
              label={$t('frameleaf_keep_move_up', { values: { rule: label(rule) } })}
              disabled={index === 0}
              onclick={() => set(moveKeepRule(order, rule, -1))}
            >
              <Icon icon={mdiChevronUp} size="18" />
            </IconButton>
            <IconButton
              variant="default"
              label={$t('frameleaf_keep_move_down', { values: { rule: label(rule) } })}
              disabled={index === order.length - 1}
              onclick={() => set(moveKeepRule(order, rule, 1))}
            >
              <Icon icon={mdiChevronDown} size="18" />
            </IconButton>
          </span>
        </li>
      {/each}
    </ol>
    <aside class="example" aria-labelledby="keep-rules-example">
      <h3 id="keep-rules-example">{$t('frameleaf_keep_example')}</h3>
      <p>{$t('frameleaf_keep_example_hint')}</p>
      <div class="copies">
        {#each KEEP_EXAMPLE as copy, index (copy.name)}
          <div class="copy" class:kept={index === example.keep}>
            <b>{copy.name}</b>
            {#each facts(copy) as fact (fact)}
              <small>{fact}</small>
            {/each}
            {#if index === example.keep}
              <Pill tone="good">{$t('frameleaf_keep_suggest_keep')}</Pill>
            {:else}
              <Pill>{$t('frameleaf_keep_suggest_remove')}</Pill>
            {/if}
          </div>
        {/each}
      </div>
      <p aria-live="polite">
        {#if example.rule}
          {$t('frameleaf_keep_because', {
            values: {
              name: KEEP_EXAMPLE[example.keep].name,
              rule: label(example.rule),
              number: order.indexOf(example.rule) + 1,
            },
          })}
        {:else}
          {$t('frameleaf_keep_tie')}
        {/if}
      </p>
    </aside>
  </div>
</div>

<style>
  /* The prototype's `.qw-keep`, `.qw-rules`, `.qw-example`, `.qw-copies` (settings-v2/quick-wins.css). */
  .keep {
    display: grid;
    gap: 16px;
    padding: 20px 0;
    border-top: 1px solid var(--fl-border);
  }
  .heading {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px 24px;
  }
  .heading > div {
    flex: 1 1 360px;
  }
  .heading p,
  .example p {
    margin: 4px 0 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.5;
  }
  .example p {
    margin: 0;
  }
  .body {
    display: grid;
    grid-template-columns: minmax(0, 1.3fr) minmax(260px, 0.7fr);
    gap: 24px;
    align-items: start;
  }
  .rules {
    display: grid;
    gap: 8px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .rules li {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 56px;
    padding: 8px 8px 8px 12px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    background: var(--fl-panel);
    cursor: grab;
  }
  .rules li.deciding {
    border-color: var(--fl-accent);
  }
  .rules li.dragging {
    opacity: 0.5;
  }
  .grip {
    display: flex;
    flex: none;
    color: var(--fl-muted);
  }
  .number {
    display: grid;
    flex: none;
    place-items: center;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: var(--fl-raised);
    font-size: var(--fl-font-small);
    font-variant-numeric: tabular-nums;
  }
  .text {
    display: grid;
    flex: 1;
    gap: 2px;
    min-width: 0;
  }
  .text small,
  .copy small {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .move {
    display: flex;
    flex: none;
    gap: 8px;
  }
  .example {
    display: grid;
    gap: 12px;
    padding: 20px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
  }
  .example h3 {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    font-weight: var(--fl-weight-semibold);
    letter-spacing: 0.8px;
    text-transform: uppercase;
  }
  .copies {
    display: grid;
    /* Two side by side where each has room for its file name, else one under the other. */
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 12px;
  }
  .copy {
    display: grid;
    align-content: start;
    justify-items: start;
    gap: 4px;
    min-width: 0;
    padding: 12px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    overflow-wrap: anywhere;
  }
  .copy.kept {
    border-color: var(--fl-accent);
    background: var(--fl-accent-soft);
  }
  @media (max-width: 900px) {
    .body {
      grid-template-columns: minmax(0, 1fr);
    }
  }
  @media (max-width: 520px) {
    .rules li {
      flex-wrap: wrap;
    }
    .move {
      margin-inline-start: auto;
    }
  }
</style>
