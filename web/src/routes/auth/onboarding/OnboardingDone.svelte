<script lang="ts">
  /**
   * Onboarding → You're all set (FL-80 ON-1, O-2): the prototype's summary of the choices made
   * (`AuthScreens.jsx:1148-1189`), read back from where each step saved it. Server rows appear only for
   * the administrator setting up the server.
   */
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { serverConfigManager } from '$lib/managers/server-config-manager.svelte';
  import { systemConfigManager } from '$lib/managers/system-config-manager.svelte';
  import { lang } from '$lib/stores/preferences.store';
  import { convertBCP47, getClosestAvailableLocale, langCodes, langs } from '$lib/utils/i18n';
  import { themeManager, ThemePreference } from '@immich/ui';
  import { t } from 'svelte-i18n';

  const server = $derived(authManager.user.isAdmin && !serverConfigManager.value.isOnboarded);
  const language = $derived.by(() => {
    const code = getClosestAvailableLocale([$lang], langCodes);
    return langs.find((entry) => convertBCP47(entry.code) === code)?.name ?? code;
  });
  const theme = $derived(
    themeManager.preference === ThemePreference.System
      ? $t('frameleaf_onboarding_theme_system')
      : themeManager.preference === ThemePreference.Light
        ? $t('light')
        : $t('dark'),
  );
  const list = (items: (string | false)[]) => items.filter(Boolean).join(', ') || $t('frameleaf_onboarding_all_off');

  const rows = $derived.by(() => {
    const preferences = authManager.authenticated ? authManager.preferences : undefined;
    // The server settings are loaded only for the administrator setting up the server.
    const config = server ? systemConfigManager.value : undefined;
    return [
      [$t('language'), language],
      [$t('theme'), theme],
      ...(server
        ? [[$t('server_privacy'), list([!!config?.map.enabled && $t('frameleaf_onboarding_summary_map')])]]
        : []),
      [
        $t('frameleaf_onboarding_user_privacy_title'),
        list([
          !!preferences?.cast.gCastEnabled && $t('frameleaf_onboarding_summary_casting'),
          !!preferences?.memories.enabled && $t('frameleaf_onboarding_summary_memories'),
        ]),
      ],
      ...(server && config
        ? [
            [
              $t('frameleaf_onboarding_storage_short'),
              config.storageTemplate.enabled
                ? config.storageTemplate.template
                : $t('frameleaf_onboarding_summary_storage_off'),
            ],
          ]
        : []),
    ];
  });
</script>

<p>{server ? $t('frameleaf_onboarding_done_server') : $t('frameleaf_onboarding_done_user')}</p>
<div class="ob-summary">
  {#each rows as [label, value] (label)}
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  {/each}
</div>
