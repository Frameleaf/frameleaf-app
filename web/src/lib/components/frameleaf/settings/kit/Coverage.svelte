<script lang="ts" module>
  import type { KitTone } from '$lib/components/frameleaf/settings/kit/Pill.svelte';

  export type CoverageRow = {
    icon: string;
    name: string;
    detail?: string;
    tone: KitTone;
    /** The short answer, for example "2 copies away from home". */
    value: string;
    note?: string;
  };
</script>

<script lang="ts">
  /** Two or three facts under a Hero: what is covered, and how well. */
  import Pill from '$lib/components/frameleaf/settings/kit/Pill.svelte';
  import { Icon } from '@frameleaf/ui';

  let { rows }: { rows: CoverageRow[] } = $props();
</script>

<dl class="kit-coverage">
  {#each rows as row (row.name)}
    <div>
      <span class="icon" aria-hidden="true"><Icon icon={row.icon} size="20" /></span>
      <dt>
        {row.name}
        {#if row.detail}<small>{row.detail}</small>{/if}
      </dt>
      <dd>
        <Pill tone={row.tone}>{row.value}</Pill>
        {#if row.note}<small>{row.note}</small>{/if}
      </dd>
    </div>
  {/each}
</dl>

<style>
  .kit-coverage {
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: minmax(0, 1fr);
    margin: 0;
    border-top: 1px solid var(--fl-border);
  }
  .kit-coverage > div {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--fl-space-3);
    min-width: 0;
    padding: var(--fl-space-4) var(--fl-space-6);
  }
  .kit-coverage > div + div {
    border-inline-start: 1px solid var(--fl-border);
  }
  .icon {
    display: inline-flex;
    color: var(--fl-muted);
  }
  dt {
    font-size: var(--fl-font-callout);
    font-weight: 600;
  }
  dd {
    margin: 0;
    text-align: end;
  }
  small {
    display: block;
    margin-top: var(--fl-space-1);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    font-weight: 400;
    line-height: 1.45;
  }
  @container kit (max-width: 620px) {
    .kit-coverage {
      grid-auto-flow: row;
    }
    .kit-coverage > div {
      grid-template-columns: auto minmax(0, 1fr);
      padding: var(--fl-space-4);
    }
    .kit-coverage > div + div {
      border-inline-start: 0;
      border-top: 1px solid var(--fl-border);
    }
    dd {
      grid-column: 2;
      text-align: start;
    }
  }
</style>
