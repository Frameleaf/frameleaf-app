<script lang="ts">
  import Brand from '$lib/components/frameleaf/Brand.svelte';
  import '$lib/frameleaf/tokens.css';
  import { Theme as AppTheme, themeManager } from '@frameleaf/ui';
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
    gap: var(--fl-space-3) var(--fl-space-5);
    /* sharing.css .pv-header: a 60px panel-coloured bar over the canvas, 16px phone gutter, 24px wide. */
    min-height: 60px;
    padding: var(--fl-space-2) var(--fl-space-4);
    background: color-mix(in srgb, var(--fl-panel), transparent 6%);
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
    padding: 0 var(--fl-space-4);
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
    padding: var(--fl-space-2) var(--fl-space-4);
    border-top: 1px solid var(--fl-border);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  /* sharing.css .pv-exit: a quiet way out, muted until hovered. */
  .pv-exit {
    padding-block: var(--fl-space-1);
    color: var(--fl-muted);
  }
  .pv-exit:hover {
    color: var(--fl-text);
  }
  @media (min-width: 768px) {
    .pv-header,
    .pv-footer {
      padding-inline: var(--fl-space-6);
    }
    .pv-main:not(.pv-hero) {
      padding: 0 var(--fl-space-6);
    }
  }
</style>
