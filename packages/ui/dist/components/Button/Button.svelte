<script lang="ts">
  import Button from '../../internal/Button.svelte';
  import type { ButtonProps } from '../../types.js';

  let { ref = $bindable(null), color = 'primary', ...props }: ButtonProps = $props();
</script>

<Button bind:ref {color} {...props} />
