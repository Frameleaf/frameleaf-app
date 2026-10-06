<script lang="ts">
  import { ChildKey } from '../../constants.js';
  import Child from '../../internal/Child.svelte';
  import type { ChildData } from '../../types.js';

  let props: ChildData = $props();
</script>

<Child for={ChildKey.Table} as={ChildKey.TableHeader} {...props} />
