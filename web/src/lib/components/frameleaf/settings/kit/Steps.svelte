<script lang="ts" module>
  export type Step = {
    title: string;
    detail?: string;
    /** Where a run in progress is with this step; leave out for a plan that is not running. */
    state?: 'done' | 'now' | 'waiting';
  };
</script>

<script lang="ts">
  /**
   * Things that happen one after another, numbered in their order: across the page where there is
   * room, down it on a narrow page or when `stacked`. For the order of a backup run or of a night's work.
   */
  import { Icon } from '@frameleaf/ui';
  import { mdiCheck } from '@mdi/js';

  let { steps, stacked = false, label }: { steps: Step[]; stacked?: boolean; label: string } = $props();
</script>

<ol class="kit-steps" class:is-stacked={stacked} aria-label={label}>
  {#each steps as step, index (step.title)}
    <li class:is-waiting={step.state === 'waiting'} aria-current={step.state === 'now' ? 'step' : undefined}>
      <span class="number" aria-hidden="true">
        {#if step.state === 'done'}<Icon icon={mdiCheck} size="14" />{:else}{index + 1}{/if}
      </span>
      <div>
        <strong>{step.title}</strong>
        {#if step.detail}<small>{step.detail}</small>{/if}
      </div>
    </li>
  {/each}
</ol>

<style>
  .kit-steps {
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: minmax(0, 1fr);
    gap: var(--fl-space-3);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .kit-steps.is-stacked {
    grid-auto-flow: row;
  }
  li {
    position: relative;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: start;
    gap: var(--fl-space-3);
    padding: var(--fl-space-3) var(--fl-space-4);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  /* The line from one step to the next. */
  li + li::before {
    content: '';
    position: absolute;
    top: 50%;
    inset-inline-start: calc(-1 * var(--fl-space-3) - 1px);
    width: var(--fl-space-3);
    border-top: 2px solid var(--fl-border);
  }
  .is-stacked li + li::before {
    top: calc(-1 * var(--fl-space-3) - 1px);
    inset-inline-start: 27px;
    width: 0;
    height: var(--fl-space-3);
    border-top: 0;
    border-inline-start: 2px solid var(--fl-border);
  }
  .number {
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    color: var(--fl-accent-text);
    font-size: var(--fl-font-small);
    font-weight: 700;
    background: var(--fl-accent);
    border-radius: 50%;
  }
  .is-waiting .number {
    color: var(--fl-muted);
    background: var(--fl-border);
  }
  strong {
    display: block;
    font-size: var(--fl-font-callout);
    font-weight: 600;
  }
  small {
    display: block;
    margin-top: var(--fl-space-1);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.45;
  }
  @container kit (max-width: 620px) {
    .kit-steps {
      grid-auto-flow: row;
    }
    li + li::before {
      top: calc(-1 * var(--fl-space-3) - 1px);
      inset-inline-start: 27px;
      width: 0;
      height: var(--fl-space-3);
      border-top: 0;
      border-inline-start: 2px solid var(--fl-border);
    }
  }
</style>
