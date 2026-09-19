<script lang="ts">
  import SettingSwitch from '$lib/components/shared-components/settings/SettingSwitch.svelte';
  import { t } from 'svelte-i18n';
</script>

<div class="ms-4 mt-4">
  <SettingSwitch
    title={$t('admin.version_check_enabled_description')}
    subtitle={$t('admin.version_check_disabled_by_privacy_policy')}
    checked={false}
    disabled
  />
</div>
