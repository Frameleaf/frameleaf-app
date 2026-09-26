<script lang="ts">
  import SessionLockShield from './SessionLockShield.svelte';
  let { active }: { active: boolean } = $props();
</script>

<SessionLockShield {active}>
  <p data-testid="cached-private-media">Cached private media</p>
</SessionLockShield>
