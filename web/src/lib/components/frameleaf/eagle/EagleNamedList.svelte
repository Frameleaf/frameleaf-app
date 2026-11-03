<script lang="ts">
  import { locale, t } from 'svelte-i18n';

  /**
   * A named group in the Eagle check and report (prototype `NamedList`): its title and count, why
   * it is there, and the names themselves. The first few show, and "Show all" opens the rest, so
   * nothing is summed up as "and others".
   */
  let {
    title,
    names = [],
    reason,
    count,
    first = 4,
  }: {
    title: string;
    names?: string[];
    reason: string;
    /** A count for a group listed without names. */
    count?: number;
    first?: number;
  } = $props();
  let all = $state(false);
  const shown = $derived(all ? names : names.slice(0, first));
  const total = $derived(count ?? names.length);
</script>

<li class="named">
  <strong>
    {title}
    {#if total > 0}<small>· {total.toLocaleString($locale ?? undefined)}</small>{/if}
  </strong>
  <small>{reason}</small>
  {#if shown.length > 0}
    <ul class="names">
      {#each shown as name, index (index)}
        <li>{name}</li>
      {/each}
    </ul>
  {/if}
  {#if names.length > first}
    <button type="button" class="text-button" aria-expanded={all} onclick={() => (all = !all)}>
      {all ? $t('frameleaf_eagle_show_fewer') : $t('frameleaf_eagle_show_all', { values: { count: names.length } })}
    </button>
  {/if}
</li>

<style>
  .named {
    display: flex;
    flex-direction: column;
    gap: var(--fl-space-1);
    padding-block: var(--fl-space-3);
    border-block-end: 1px solid var(--fl-border);
  }
  .named:last-child {
    border-block-end: 0;
  }
  strong {
    font-size: 0.9375rem;
  }
  strong small {
    color: var(--fl-muted);
    font-weight: 400;
  }
  .named > small {
    color: var(--fl-muted);
    font-size: 0.8125rem;
    line-height: 1.4;
  }
  .names {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-2);
    margin: var(--fl-space-2) 0 0;
    padding: 0;
    list-style: none;
  }
  .names li {
    padding: 0.125rem 0.5rem;
    border-radius: 999px;
    background: var(--fl-raised);
    color: var(--fl-text);
    font-size: 0.8125rem;
    overflow-wrap: anywhere;
  }
  .text-button {
    align-self: flex-start;
    margin-block-start: var(--fl-space-1);
    padding: 0;
    border: 0;
    background: none;
    color: var(--fl-text);
    font: inherit;
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
  }
  .text-button:hover {
    text-decoration: underline;
  }
</style>
