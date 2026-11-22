<script lang="ts">
  /** The picker and the member rows on one state, as the Share sheet mounts them. */
  import HouseholdMemberRows from '$lib/components/frameleaf/households/HouseholdMemberRows.svelte';
  import HouseholdSharePicker from '$lib/components/frameleaf/households/HouseholdSharePicker.svelte';
  import { HouseholdShareState } from '$lib/components/frameleaf/households/household-share.svelte';
  import { onMount } from 'svelte';

  const share = new HouseholdShareState('space-1');
  onMount(() => void share.load());
</script>

{#if share.loaded}
  <HouseholdSharePicker {share} />
  <ul>
    <HouseholdMemberRows {share} />
  </ul>
{/if}
