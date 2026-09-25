<script lang="ts">
  /**
   * Timeline, Browse and Work (FL-33), in the collection header as the prototype places it
   * (`App.jsx` `.collection-header` renders `layoutSwitch` beside the title, not in the results
   * toolbar). Timeline precedes Browse and Work.
   */
  import type { LibrarySessionStore } from '$lib/frameleaf/library-session.svelte';
  import type { LibraryLayout } from '$lib/frameleaf/library-session';
  import { Icon } from '@immich/ui';
  import { mdiViewComfyOutline, mdiViewDashboardOutline, mdiViewDayOutline } from '@mdi/js';
  import { t, type Translations } from 'svelte-i18n';

  let { session }: { session: LibrarySessionStore } = $props();

  const LAYOUT_ORDER: LibraryLayout[] = ['timeline', 'browse', 'work'];
  const LAYOUT_LABELS: Record<LibraryLayout, Translations> = {
    timeline: 'frameleaf_library_layout_timeline',
    browse: 'frameleaf_library_layout_browse',
    work: 'frameleaf_library_layout_work',
  };
  const LAYOUT_ICONS: Record<LibraryLayout, string> = {
    timeline: mdiViewDayOutline,
    browse: mdiViewComfyOutline,
    work: mdiViewDashboardOutline,
  };
</script>

<div class="fl-layouts" role="group" aria-label={$t('frameleaf_library_layout')} data-testid="frameleaf-layout-switch">
  {#each LAYOUT_ORDER as layout (layout)}
    <button
      type="button"
      class="fl-layout"
      aria-pressed={session.layout === layout}
      onclick={() => {
        session.setLayout(layout);
        // As in the prototype: the Timeline opens grouped by day rather than as one "All" group.
        if (layout === 'timeline' && session.state.grouping === 'all') {
          session.patchView({ grouping: 'days' });
        }
      }}
    >
      <Icon icon={LAYOUT_ICONS[layout]} size="16" />
      {$t(LAYOUT_LABELS[layout])}
    </button>
  {/each}
</div>

<style>
  .fl-layouts {
    display: inline-flex;
    flex-shrink: 0;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    overflow: hidden;
  }
  .fl-layout {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 0 10px;
    border: 0;
    background: transparent;
    color: var(--fl-muted);
    font-size: var(--fl-font-size, 14px);
  }
  .fl-layout[aria-pressed='true'] {
    background: var(--fl-raised);
    color: var(--fl-text);
    font-weight: 600;
  }
</style>
