<script lang="ts">
  import { ChildKey } from '../../constants.js';
  import Child from '../../internal/Child.svelte';
  import type { ChildData } from '../../types.js';

  let props: ChildData = $props();
</script>

<Child for={ChildKey.Modal} as={ChildKey.ModalBody} {...props} />
