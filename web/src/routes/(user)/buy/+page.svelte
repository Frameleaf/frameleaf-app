<script lang="ts">
  /**
   * Support Frameleaf (FL-157): the prototype's Buy screen in the wide auth shell
   * (AuthScreens.jsx:1696-2088, `AuthShell wide`). A link code from the Frameleaf account site arrives
   * through session storage (see `+page.ts`), never through this page's address (CLD-004).
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
  <BuyScreen linkCode={data.linkCode} linkNotice={data.linkNotice} onBack={back} />
</AuthShell>
