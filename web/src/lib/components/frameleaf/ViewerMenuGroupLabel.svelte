<script lang="ts">
  /**
   * A heading inside the viewer's More menu (FL-35).
   *
   * It is a presentational row in the menu's `<ul>`, so it is skipped by the menu's
   * roving focus and never announced as a choice. The caller only renders it when the
   * group it heads has at least one visible entry.
   */
  type Props = {
    text: string;
    /** Hairline above every group but the first. */
    divided?: boolean;
  };

  let { text, divided = false }: Props = $props();
</script>

<li
  role="presentation"
  class={[
    'px-4 pt-3 pb-1 text-xs font-semibold tracking-wide text-gray-500 uppercase select-none',
    divided && 'mt-1 border-t border-gray-300',
  ]}
>
  {text}
</li>
