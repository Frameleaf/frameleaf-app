<script lang="ts">
  import Brand from '$lib/components/frameleaf/Brand.svelte';
  import type { ErrorPageAction } from '$lib/frameleaf/error-page';
  import '$lib/frameleaf/tokens.css';
  import { Icon, Theme as AppTheme, themeManager } from '@immich/ui';
  import { mdiAlertCircleOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  /**
   * A Frameleaf error page (FL-55).
   *
   * A title that says what happened, one plain sentence about why and what to do, and the ways on.
   * No server message, no stack trace: those belong in the logs. The status code is shown small so a
   * person reporting a problem can quote it.
   *
   * `standalone` draws its own full-screen shell with the brand, for errors that replace the whole
   * app; otherwise it is a card for a page that keeps the app's rail and top bar around it, inside
   * a Frameleaf `Theme`.
   */
  interface Props {
    title: string;
    message: string;
    /** The HTTP status, shown small for reference. */
    code?: number;
    icon?: string;
    actions?: ErrorPageAction[];
    standalone?: boolean;
  }

  let { title, message, code, icon = mdiAlertCircleOutline, actions = [], standalone = false }: Props = $props();

  const appTheme = $derived(themeManager.value === AppTheme.Dark ? 'dark' : 'light');
</script>

<svelte:head>
  <title>{title} - Frameleaf</title>
</svelte:head>

{#snippet card()}
  <section class="fl-error-card" aria-labelledby="frameleaf-error-title">
    <span class="fl-error-icon" aria-hidden="true"><Icon {icon} size="32" /></span>
    <h1 id="frameleaf-error-title">{title}</h1>
    <p class="fl-error-message">{message}</p>
    {#if actions.length > 0}
      <div class="fl-error-actions">
        {#each actions as action (action.label)}
          {#if action.href}
            <a class="fl-error-action" class:primary={action.primary} href={action.href}>{action.label}</a>
          {:else}
            <button type="button" class="fl-error-action" class:primary={action.primary} onclick={action.onclick}>
              {action.label}
            </button>
          {/if}
        {/each}
      </div>
    {/if}
    {#if code}
      <p class="fl-error-code">{$t('frameleaf_error_code', { values: { code } })}</p>
    {/if}
  </section>
{/snippet}

{#if standalone}
  <main class="frameleaf fl-error-shell" data-theme={appTheme}>
    <a class="fl-error-brand" href="/photos" aria-label={$t('frameleaf_error_go_photos')}>
      <Brand />
    </a>
    {@render card()}
  </main>
{:else}
  <div class="fl-error-inline">
    {@render card()}
  </div>
{/if}

<style>
  .fl-error-shell {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2rem;
    min-height: 100dvh;
    padding: 1.5rem 1rem;
    color: var(--fl-text);
    background: var(--fl-canvas);
  }
  .fl-error-brand {
    display: inline-flex;
  }
  .fl-error-inline {
    display: flex;
    justify-content: center;
    padding: 3rem 1rem;
    color: var(--fl-text);
  }
  .fl-error-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
    width: min(28rem, 100%);
    padding: 1.75rem 1.5rem;
    text-align: center;
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card, var(--fl-radius));
    box-shadow: var(--fl-shadow-1, none);
  }
  .fl-error-icon {
    display: inline-flex;
    color: var(--fl-muted);
  }
  h1 {
    margin: 0;
    font-size: 1.25rem;
    font-weight: 700;
  }
  .fl-error-message {
    margin: 0;
    color: var(--fl-muted);
    font-size: 0.9375rem;
    line-height: 1.5;
  }
  .fl-error-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 0.5rem;
    margin-block-start: 0.5rem;
  }
  .fl-error-action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 44px;
    padding: 0 1rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    background: var(--fl-raised);
    color: var(--fl-text);
    font: inherit;
    font-size: 0.875rem;
    font-weight: 600;
    text-decoration: none;
    cursor: pointer;
  }
  .fl-error-action.primary {
    border-color: var(--fl-accent);
    background: var(--fl-accent);
    color: var(--fl-accent-text);
  }
  .fl-error-code {
    margin: 0.25rem 0 0;
    color: var(--fl-muted);
    font-size: 0.75rem;
  }
  @media (max-width: 480px) {
    .fl-error-actions {
      flex-direction: column;
      align-self: stretch;
    }
  }
</style>
