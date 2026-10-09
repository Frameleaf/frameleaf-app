<script lang="ts">
  import { Field, PinInput } from '@frameleaf/ui';
  let {
    disabled,
    override,
    forwardOverride = false,
  }: { disabled: boolean; override?: boolean; forwardOverride?: boolean } = $props();
</script>

<Field {disabled} label="Recovery code">
  {#if override === undefined && !forwardOverride}
    <PinInput length={4} />
  {:else}
    <PinInput length={4} disabled={override} />
  {/if}
</Field>
