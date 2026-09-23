<script lang="ts" module>
  // The Frameleaf top bar repeats this id on its menu button; `Sidebar` focuses it
  // when the mobile sidebar closes.
  export const menuButtonId = 'top-menu-button';
</script>

<script lang="ts">
  import TopBar from '$lib/components/frameleaf/TopBar.svelte';

  type Props = {
    onUploadClick?: () => void;
    // TODO: remove once this is only used in <AppShellHeader>
    noBorder?: boolean;
  };

  let { onUploadClick, noBorder = false }: Props = $props();
</script>

<TopBar {onUploadClick} {noBorder} />
