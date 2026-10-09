<script lang="ts">
  import { Field, PinInput } from '@frameleaf/ui';
  let { disabled, override }: { disabled: boolean; override?: boolean } = $props();
</script>

<Field {disabled} label="Recovery code">
  {#if override === undefined}
    <PinInput length={4} />
  {:else}
    <PinInput length={4} disabled={override} />
  {/if}
</Field>
