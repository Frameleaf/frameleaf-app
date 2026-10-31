<script lang="ts" module>
  export type Fact = { label: string; value: string; detail?: string };
</script>

<script lang="ts">
  /** A few facts side by side: what it is, the answer, and a line of detail. */
  let { rows }: { rows: Fact[] } = $props();
</script>

<dl class="kit-facts">
  {#each rows as row (row.label)}
    <div>
      <dt>{row.label}</dt>
      <dd>
        {row.value}
        {#if row.detail}<small>{row.detail}</small>{/if}
      </dd>
    </div>
  {/each}
</dl>

<style>
  .kit-facts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: var(--fl-space-4);
    margin: 0;
    padding: 0 0 var(--fl-space-6);
  }
  .kit-facts > div {
    min-width: 0;
  }
  dt {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  dd {
    margin: var(--fl-space-2) 0 0;
    font-size: var(--fl-font-size);
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  small {
    display: block;
    margin-top: var(--fl-space-1);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    font-weight: 400;
    line-height: 1.45;
  }
</style>
