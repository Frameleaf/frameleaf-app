<script lang="ts" module>
  export type PromiseRow = { icon: string; text: string; detail?: string };
</script>

<script lang="ts">
  /** Plain sentences where a control could never be changed: what Frameleaf always or never does. */
  import { Icon } from '@frameleaf/ui';

  let { rows }: { rows: PromiseRow[] } = $props();
</script>

<ul class="kit-promises">
  {#each rows as row (row.text)}
    <li>
      <span class="icon" aria-hidden="true"><Icon icon={row.icon} size="20" /></span>
      <div>
        <strong>{row.text}</strong>
        {#if row.detail}<p>{row.detail}</p>{/if}
      </div>
    </li>
  {/each}
</ul>

<style>
  .kit-promises {
    margin: 0;
    padding: 0 0 var(--fl-space-2);
    list-style: none;
  }
  li {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: start;
    gap: var(--fl-space-3);
    padding: var(--fl-space-4) 0;
    border-top: 1px solid var(--fl-border);
  }
  .icon {
    display: inline-flex;
    color: var(--fl-accent);
  }
  strong {
    display: block;
    font-size: var(--fl-font-callout);
    font-weight: 600;
  }
  p {
    max-width: 640px;
    margin: var(--fl-space-2) 0 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.5;
  }
</style>
