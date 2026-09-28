<script lang="ts">
  // Stand-in for FixMatchPanel in PersonHero specs: reports one face moved to Grace when asked.
  interface Props {
    onChanged?: (personIds: string[]) => void;
    close: () => void;
  }

  let { onChanged, close }: Props = $props();
</script>

<button
  type="button"
  onclick={() => {
    onChanged?.(['grace']);
    close();
  }}>Moved a face</button
>
