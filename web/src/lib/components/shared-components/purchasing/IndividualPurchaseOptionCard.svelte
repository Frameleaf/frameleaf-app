<script lang="ts">
  import { Icon } from '@immich/ui';
  import { mdiAccount, mdiCheckCircleOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';
</script>

<!-- Individual Purchase Option -->
<div
  class="w-[min(375px,100%)] rounded-3xl border border-gray-300 bg-gray-100 p-8 dark:border-gray-800 dark:bg-gray-900"
>
  <div class="text-primary">
    <Icon icon={mdiAccount} size="56" />
    <p class="mt-1 text-lg font-semibold">{$t('purchase_individual_title')}</p>
  </div>

  <div class="mt-4 dark:text-immich-gray">
    <p class="text-6xl font-bold">$25</p>
    <p>{$t('purchase_per_user')}</p>
  </div>

  <div class="flex flex-col dark:text-immich-gray">
    <div class="mt-6 flex flex-col gap-1">
      <div class="grid grid-cols-[36px_auto]">
        <Icon icon={mdiCheckCircleOutline} size="24" class="self-center text-green-500" />
        <p class="self-center">{$t('purchase_individual_description_1')}</p>
      </div>

      <div class="grid grid-cols-[36px_auto]">
        <Icon icon={mdiCheckCircleOutline} size="24" class="self-center text-green-500" />
        <p class="self-center">{$t('purchase_lifetime_description')}</p>
      </div>

      <div class="grid grid-cols-[36px_auto]">
        <Icon icon={mdiCheckCircleOutline} size="24" class="self-center text-green-500" />
        <p class="self-center">{$t('purchase_individual_description_2')}</p>
      </div>
    </div>
    <!-- ponytail: no Frameleaf store yet; the Purchase link returns with FL-157 from the deployment-configured FRAMELEAF_CLOUD_URL. -->
  </div>
</div>
