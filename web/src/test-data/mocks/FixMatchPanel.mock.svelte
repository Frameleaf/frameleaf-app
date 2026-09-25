<script lang="ts">
  // Stand-in for FixMatchPanel in PersonHero specs: reports one moved face when asked.
  interface Props {
    onChanged?: () => void;
    close: () => void;
  }

  let { onChanged, close }: Props = $props();
</script>

<button
  type="button"
  onclick={() => {
    onChanged?.();
    close();
  }}>Moved a face</button
>
