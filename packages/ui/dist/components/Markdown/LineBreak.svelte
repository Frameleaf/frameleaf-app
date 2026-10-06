<script lang="ts">
  import { cleanClass } from '../../utilities/internal.js';

  type Props = {
    class?: string;
  };

  const { class: className }: Props = $props();
</script>

<hr class={cleanClass('my-6 border-t', className)} />
