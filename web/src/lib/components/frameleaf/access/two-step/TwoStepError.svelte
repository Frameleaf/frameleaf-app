<script lang="ts">
  /** FL-831: what went wrong in a two-step dialog, said beside the field it is about. */
  import { Icon } from '@frameleaf/ui';
  import { mdiAlertCircleOutline } from '@mdi/js';

  let { id, message }: { id?: string; message: string } = $props();
</script>

<p class="ts-error" role="alert" {id}>
  <Icon icon={mdiAlertCircleOutline} size="18" /><span>{message}</span>
</p>
