<script lang="ts">
  // Renders nothing: stands in for a heavy child component in a unit spec.
  let { ...rest }: Record<string, unknown> = $props();
  void rest;
</script>
