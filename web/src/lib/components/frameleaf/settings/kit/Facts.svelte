<script lang="ts" module>
  export type Fact = { label: string; value: string; detail?: string };
</script>

<script lang="ts">
  /**
   * A few facts side by side: what it is, the answer, and a line of detail. `columns` fixes the
   * grid (the prototype's settings `.bk2-facts` is four columns, two on a narrow page), so a strip
   * of three lines up with a strip of four on the next page; without it the facts share the width.
   */
  let { rows, columns }: { rows: Fact[]; columns?: number } = $props();
</script>

<dl class="kit-facts" class:is-columns={!!columns} style:--kit-facts-columns={columns}>
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
  .kit-facts.is-columns {
    grid-template-columns: repeat(var(--kit-facts-columns), minmax(0, 1fr));
  }
  @container kit (max-width: 860px) {
    .kit-facts.is-columns {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
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
