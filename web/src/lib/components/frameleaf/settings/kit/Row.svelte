<script lang="ts">
  /**
   * A setting: what it is on the left, the control on the right. Stacks on a narrow page. `link`
   * is drawn after the help, for the page or the outside guide the help points to.
   */
  import TextLink from '$lib/components/frameleaf/settings/kit/TextLink.svelte';
  import type { Snippet } from 'svelte';

  let {
    label,
    help,
    helpId,
    link,
    children,
  }: {
    label: string;
    help?: string;
    /** Give the help an id so the control can point at it with `aria-describedby`. */
    helpId?: string;
    link?: { text: string; href: string; external?: boolean };
    children?: Snippet;
  } = $props();
</script>

<div class="kit-row">
  <div class="copy">
    <strong>{label}</strong>
    {#if help}<p id={helpId}>{help}</p>{/if}
    {#if link}
      <span class="link"><TextLink href={link.href} external={link.external}>{link.text}</TextLink></span>
    {/if}
  </div>
  {#if children}<div class="control">{@render children()}</div>{/if}
</div>

<style>
  .kit-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--fl-space-6);
    padding: var(--fl-space-4) 0;
    border-top: 1px solid var(--fl-border);
  }
  .copy {
    min-width: 0;
  }
  strong {
    display: block;
    font-size: var(--fl-font-callout);
    font-weight: 600;
  }
  p {
    max-width: 520px;
    margin: var(--fl-space-2) 0 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.5;
  }
  .link {
    display: block;
    margin-top: var(--fl-space-2);
    font-size: var(--fl-font-small);
  }
  .control {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: var(--fl-space-3);
    min-width: 0;
  }
  @container kit (max-width: 620px) {
    .kit-row {
      grid-template-columns: 1fr;
      gap: var(--fl-space-3);
    }
    .control {
      justify-content: flex-start;
    }
  }
</style>
