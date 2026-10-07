<script lang="ts">
  import { icons } from './icons';
  let { name, class: className = '' }: { name: string; class?: string } = $props();
</script>

<svg
  class={className}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.65"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true">{@html icons[name] ?? icons.info}</svg
>
