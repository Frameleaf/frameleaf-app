<script lang="ts">
  import ShareSheet from './ShareSheet.svelte';

  /**
   * The share sheet shown through `modalManager` for the viewer's Share action (AL-33): the
   * design opens `ShareSheet` from the viewer (`MediaViewer.jsx:805-806`, `App.jsx:3445`), in
   * place of the legacy `SharedLinkCreateModal`. It resolves once the sheet and any link form it
   * opened have closed.
   */
  let { assetIds, onClose }: { assetIds: string[]; onClose: () => void } = $props();

  let open = $state(true);
</script>

<ShareSheet bind:open {assetIds} onClosed={onClose} />
