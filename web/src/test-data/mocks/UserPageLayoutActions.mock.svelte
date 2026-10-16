<script lang="ts">
  import { useActions, type ActionArray } from '$lib/actions/use-actions';

  /** As `UserPageLayout.mock.svelte`, and the `use` actions run on the scroll area, as the real layout does. */
  interface Props {
    use?: ActionArray;
    buttons?: import('svelte').Snippet;
    children?: import('svelte').Snippet;
  }

  let { use = [], buttons, children }: Props = $props();
</script>

<section data-testid="user-page-layout" use:useActions={use}>
  {@render buttons?.()}
  {@render children?.()}
</section>
