<script lang="ts">
  /**
   * One Support Frameleaf card (AuthScreens.jsx:1795-1845 and 1934-1970, effd05ffb7): a title with
   * an optional tag, the price in US dollars (the licensed-server price struck through beside it),
   * a sentence, the features and one action.
   */
  import { formatUsd } from '$lib/frameleaf/cloud';
  import { Icon } from '@immich/ui';
  import { mdiCheck } from '@mdi/js';
  import type { Snippet } from 'svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    title: string;
    tag?: string;
    price: number;
    /** The price before the licensed-server discount, shown struck through when it differs. */
    listPrice?: number;
    period: string;
    description: string;
    features: string[];
    recommended?: boolean;
    current?: boolean;
    action?: Snippet;
  };

  let {
    title,
    tag,
    price,
    listPrice,
    period,
    description,
    features,
    recommended = false,
    current = false,
    action,
  }: Props = $props();
  const titleId = $props.id();
</script>

<section class="buy-card fl-continuous-corners" class:recommended class:current aria-labelledby={titleId}>
  <h3 id={titleId}>
    {title}
    {#if tag}
      <span class="buy-tag">{tag}</span>
    {/if}
  </h3>
  <p class="buy-price">
    {#if listPrice !== undefined && listPrice !== price}
      <s aria-label={$t('frameleaf_buy_list_price', { values: { price: formatUsd(listPrice) } })}
        >{formatUsd(listPrice)}</s
      >
    {/if}
    <strong>{formatUsd(price)}</strong>
    <span>{period}</span>
  </p>
  <p>{description}</p>
  <ul>
    {#each features as feature (feature)}
      <li><Icon icon={mdiCheck} size="16" />{feature}</li>
    {/each}
  </ul>
  {@render action?.()}
</section>
