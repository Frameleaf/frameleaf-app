<script lang="ts" module>
  export type Point = { text: string; detail?: string; not?: boolean };
</script>

<script lang="ts">
  /** A short list in running text: what is included, and (`not`) what never is. */
  import { Icon } from '@frameleaf/ui';
  import { mdiCheck, mdiClose } from '@mdi/js';

  let { rows, label }: { rows: Point[]; label?: string } = $props();
</script>

<ul class="kit-points" aria-label={label}>
  {#each rows as row (row.text)}
    <li class:is-not={row.not}>
      <span class="icon" aria-hidden="true"><Icon icon={row.not ? mdiClose : mdiCheck} size="16" /></span>
      <div>
        {row.text}
        {#if row.detail}<small>{row.detail}</small>{/if}
      </div>
    </li>
  {/each}
</ul>

<style>
  .kit-points {
    display: grid;
    gap: var(--fl-space-2);
    margin: 0;
    padding: 0 0 var(--fl-space-5);
    font-size: var(--fl-font-callout);
    line-height: 1.5;
    list-style: none;
  }
  li {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: start;
    gap: var(--fl-space-2);
  }
  .icon {
    display: inline-flex;
    margin-top: 2px;
    color: var(--fl-accent);
  }
  .is-not .icon {
    color: var(--fl-muted);
  }
  small {
    display: block;
    margin-top: 2px;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
</style>
