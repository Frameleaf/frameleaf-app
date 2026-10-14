<script lang="ts">
  import { ChildKey } from '../../../../packages/ui/dist/constants.js';
  import { getChildContext, setChildContext } from '../../../../packages/ui/dist/common/context.svelte.js';

  type ChildContextHarnessApi = ReturnType<typeof setChildContext> & ReturnType<ReturnType<typeof getChildContext>>;
  const { capture }: { capture: (api: ChildContextHarnessApi) => void } = $props();
  const registry = setChildContext(ChildKey.Card);
  const readContext = getChildContext(ChildKey.Card);
  const { register } = readContext();
  capture({ ...registry, register });
</script>

<span data-testid="child-value">{registry.getByKey(ChildKey.CardBody)?.class ?? 'missing'}</span>
