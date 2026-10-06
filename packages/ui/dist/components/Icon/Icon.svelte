<script lang="ts">
  import { styleVariants } from '../../styles.js';
  import type { IconProps } from '../../types.js';
  import { cleanClass } from '../../utilities/internal.js';
  import type { HTMLAttributes } from 'svelte/elements';
  import { tv } from 'tailwind-variants';
  import {
    mdiArrowLeft,
    mdiArrowLeftThin,
    mdiArrowRight,
    mdiArrowRightThin,
    mdiChevronDoubleLeft,
    mdiChevronDoubleRight,
    mdiChevronLeft,
    mdiChevronRight,
    mdiMenuLeft,
    mdiMenuRight,
  } from '@mdi/js';

  // Frameleaf FL-139: icons that point along the reading direction. Marked, they are mirrored in a
  // right-to-left page by the app's `[dir='rtl'] svg[data-rtl-mirror]` rule, so a "next" or "open"
  // chevron points the way the page reads. ponytail: a flipped directional icon is left unmarked
  // (both use the `scale` property); mark it too if one ever needs mirroring.
  const DIRECTIONAL = new Set([
    mdiArrowLeft,
    mdiArrowLeftThin,
    mdiArrowRight,
    mdiArrowRightThin,
    mdiChevronDoubleLeft,
    mdiChevronDoubleRight,
    mdiChevronLeft,
    mdiChevronRight,
    mdiMenuLeft,
    mdiMenuRight,
  ]);

  const {
    size = '1em',
    viewBox = '0 0 24 24',
    class: className = '',
    indicator: indicatorColor,
    flipped = false,
    flopped = false,
    spin = false,
    strokeColor = 'transparent',
    strokeWidth = 2,
    role = 'img',
    title,
    icon,
    color = 'currentColor',
    description,
    ...restProps
  }: IconProps & HTMLAttributes<EventTarget> = $props();

  // Frameleaf FL-139: an icon with no accessible name is decoration, so hide it instead of
  // announcing an unnamed image (axe svg-img-alt).
  const directional = $derived(!flipped && DIRECTIONAL.has(typeof icon === 'string' ? icon : icon.path));
  const decorative = $derived(role === 'img' && !title && !restProps['aria-label'] && !restProps['aria-labelledby']);

  const indicator = $derived.by(() => {
    const [_, yStart, xEnd, yEnd] = viewBox.split(' ', 4);
    if (yStart && xEnd && yEnd) {
      const radius = Math.min(Number(xEnd), Number(yEnd)) / 8;
      return { x: Number(xEnd) - radius, y: Number(yStart) + radius, radius };
    }
  });

  const indicatorStyles = tv({
    variants: {
      color: styleVariants.textColor,
    },
  });
</script>

<svg
  width={size}
  height={size}
  {viewBox}
  class={cleanClass(className, flipped && '-scale-x-100', flopped && 'rotate-180', spin && 'animate-spin')}
  stroke={strokeColor}
  stroke-width={strokeWidth}
  role={decorative ? undefined : role}
  aria-hidden={decorative ? 'true' : undefined}
  data-rtl-mirror={directional ? '' : undefined}
  {...restProps}
>
  {#if title}
    <title>{title}</title>
  {/if}
  {#if description}
    <desc>{description}</desc>
  {/if}
  <path d={typeof icon === 'string' ? icon : icon.path} fill={color} />
  {#if indicatorColor && indicator}
    <circle
      cx={indicator.x}
      cy={indicator.y}
      r={indicator.radius}
      fill="currentColor"
      class={indicatorStyles({ color: indicatorColor })}
    ></circle>
  {/if}
</svg>

<style>
  svg {
    transition: transform 0.2s ease;
  }
</style>
