<script lang="ts">
  import { Icon } from '@immich/ui';
  import { mdiStarFourPoints } from '@mdi/js';
  import { t } from 'svelte-i18n';
</script>

<span class="frs-recommended"
  ><Icon icon={mdiStarFourPoints} size="12" aria-hidden={true} />{$t('frameleaf_setup_recommended')}</span
>
