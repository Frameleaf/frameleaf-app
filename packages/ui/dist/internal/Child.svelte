<script lang="ts">
  import { getChildContext } from '../common/context.svelte.js';
  import { ChildKey } from '../constants.js';
  import type { ChildData } from '../types.js';
  import { onMount } from 'svelte';

  type Props = {
    for: ChildKey;
    as: ChildKey;
  } & ChildData;

  const { for: key, as, ...rest }: Props = $props();

  const context = getChildContext(key);
  const { register } = $derived(context());
  const data = $derived(rest);

  onMount(() => register(as, () => data));
</script>
