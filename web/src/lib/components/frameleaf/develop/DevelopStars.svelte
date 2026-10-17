<script lang="ts">
  /** Star rating (prototype `Stars`): pressing the current rating again clears it. */
  import { Icon } from '@frameleaf/ui';
  import { mdiStar, mdiStarOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  let {
    rating,
    name,
    compact = false,
    disabled = false,
    onChange,
  }: {
    rating: number;
    name: string;
    compact?: boolean;
    disabled?: boolean;
    onChange: (rating: number) => void;
  } = $props();
</script>

<div
  class="rde-stars"
  class:compact
  role="group"
  aria-label={$t('frameleaf_develop_rating_for', { values: { name, rating: Math.max(0, rating) } })}
>
  {#each [1, 2, 3, 4, 5] as value (value)}
    <button
      type="button"
      {disabled}
      aria-label={$t('frameleaf_develop_rate_stars', { values: { count: value, name } })}
      aria-pressed={rating >= value}
      onclick={() => onChange(value === rating ? 0 : value)}
      ><Icon icon={value <= rating ? mdiStar : mdiStarOutline} size={compact ? '13' : '17'} aria-hidden={true} /></button
    >
  {/each}
</div>
