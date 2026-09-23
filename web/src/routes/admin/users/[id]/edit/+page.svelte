<script lang="ts">
  /**
   * Edit an account (FL-76). The route keeps its URL contract; its content is the same
   * Frameleaf account form the create route uses, submitting through `updateUserAdmin`.
   */
  import { goto } from '$app/navigation';
  import AccountFormDialog from '$lib/components/frameleaf/AccountFormDialog.svelte';
  import { Route } from '$lib/route';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const user = $derived(data.user);

  const onClose = async () => {
    await goto(Route.viewUser(user));
  };
</script>

<AccountFormDialog {user} {onClose} />
