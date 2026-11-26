<script lang="ts">
  import {
    iconPackOf,
    iconShapeFor,
    loadedIconPaths,
    loadIconPaths,
    type IconPaths,
  } from '$lib/frameleaf/icon-catalogue';
  import { Icon } from '@frameleaf/ui';

  /**
   * Draw a stored album or collection icon: a Material Design Icons name, an
   * icon from one of the extra packs, or a legacy key. Legacy keys draw at once;
   * any other name loads its pack's geometry on first use and shows the default
   * icon until it arrives.
   */
  let {
    name,
    size = '24',
    class: className = '',
  }: { name: string | null | undefined; size?: string | number; class?: string } = $props();

  let fetched = $state<{ pack: string; paths: IconPaths }>();

  const pack = $derived(iconPackOf(name));
  const paths = $derived(pack ? (fetched?.pack === pack ? fetched.paths : loadedIconPaths(pack)) : undefined);

  $effect(() => {
    const wanted = pack;
    if (wanted && !paths) {
      void loadIconPaths(wanted)
        .then((loaded) => (fetched = { pack: wanted, paths: loaded }))
        .catch(() => {
          // The default icon stays; nothing else depends on the geometry.
        });
    }
  });

  const shape = $derived(iconShapeFor(name, paths));
</script>

{#if typeof shape === 'string'}
  <Icon icon={shape} size={String(size)} class={className} />
{:else}
  <!-- Outline packs draw strokes, which the shared Icon (one filled path) cannot. -->
  <svg
    width={size}
    height={size}
    viewBox="0 0 {shape.box ?? 24} {shape.box ?? 24}"
    class={className}
    fill="none"
    stroke="currentColor"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    {#if shape.fill}
      <path d={shape.fill} fill="currentColor" stroke="none" />
    {/if}
    {#each shape.strokes ?? [] as [width, d] (width)}
      <path {d} stroke-width={width} />
    {/each}
  </svg>
{/if}
