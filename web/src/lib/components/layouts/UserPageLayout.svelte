<script lang="ts" module>
  export const headerId = 'user-page-header';
</script>

<script lang="ts">
  import { useActions, type ActionArray } from '$lib/actions/use-actions';
  import { useUserShell, type ShellPage } from '$lib/components/layouts/user-shell.svelte';
  import UserShell from '$lib/components/layouts/UserShell.svelte';
  import type { HeaderButtonActionItem } from '$lib/types';
  import { openFileUploadDialog } from '$lib/utils/file-uploader';
  import { Button, ContextMenuButton, HStack, isMenuItemType, type MenuItemType } from '@frameleaf/ui';
  import { onDestroy, type Snippet } from 'svelte';
  import { t } from 'svelte-i18n';

  interface Props {
    hideNavbar?: boolean;
    onUploadClick?: () => void;
    title?: string | undefined;
    description?: string | undefined;
    scrollbar?: boolean;
    use?: ActionArray;
    actions?: Array<HeaderButtonActionItem | MenuItemType>;
    /** Extra content inside the library rail, below the navigation (the Albums page's skip link). */
    railExtra?: Snippet;
    /**
     * Show the library rail. Studio has none, as in the prototype, where the rail belongs to the
     * library workspace and the Studio screen gives the whole width to its own work.
     */
    rail?: boolean;
    /**
     * A full-height workspace (Studio, Photography) fills the page body edge to edge: no inset,
     * and the body is a flex column that does not scroll, so the child sets `flex: 1` and scrolls
     * its own panes. The phone tab bar's space is still kept clear.
     */
    fill?: boolean;
    buttons?: Snippet;
    children?: Snippet;
  }

  let {
    hideNavbar = false,
    onUploadClick = () => void openFileUploadDialog(),
    title = undefined,
    description = undefined,
    scrollbar = true,
    use = [],
    actions = [],
    railExtra,
    rail = true,
    fill = false,
    buttons,
    children,
  }: Props = $props();

  /*
   * FL-1796: the top bar and the rail belong to the shell `(user)/+layout.svelte` keeps mounted;
   * this page only tells it what it wants and draws its own body. Outside that layout (the root
   * error page) there is no shell, and the page draws one for itself.
   */
  const shellPage: ShellPage = {
    get hideNavbar() {
      return hideNavbar;
    },
    get rail() {
      return rail;
    },
    get onUploadClick() {
      return onUploadClick;
    },
    get railExtra() {
      return railExtra;
    },
  };
  const shell = useUserShell();
  if (shell) {
    onDestroy(shell.add(shellPage));
  }

  const enabledActions = $derived(
    actions
      .filter((action): action is HeaderButtonActionItem => !isMenuItemType(action))
      .filter((action) => action.$if?.() ?? true),
  );

  let scrollbarClass = $derived(scrollbar ? 'immich-scrollbar' : 'scrollbar-hidden');
  let hasTitleClass = $derived(title ? 'top-16 h-[calc(100%-(--spacing(16)))]' : 'top-0 h-full');
</script>

{#snippet body()}
  <main class="relative">
    <!-- On phones the frosted tab bar floats over the foot of the page (TabBar.svelte). -->
    <!--
      `fl-scope` (tokens.css, base.css): the Frameleaf baseline classes and primitives work in page
      content without a local wrapper, and no element already on these pages is restyled.
    -->
    <div
      class="fl-scope absolute {hasTitleClass} w-full {fill
        ? 'flex flex-col overflow-hidden'
        : `${scrollbarClass} overflow-y-auto p-2`}"
      style:padding-bottom={fill ? 'var(--fl-tabbar-space, 0px)' : 'max(0.5rem, var(--fl-tabbar-space, 0px))'}
      data-fill={fill || undefined}
      use:useActions={use}
    >
      {@render children?.()}
    </div>

    {#if title || buttons}
      <!--
        The prototype's one-row collection header (styles.css `.collection-header`, `h1 small`): the
        title with its note beside it, the page's controls at the end. A page that draws its own
        heading passes no `title`, so the name is on screen once.
      -->
      <div class="fl-page-header absolute flex h-16 w-full items-center justify-between gap-3 px-4 md:px-6">
        <div class="fl-page-heading">
          {#if title}
            <div class="fl-page-title outline-none" tabindex="-1" id={headerId}>{title}</div>
          {/if}
          {#if description}
            <p class="fl-page-note">{description}</p>
          {/if}
        </div>

        {@render buttons?.()}

        {#if enabledActions.length > 0}
          <div class="hidden md:block">
            <HStack gap={0}>
              {#each enabledActions as action, i (i)}
                <Button
                  variant="ghost"
                  size="small"
                  color={action.color ?? 'secondary'}
                  leadingIcon={action.icon}
                  onclick={() => action.onAction(action)}
                  title={action.data?.title}
                >
                  {action.title}
                </Button>
              {/each}
            </HStack>
          </div>

          <ContextMenuButton aria-label={$t('open')} items={actions} class="md:hidden" />
        {/if}
      </div>
    {/if}
  </main>
{/snippet}

{#if shell}
  {@render body()}
{:else}
  <UserShell page={shellPage}>{@render body()}</UserShell>
{/if}

<style>
  .fl-page-header {
    border-bottom: 1px solid var(--fl-border);
    color: var(--fl-text);
  }
  .fl-page-heading {
    display: flex;
    /* A note that does not fit beside the title goes under it; the 64px bar holds both lines. */
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0 var(--fl-space-4);
    min-width: 0;
  }
  .fl-page-title,
  .fl-page-note {
    max-width: 100%;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .fl-page-title {
    flex: none;
    font-size: var(--fl-font-title);
    font-weight: 600;
    letter-spacing: -0.5px;
    line-height: 1.3;
  }
  .fl-page-note {
    min-width: 0;
    margin: 0;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
</style>
