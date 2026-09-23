<script lang="ts">
  import SettingToggle from '$lib/components/frameleaf/settings/SettingToggle.svelte';
  import { t } from 'svelte-i18n';
</script>

<SettingToggle
  title={$t('admin.version_check_enabled_description')}
  subtitle={$t('admin.version_check_disabled_by_privacy_policy')}
  checked={false}
  disabled
/>
