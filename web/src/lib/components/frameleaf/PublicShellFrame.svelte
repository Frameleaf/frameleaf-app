<script lang="ts">
  import Brand from '$lib/components/frameleaf/Brand.svelte';
  import '$lib/frameleaf/tokens.css';
  import { Theme as AppTheme, themeManager } from '@immich/ui';
  import type { Snippet } from 'svelte';
  import { t } from 'svelte-i18n';

  /**
   * The frame every public shared-link state draws in (prototype `PublicViewer.jsx` `shell()`): the
   * brand header, the page, and the "Go to Frameleaf" footer. An open share adds its title and actions
   * to the header (`PublicViewerShell`); the password prompt and an unavailable or expired link are
   * centred states in the same frame (`hero`). No rail, top bar or account menu reaches a visitor.
   */
  interface Props {
    /** The share's title and actions, drawn after the brand. */
    header?: Snippet;
    /** Drawn between the header and the page, for the Select mode bar. */
    belowHeader?: Snippet;
    /** A centred state (password, unavailable) rather than the share's grid. */
    hero?: boolean;
    children: Snippet;
  }

  let { header, belowHeader, hero = false, children }: Props = $props();

  const appTheme = $derived(themeManager.value === AppTheme.Dark ? 'dark' : 'light');
</script>

<div class="frameleaf public-viewer" data-theme={appTheme}>
  <header class="pv-header">
    <a class="pv-brand" href="/" data-sveltekit-preload-data="hover">
      <Brand />
    </a>
    {@render header?.()}
  </header>

  {@render belowHeader?.()}

  <main class="pv-main" class:pv-hero={hero}>
    {@render children()}
  </main>

  <footer class="pv-footer">
    <a class="pv-exit" href="/" data-sveltekit-preload-data="hover">{$t('frameleaf_public_go_home')}</a>
  </footer>
</div>

<style>
  .public-viewer {
    display: flex;
    flex-direction: column;
    height: 100dvh;
    color: var(--fl-text);
    background: var(--fl-canvas);
  }
  .pv-header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem 1.25rem;
    padding: 0.75rem 1rem;
    background: color-mix(in srgb, var(--fl-canvas), transparent 12%);
    border-bottom: 1px solid var(--fl-border);
  }
  .pv-brand {
    display: inline-flex;
    flex-shrink: 0;
    width: 8.5rem;
  }
  .pv-main {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 0 0.5rem;
  }
  .pv-main.pv-hero {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1.5rem;
  }
  .pv-footer {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    padding: 0.5rem 1rem;
    border-top: 1px solid var(--fl-border);
    font-size: var(--fl-font-small);
  }
  .pv-exit {
    color: var(--fl-accent);
    font-weight: 560;
  }
  .pv-exit:hover {
    text-decoration: underline;
  }
  @media (min-width: 768px) {
    .pv-main:not(.pv-hero) {
      padding: 0 1.5rem;
    }
  }
</style>
