<script lang="ts">
  import { clickOutside } from '$lib/actions/click-outside';
  import { focusTrap } from '$lib/actions/focus-trap';
  import { menuButtonId } from '$lib/components/shared-components/navigation-bar/NavigationBar.svelte';
  import { mediaQueryManager } from '$lib/stores/media-query-manager.svelte';
  import { sidebarCollapsed } from '$lib/stores/preferences.store';
  import { sidebarStore } from '$lib/stores/sidebar.svelte';
  import { Icon, Theme, themeManager } from '@immich/ui';
  import '$lib/frameleaf/tokens.css';
  import { mdiMenu } from '@mdi/js';
  import { onMount, type Snippet } from 'svelte';
  import { t } from 'svelte-i18n';

  interface Props {
    ariaLabel?: string;
    frameleaf?: boolean;
    children?: Snippet;
  }

  let { ariaLabel, children, frameleaf = false }: Props = $props();

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
  class:frameleaf
  data-theme={frameleaf ? (themeManager.value === Theme.Dark ? 'dark' : 'light') : undefined}
  tabindex="-1"
  class="relative z-1 w-0 immich-scrollbar overflow-x-hidden overflow-y-auto bg-light pt-8 transition-all duration-200 sidebar:w-(--sidebar-width)"
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
  <div class="flex h-max min-h-full flex-col gap-1 pe-6">
    <button
      type="button"
      onclick={() => ($sidebarCollapsed = !$sidebarCollapsed)}
      aria-label={isCollapsed ? $t('expand') : $t('collapse')}
      aria-pressed={isCollapsed}
      class="mb-1 hidden w-full place-items-center gap-4 rounded-e-full py-3 ps-5 hover:bg-subtle hover:text-primary sidebar:flex"
    >
      <Icon icon={mdiMenu} size="1.375em" class="shrink-0" aria-hidden={true} />
    </button>
    <div class="nav-items contents">
      {@render children?.()}
    </div>
  </div>
</nav>

<style>
  nav.frameleaf {
    background: var(--fl-panel);
    color: var(--fl-text);
    border-inline-end: 1px solid var(--fl-border);
    padding-top: 0.5rem;
  }

  .frameleaf :global(.nav-items a) {
    border-radius: var(--fl-radius);
    color: var(--fl-text);
    min-height: 44px;
  }

  .frameleaf :global(.nav-items a:hover) {
    background: var(--fl-raised);
  }

  .frameleaf :global(.nav-items a[aria-current='page']) {
    background: var(--fl-raised);
    color: var(--fl-accent);
  }

  /* Icon-only rail: hide NavbarItem text labels and the dropdown expand/collapse
     chevron buttons. Album tree, recent albums, group headers and bottom info are
     hidden by UserSidebar itself (it owns those components). */
  :global(#sidebar.is-collapsed .nav-items span.truncate) {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  :global(#sidebar.is-collapsed .nav-items button) {
    display: none;
  }
</style>
