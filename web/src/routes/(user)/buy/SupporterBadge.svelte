<script lang="ts">
  import { Icon } from '@immich/ui';
  import { mdiHandHeartOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  interface Props {
    centered?: boolean;
    logoSize?: 'sm' | 'lg';
  }

  let { centered = false, logoSize = 'sm' }: Props = $props();
</script>

<div
  class="supporter-effect relative mt-2 flex place-items-center gap-1 rounded-lg border border-transparent bg-gray-200/50 bg-clip-padding p-2 dark:bg-immich-dark-primary/10"
  class:place-content-center={centered}
>
  <!-- AuthScreens.jsx:1478-1480 `.buy-badge`: the supporter mark is the hand-heart, not an inherited product logo. -->
  <Icon icon={mdiHandHeartOutline} size={logoSize === 'sm' ? '16' : '28'} aria-hidden={true} class="text-primary" />
  <p class="dark:text-gray-100">{$t('purchase_account_info')}</p>
</div>

<style lang="postcss">
  @reference "tailwindcss";

  .supporter-effect::after {
    @apply absolute inset-0 rounded-lg opacity-0 transition-opacity content-[''];
  }

  .supporter-effect:hover::after {
    @apply opacity-100;
    background: linear-gradient(
      to right,
      rgba(16, 132, 254, 0.25),
      rgba(229, 125, 175, 0.25),
      rgba(254, 36, 29, 0.25),
      rgba(255, 183, 0, 0.25),
      rgba(22, 193, 68, 0.25)
    );
    animation: gradient 10s ease infinite;
    background-size: 400% 400%;
  }

  @keyframes gradient {
    0% {
      background-position: 0% 50%;
    }
    50% {
      background-position: 100% 50%;
    }
    100% {
      background-position: 0% 50%;
    }
  }
</style>
