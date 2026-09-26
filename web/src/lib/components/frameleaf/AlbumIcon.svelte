<script lang="ts">
  import { iconPathFor, loadIconPaths, needsIconPaths, type IconPaths } from '$lib/frameleaf/icon-catalogue';
  import { Icon } from '@immich/ui';

  /**
   * Draw a stored album or collection icon: a Material Design Icons name or a
   * legacy key. Legacy keys draw at once; a catalogue name loads the geometry
   * chunk on first use and shows the default icon until it arrives.
   */
  let {
    name,
    size = '24',
    class: className = '',
  }: { name: string | null | undefined; size?: string | number; class?: string } = $props();

  let paths = $state<IconPaths | undefined>();

  $effect(() => {
    if (!paths && needsIconPaths(name)) {
      void loadIconPaths()
        .then((loaded) => (paths = loaded))
        .catch(() => {
          // The default icon stays; nothing else depends on the chunk.
        });
    }
  });

  const path = $derived(iconPathFor(name, paths));
</script>

<Icon icon={path} size={String(size)} class={className} />
