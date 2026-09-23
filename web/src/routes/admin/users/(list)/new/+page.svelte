<script lang="ts">
  /**
   * Create an account (FL-76). The route keeps its URL contract; its content is the Frameleaf
   * account form, which talks to `createUserAdmin` through `handleCreateUserAdmin`.
   */
  import { goto } from '$app/navigation';
  import AccountFormDialog from '$lib/components/frameleaf/AccountFormDialog.svelte';
  import { Route } from '$lib/route';
  import type { UserAdminResponseDto } from '@immich/sdk';

  const onClose = async (created?: UserAdminResponseDto) => {
    await (created ? goto(Route.viewUser(created), { replaceState: true }) : goto(Route.users()));
  };
</script>

<AccountFormDialog {onClose} />
