<script lang="ts">
  import AuthShell from '$lib/components/frameleaf/AuthShell.svelte';
  let { title = 'Sign in' }: { title?: string } = $props();
</script>

<AuthShell {title}>
  <label for="email">Email</label>
  <input id="email" type="email" />
</AuthShell>
