<script lang="ts">
  import { OpenQueryParam } from '$lib/constants';
  import FormatMessage from '$lib/elements/FormatMessage.svelte';
  import { Route } from '$lib/route';
  import { t } from 'svelte-i18n';
</script>

<FormatMessage key="frameleaf_jobs_queue_storage_template_hint" values={{ layout: $t('frameleaf_layout_label') }}>
  {#snippet children({ message })}
    <a href={Route.systemSettings({ isOpen: OpenQueryParam.STORAGE_TEMPLATE })} class="text-primary">
      {message}
    </a>
  {/snippet}
</FormatMessage>
