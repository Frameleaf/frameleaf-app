<script lang="ts">
  import { icons, type IconName } from "./icons";
  let {
    name,
    size = 16,
    color,
  }: { name: IconName; size?: number; color?: string } = $props();
</script>

<svg
  class="icon"
  width={size}
  height={size}
  viewBox="0 0 24 24"
  aria-hidden="true"
  focusable="false"
  style:color
  ><path fill="currentColor" d={icons[name]} /></svg
>
