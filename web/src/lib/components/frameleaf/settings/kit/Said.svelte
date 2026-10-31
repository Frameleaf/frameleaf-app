<script lang="ts">
  /** What just happened, said once at the top of the page after an action, until it is dismissed. */
  import { Icon } from '@frameleaf/ui';
  import { mdiCheckCircleOutline, mdiClose } from '@mdi/js';
  import { t } from 'svelte-i18n';

  let { message, onDismiss }: { message: string; onDismiss: () => void } = $props();
</script>

<!-- The region stays in the page so a message that appears in it is announced. -->
<div class="kit-said-region" role="status">
  {#if message}
    <div class="kit-said">
      <span class="icon" aria-hidden="true"><Icon icon={mdiCheckCircleOutline} size="20" /></span>
      <p>{message}</p>
      <button type="button" aria-label={$t('frameleaf_kit_dismiss')} onclick={onDismiss}>
        <Icon icon={mdiClose} size="16" aria-hidden />
      </button>
    </div>
  {/if}
</div>

<style>
  .kit-said-region:empty {
    display: none;
  }
  .kit-said {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--fl-space-3);
    padding: var(--fl-space-3) var(--fl-space-4);
    font-size: var(--fl-font-callout);
    background: color-mix(in srgb, var(--fl-accent) 10%, var(--fl-panel));
    border: 1px solid color-mix(in srgb, var(--fl-accent) 45%, var(--fl-border));
    border-radius: var(--fl-radius-card);
  }
  .icon {
    display: inline-flex;
    color: var(--fl-accent);
  }
  p {
    margin: 0;
    line-height: 1.5;
  }
  button {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    color: var(--fl-muted);
    background: none;
    border: 0;
    border-radius: var(--fl-radius-control);
    cursor: pointer;
  }
  button:hover {
    color: var(--fl-text);
    background: var(--fl-raised);
  }
  button:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
</style>
