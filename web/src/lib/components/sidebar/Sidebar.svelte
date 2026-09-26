<script lang="ts">
  import { clickOutside } from '$lib/actions/click-outside';
  import { focusTrap } from '$lib/actions/focus-trap';
  import { menuButtonId } from '$lib/components/shared-components/navigation-bar/NavigationBar.svelte';
  import { mediaQueryManager } from '$lib/stores/media-query-manager.svelte';
  import { sidebarCollapsed } from '$lib/stores/preferences.store';
  import { sidebarStore } from '$lib/stores/sidebar.svelte';
  import { Icon, Theme as AppTheme, themeManager } from '@immich/ui';
  import { mdiMenu } from '@mdi/js';
  import { onMount, type Snippet } from 'svelte';
  import { t } from 'svelte-i18n';

  interface Props {
    ariaLabel?: string;
    /**
     * Replaces the collapse button at the top (desktop only). The Frameleaf rail draws its own
     * "Library" header with the double-chevron toggle (LibraryRail.jsx `rail-header`).
     */
    header?: Snippet<[{ collapsed: boolean; toggle: () => void }]>;
    children?: Snippet;
  }

  let { ariaLabel, header, children }: Props = $props();

  // S-28 (styles.css:291-299): the rail is the Frameleaf panel with its own edge, not the
  // upstream `bg-light` container, and it has no end padding around its rows.
  const appTheme = $derived(themeManager.value === AppTheme.Dark ? 'dark' : 'light');

  const isHidden = $derived(!sidebarStore.isOpen && !mediaQueryManager.isFullSidebar);
  const isExpanded = $derived(sidebarStore.isOpen && !mediaQueryManager.isFullSidebar);
  // Icon-only rail only applies on desktop; the mobile sidebar is a full-width overlay.
  const isCollapsed = $derived($sidebarCollapsed && mediaQueryManager.isFullSidebar);

  onMount(() => {
    closeSidebar();
  });

  const closeSidebar = () => {
    if (!isExpanded) {
      return;
    }
    sidebarStore.reset();
    if (isHidden) {
      document.querySelector<HTMLButtonElement>(`#${menuButtonId}`)?.focus();
    }
  };
</script>

<nav
  id="sidebar"
  aria-label={ariaLabel}
  tabindex="-1"
  class="frameleaf fl-sidebar relative z-1 w-0 immich-scrollbar overflow-x-hidden overflow-y-auto transition-all duration-200 sidebar:w-(--sidebar-width)"
  data-theme={appTheme}
  class:shadow-2xl={isExpanded}
  class:dark:border-e-immich-dark-gray={isExpanded}
  class:border-r={isExpanded}
  class:w-[min(100vw,16rem)]={sidebarStore.isOpen}
  class:is-collapsed={isCollapsed}
  class:transition-none={sidebarStore.isResizing}
  data-testid="sidebar-parent"
  inert={isHidden}
  use:clickOutside={{ onOutclick: closeSidebar, onEscape: closeSidebar }}
  use:focusTrap={{ active: isExpanded }}
>
  <div class="flex h-max min-h-full flex-col">
    {#if header}
      {@render header({ collapsed: isCollapsed, toggle: () => ($sidebarCollapsed = !$sidebarCollapsed) })}
    {:else}
      <button
        type="button"
        onclick={() => ($sidebarCollapsed = !$sidebarCollapsed)}
        aria-label={isCollapsed ? $t('expand') : $t('collapse')}
        aria-pressed={isCollapsed}
        class="mb-1 hidden w-full place-items-center gap-4 rounded-e-full py-3 ps-5 hover:bg-subtle hover:text-primary sidebar:flex"
      >
        <Icon icon={mdiMenu} size="1.375em" class="shrink-0" aria-hidden={true} />
      </button>
    {/if}
    <div class="nav-items contents">
      {@render children?.()}
    </div>
  </div>
</nav>

<style>
  .fl-sidebar {
    background: var(--fl-panel);
    border-inline-end: 1px solid var(--fl-border);
    padding-block: 18px 14px;
  }
  /* A hidden (narrow-screen, closed) rail is zero wide: its edge must not leave a 1px hairline. */
  .fl-sidebar[inert] {
    border-inline-end-width: 0;
  }
  /* Icon-only rail: hide NavbarItem text labels and the dropdown expand/collapse
     chevron buttons. Album tree, recent albums, group headers and bottom info are
     hidden by UserSidebar itself (it owns those components). */
  :global(#sidebar.is-collapsed .nav-items span.truncate),
  :global(#sidebar.is-collapsed .nav-items button) {
    display: none;
  }
</style>
