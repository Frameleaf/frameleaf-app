<script lang="ts">
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import SharedLinkList from '$lib/components/frameleaf/SharedLinkList.svelte';
  import type { Snippet } from 'svelte';

  type Props = {
    children?: Snippet;
  };

  const { children }: Props = $props();
</script>

<!--
  FL-54: SharedLinkList.svelte is a full screen with its own heading, tabs, search, list
  loading and create/edit dialogs, so this layout only mounts it. The rail and top bar come
  from UserPageLayout -> NavigationBar/UserSidebar.
-->
<UserPageLayout>
  <SharedLinkList />
  {@render children?.()}
</UserPageLayout>
