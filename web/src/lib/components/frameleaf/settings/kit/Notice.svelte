<script lang="ts">
  /**
   * A consequence or a problem, said plainly, inside the page it is about. `warn` is something to
   * act on and is announced when it appears; `info` is something to know.
   */
  import { Icon } from '@frameleaf/ui';
  import { mdiAlertCircleOutline, mdiInformationOutline } from '@mdi/js';
  import type { Snippet } from 'svelte';

  let {
    tone = 'info',
    icon,
    title,
    children,
    action,
  }: {
    tone?: 'warn' | 'info';
    icon?: string;
    title?: string;
    children?: Snippet;
    action?: Snippet;
  } = $props();
</script>

<div class="kit-notice" class:is-info={tone === 'info'} role={tone === 'info' ? 'note' : 'status'}>
  <span class="icon" aria-hidden="true">
    <Icon icon={icon ?? (tone === 'info' ? mdiInformationOutline : mdiAlertCircleOutline)} size="20" />
  </span>
  <div class="copy">
    {#if title}<strong>{title}</strong>{/if}
    {#if children}<p>{@render children()}</p>{/if}
  </div>
  {#if action}<div class="action">{@render action()}</div>{/if}
</div>

<style>
  .kit-notice {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--fl-space-3);
    padding: var(--fl-space-4);
    font-size: var(--fl-font-callout);
    background: color-mix(in srgb, var(--fl-warning) 10%, var(--fl-panel));
    border: 1px solid color-mix(in srgb, var(--fl-warning) 55%, var(--fl-border));
    border-radius: var(--fl-radius-card);
  }
  .icon {
    display: inline-flex;
    color: var(--fl-warning);
  }
  .is-info {
    background: var(--fl-raised);
    border-color: var(--fl-border);
  }
  .is-info .icon {
    color: var(--fl-muted);
  }
  strong {
    display: block;
    font-weight: 600;
  }
  p {
    margin: 0;
    color: var(--fl-muted);
    line-height: 1.5;
  }
  strong + p {
    margin-top: var(--fl-space-1);
  }
  .action {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-2);
  }
  @container kit (max-width: 620px) {
    .kit-notice {
      grid-template-columns: auto minmax(0, 1fr);
    }
    .action {
      grid-column: 2;
    }
  }
</style>
