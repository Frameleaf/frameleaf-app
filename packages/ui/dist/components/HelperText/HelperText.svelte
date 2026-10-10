<script lang="ts">
  import Text from '../Text/Text.svelte';
  import { ChildKey } from '../../constants.js';
  import Child from '../../internal/Child.svelte';
  import type { ChildData, TextColor } from '../../types.js';
  import { cleanClass } from '../../utilities/internal.js';

  type Props = {
    color?: TextColor;
  } & ChildData;

  let { class: className, children, color = 'muted' }: Props = $props();
</script>

<Child for={ChildKey.Field} as={ChildKey.HelperText}>
  <Text {color} size="small" {children} class={cleanClass('pt-1', className)} />
</Child>
