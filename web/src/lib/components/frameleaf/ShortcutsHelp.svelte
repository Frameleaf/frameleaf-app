<script lang="ts">
  /**
   * The keyboard shortcuts reference (FL-33).
   *
   * Ported from `design/frameleaf/template/src/ShortcutsHelp.jsx`. The content is generated from
   * the one library key map, so the help can never drift from what the keys actually do, and the
   * surface decides whether the timeline's or the viewer's entries are listed.
   *
   * It renders through the existing shortcuts modal rather than a second dialog implementation.
   */
  import { libraryShortcutGroups, type LibrarySurface } from '$lib/frameleaf/library-shortcuts';
  import ShortcutsModal from '$lib/modals/ShortcutsModal.svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    onClose: () => void;
    /** Which surface's keys to list. Omitted, every entry is listed. */
    surface?: LibrarySurface;
  };

  let { onClose, surface }: Props = $props();

  const shortcuts = $derived(libraryShortcutGroups($t, { surface }));
</script>

<ShortcutsModal {onClose} {shortcuts} />
