<script lang="ts">
  let { feature, topUpUrl }: { feature: string | null; topUpUrl?: string | null } = $props();
</script>

<div data-testid="get-cloud-sheet">{feature} {topUpUrl}</div>
