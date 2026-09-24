<script lang="ts">
  /**
   * The "?" keyboard shortcuts sheet (FL-30, S-21).
   *
   * Ported from `design/frameleaf/template/src/ShortcutsHelp.jsx` and its `.shortcuts-help` styles
   * (`selection-bar.css`): a Frameleaf sheet with the General and Actions groups as description
   * lists of keycaps, the footnote, and Done. It replaces the upstream `ShortcutsModal`.
   *
   * The content is generated from the one library key map, so the help can never drift from what
   * the keys actually do, and the surface decides whether the timeline's or the viewer's entries
   * (and wording) are listed.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { libraryShortcutGroups, type LibrarySurface } from '$lib/frameleaf/library-shortcuts';
  import { Icon } from '@immich/ui';
  import { mdiInformationOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    onClose: () => void;
    /** Which surface's keys to list. Omitted, every entry is listed. */
    surface?: LibrarySurface;
  };

  let { onClose, surface }: Props = $props();

  let open = $state(true);
  const headingId = $props.id();

  const shortcuts = $derived(libraryShortcutGroups($t, { surface }));
  const groups = $derived([
    { id: 'general', title: $t('general'), items: shortcuts.general },
    { id: 'actions', title: $t('actions'), items: shortcuts.actions },
  ]);

  $effect(() => {
    if (!open) {
      onClose();
    }
  });
</script>

<Dialog bind:open title={$t('keyboard_shortcuts')} closeLabel={$t('close')}>
  <div class="fl-shortcuts-help" data-testid="frameleaf-shortcuts-help">
    {#each groups as group (group.id)}
      {#if group.items.length > 0}
        <section aria-labelledby="{headingId}-{group.id}">
          <h3 id="{headingId}-{group.id}">{group.title}</h3>
          <dl>
            {#each group.items as item (item.id)}
              <div>
                <dt>
                  {item.action}
                  {#if item.info}
                    <span class="fl-shortcut-info" title={item.info}>
                      <Icon icon={mdiInformationOutline} size="14" aria-hidden />
                      <span class="fl-sr">{item.info}</span>
                    </span>
                  {/if}
                </dt>
                <dd>
                  {#each item.key as key, index (`${key}-${index}`)}
                    {#if index > 0}<span aria-hidden="true">+</span>{/if}
                    <kbd>{key}</kbd>
                  {/each}
                </dd>
              </div>
            {/each}
          </dl>
        </section>
      {/if}
    {/each}
    <p class="fl-shortcuts-note">{$t('frameleaf_shortcuts_note')}</p>
  </div>
  {#snippet actions()}
    <Button variant="primary" initialFocus onclick={() => (open = false)}>{$t('done')}</Button>
  {/snippet}
</Dialog>

<style>
  /* Template selection-bar.css "Keyboard shortcuts help". */
  :global(dialog.dialog:has(.fl-shortcuts-help)) {
    max-width: min(760px, calc(100vw - 32px));
  }
  .fl-shortcuts-help {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: 8px 28px;
  }
  h3 {
    margin: 0 0 6px;
    color: var(--fl-muted);
    font-size: var(--fl-font-micro, 11px);
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  dl {
    display: flex;
    flex-direction: column;
    margin: 0;
  }
  dl > div {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 6px 0;
    border-bottom: 1px solid var(--fl-border);
    font-size: var(--fl-font-small, 12px);
  }
  dt {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--fl-text);
  }
  dd {
    display: flex;
    align-items: center;
    gap: 4px;
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-micro, 11px);
  }
  kbd {
    display: inline-grid;
    place-items: center;
    min-width: 24px;
    height: 24px;
    padding: 0 6px;
    border-radius: 5px;
    background: var(--fl-raised);
    color: var(--fl-text);
    box-shadow:
      inset 0 -1px 0 var(--fl-border),
      0 0 0 1px var(--fl-border);
    font:
      500 var(--fl-font-micro, 11px) / 1 ui-monospace,
      'SF Mono',
      Menlo,
      monospace;
  }
  .fl-shortcut-info {
    display: inline-grid;
    place-items: center;
    color: var(--fl-muted);
  }
  .fl-shortcuts-note {
    grid-column: 1 / -1;
    margin: 8px 0 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small, 12px);
  }
  .fl-sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
