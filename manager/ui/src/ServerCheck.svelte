<script lang="ts">
  // FL-1317 Check this server: the running list while Manager looks; afterwards, what needs attention above what is fine.
  import Icon from './Icon.svelte';
  import { attention, CHECK_LABELS, type CheckAction, type CheckRow } from './server-check';
  let {
    rows,
    order,
    busy = false,
    onaction,
    onreport,
  }: { rows: CheckRow[] | null; order: string[]; busy?: boolean; onaction: (action: CheckAction) => void; onreport: () => void } = $props();
  const ICONS: Record<string, string> = { problem: 'alert', warning: 'warning', unknown: 'help' };
  // One check is a single request: the list advances while Manager works and holds on the last until it answers.
  let ticks = $state(0);
  $effect(() => {
    if (rows) return;
    ticks = 0;
    const timer = setInterval(() => (ticks = Math.min(ticks + 1, order.length - 1)), 260);
    return () => clearInterval(timer);
  });
  const issues = $derived(rows ? attention(rows) : []);
  const fine = $derived(rows ? rows.filter((row) => row.status === 'ok') : []);
</script>

<div class="server-check">
{#if !rows}
  <ol class="check-timeline" aria-label="Checks">
    {#each order as id, index (id)}
      {@const state = index < ticks ? 'done' : index === ticks ? 'running' : 'waiting'}
      <li data-state={state}>
        <span>{#if state === 'done'}<Icon name="check" />{:else if state === 'running'}<Icon name="loader" class="check-spin" />{/if}</span>
        {CHECK_LABELS[id] ?? id}
      </li>
    {/each}
  </ol>
{:else}
  {#if issues.length}
    <ul class="check-issues">
      {#each issues as row (row.id)}
        <li class="check-issue" data-status={row.status}>
          <span class="check-issue-mark"><Icon name={ICONS[row.status]} /></span>
          <div class="check-issue-body">
            <h2>{row.title}</h2>
            {#if row.detail}<p>{row.detail}</p>{/if}
            {#if row.steps}<ol>{#each row.steps as step (step)}<li>{step}</li>{/each}</ol>{/if}
            {#if row.action}<button type="button" class="button" disabled={busy} onclick={() => onaction(row.action!)}>{row.action.label}</button>{/if}
          </div>
        </li>
      {/each}
    </ul>
    {#if fine.length}<h2 class="check-section">Looks good</h2>{/if}
  {/if}
  {#if fine.length}
    <ul class="check-fine">
      {#each fine as row (row.id)}
        <li><span class="check-fine-mark"><Icon name="check" /></span><span>{row.label}</span><strong>{row.value}</strong></li>
      {/each}
    </ul>
  {/if}
  {#if issues.some((row) => row.status === 'problem')}
    <p class="check-quiet"><Icon name="help" /><span>Still stuck? <button type="button" class="text-button" disabled={busy} onclick={onreport}>Download a report</button> to share when you ask for help. Manager removes passwords, folders and file names, but read it before you post it.</span></p>
  {/if}
{/if}
</div>
