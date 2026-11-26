<script lang="ts">
  /*
   * FL-1796: the frame around every signed-in page: the top bar, the library rail and its resize
   * handle. `(user)/+layout.svelte` draws it once, so a page change replaces only the page; a
   * `UserPageLayout` outside that layout (the root error page, a spec) draws its own.
   */
  import type { ShellPage } from '$lib/components/layouts/user-shell.svelte';
  import NavigationBar from '$lib/components/shared-components/navigation-bar/NavigationBar.svelte';
  import UserSidebar from '$lib/components/shared-components/side-bar/UserSidebar.svelte';
  import { sidebarCollapsed, sidebarWidth } from '$lib/stores/preferences.store';
  import { sidebarStore } from '$lib/stores/sidebar.svelte';
  import { onDestroy, type Snippet } from 'svelte';
  import { t } from 'svelte-i18n';
  import { MediaQuery } from 'svelte/reactivity';

  interface Props {
    /** The page inside the shell; without one only `children` is drawn, with nothing around it. */
    page: ShellPage | undefined;
    children?: Snippet;
  }

  let { page, children }: Props = $props();

  /**
   * UI review 2026-10-30 #8: phones have no top tabs, so the ☰ menu opens the rail on every page,
   * Studio's included; below the sidebar breakpoint the rail is an overlay and takes no width.
   */
  const phone = new MediaQuery('max-width: 700px');
  const showRail = $derived(!!page && (page.rail || phone.current));
  const hideNavbar = $derived(!!page?.hideNavbar);

  // Everything below the Frameleaf top bar (FL-30), which is 56px, or two rows on phones.
  const heightClass = $derived(
    hideNavbar
      ? 'h-dvh'
      : 'h-[calc(100dvh-var(--fl-topbar-height))] max-md:h-[calc(100dvh-var(--fl-topbar-height-phone))]',
  );

  const MIN_SIDEBAR_WIDTH = 200;
  const MAX_SIDEBAR_WIDTH = 500;
  // `.sidebar.rail-collapsed` (styles.css:1703): 60px. The icon-only rows centre their icon
  // (LibraryRail `.fl-icon-only .fl-link`), so no start padding has to fit.
  const COLLAPSED_WIDTH = '3.75rem';
  const clampWidth = (value: number) => Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, value));
  // Clamp the persisted value too: a stale/edited localStorage entry could be out of range.
  const effectiveWidth = $derived(clampWidth($sidebarWidth));
  const railWidth = $derived($sidebarCollapsed ? COLLAPSED_WIDTH : `${effectiveWidth}px`);

  let container = $state<HTMLDivElement>();

  const resizeTo = (clientX: number) => {
    if (!container) {
      return;
    }
    const left = container.getBoundingClientRect().left;
    $sidebarWidth = Math.round(clampWidth(clientX - left));
  };

  let stopResize: (() => void) | undefined;
  onDestroy(() => stopResize?.());

  const startResize = (event: PointerEvent) => {
    stopResize?.();
    event.preventDefault();
    sidebarStore.isResizing = true;
    const controller = new AbortController();
    const { signal } = controller;
    stopResize = () => {
      sidebarStore.isResizing = false;
      controller.abort();
    };
    addEventListener('pointermove', (e: PointerEvent) => resizeTo(e.clientX), { signal });
    addEventListener('pointerup', stopResize, { once: true, signal });
    addEventListener('pointercancel', stopResize, { once: true, signal });
    addEventListener('blur', stopResize, { once: true, signal });
  };

  const onResizeKey = (event: KeyboardEvent) => {
    const step = event.key === 'ArrowLeft' ? -16 : event.key === 'ArrowRight' ? 16 : 0;
    if (step === 0) {
      return;
    }
    event.preventDefault();
    $sidebarWidth = clampWidth($sidebarWidth + step);
  };

  // A handle that goes away mid-drag (the page changed to one without the rail) ends the drag.
  $effect(() => {
    if (!page?.rail || $sidebarCollapsed) {
      stopResize?.();
    }
  });
</script>

{#if page}
  <header>
    {#if !hideNavbar}
      <NavigationBar onUploadClick={page.onUploadClick} hasRail={showRail} />
    {/if}
  </header>
{/if}
<!-- One element with or without a page, so a page that asks for the shell after it mounts is not rebuilt. -->
<div
  bind:this={container}
  tabindex={page ? -1 : undefined}
  style={page ? `--sidebar-width: ${railWidth}` : undefined}
  class={page
    ? `relative z-0 grid overflow-hidden
    ${showRail ? 'grid-cols-[--spacing(0)_auto] sidebar:grid-cols-[var(--sidebar-width)_auto]' : 'grid-cols-1'}
    ${
      sidebarStore.isResizing
        ? ''
        : 'transition-[grid-template-columns] duration-(--fl-duration) ease-(--fl-snappy) motion-reduce:transition-none'
    }
    ${heightClass}
    ${hideNavbar ? 'pt-(--navbar-height)' : ''}
    ${hideNavbar ? 'max-md:pt-(--navbar-height-md)' : ''}`
    : 'contents'}
>
  <!-- Without the rail the grid has one column and the content takes the whole width. -->
  {#if showRail}
    <UserSidebar>{@render page?.railExtra?.()}</UserSidebar>
  {/if}

  {#if page?.rail && !$sidebarCollapsed}
    <!-- Drag handle to resize the sidebar; sits on the sidebar/content boundary (desktop only). -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={$t('resize_sidebar')}
      aria-valuenow={effectiveWidth}
      aria-valuemin={MIN_SIDEBAR_WIDTH}
      aria-valuemax={MAX_SIDEBAR_WIDTH}
      tabindex="0"
      style="inset-inline-start: var(--sidebar-width)"
      class="absolute inset-y-0 z-2 hidden w-1.5 -translate-x-1/2 cursor-col-resize hover:bg-primary/40 focus-visible:bg-primary/40 sidebar:block"
      onpointerdown={startResize}
      onkeydown={onResizeKey}
    ></div>
  {/if}

  {@render children?.()}
</div>
