<script lang="ts">
  /**
   * Support Frameleaf (FL-157): the prototype's Buy screen in the wide auth shell
   * (AuthScreens.jsx:1696-2088, `AuthShell wide`). A key relayed from the Frameleaf store arrives
   * through session storage (see `+page.ts`), never through the address.
   */
  import { goto } from '$app/navigation';
  import AuthShell from '$lib/components/frameleaf/AuthShell.svelte';
  import BuyScreen from '$lib/components/frameleaf/buy/BuyScreen.svelte';
  import { Route } from '$lib/route';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const back = () => (history.length > 1 ? history.back() : void goto(Route.photos()));
</script>

<svelte:head>
  <title>{data.meta.title}</title>
</svelte:head>

<AuthShell wide>
  <BuyScreen pendingKey={data.pendingKey} onBack={back} />
</AuthShell>
