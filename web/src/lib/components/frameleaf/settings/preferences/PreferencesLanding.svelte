<script lang="ts">
  /**
   * Your preferences (FL-368, after the approved prototype `settings-v2/server/preferences.jsx`):
   * the everyday pages first, then the account's own, each row saying its current state where the
   * app knows it, and a pointer to the two things people look for here that are kept elsewhere.
   */
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Links, { type LinkRow } from '$lib/components/frameleaf/settings/kit/Links.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import { commandCenterUrl, type SettingsHostSection } from '$lib/frameleaf/settings-areas';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import { mdiEmailOutline, mdiShieldLockOutline } from '@mdi/js';
  import { locale, t } from 'svelte-i18n';

  let { sections }: { sections: SettingsHostSection[] } = $props();

  /** The pages about the account itself; the rest are everyday choices. */
  const ACCOUNT = new Set(['frameleaf-account', 'user-usage-info', 'user-purchase-settings']);

  const user = $derived(authManager.user);
  const size = (bytes: number) => getByteUnitString(bytes, $locale ?? undefined);
  /** What a row says under its name: the current state where it is known, else what the page holds. */
  const state = (section: SettingsHostSection) => {
    switch (section.key) {
      case 'account': {
        return $t('frameleaf_prefs_landing_profile', { values: { name: user.name, email: user.email } });
      }
      case 'user-usage-info': {
        const used = size(user.quotaUsageInBytes ?? 0);
        return user.quotaSizeInBytes
          ? $t('frameleaf_prefs_landing_numbers_limit', { values: { used, limit: size(user.quotaSizeInBytes) } })
          : $t('frameleaf_prefs_landing_numbers_no_limit', { values: { used } });
      }
      case 'user-purchase-settings': {
        return user.license
          ? $t('frameleaf_prefs_landing_supporter_yes')
          : featureFlagsManager.value.supporter
            ? $t('frameleaf_prefs_landing_supporter_server')
            : $t('frameleaf_prefs_landing_supporter_no');
      }
      default: {
        return section.subtitle;
      }
    }
  };
  const rows = (account: boolean) =>
    sections
      .filter((section) => ACCOUNT.has(section.key) === account)
      .map((section): LinkRow => ({
        icon: section.icon,
        title: section.title,
        body: state(section),
        href: commandCenterUrl('preferences', section.key),
      }));
</script>

<KitPage>
  <Section
    title={$t('frameleaf_prefs_landing_everyday')}
    description={$t('frameleaf_prefs_landing_everyday_description')}
  >
    <Links stacked rows={rows(false)} />
  </Section>

  <Section title={$t('frameleaf_prefs_landing_account')}>
    <Links stacked rows={rows(true)} />
  </Section>

  <Section title={$t('frameleaf_prefs_landing_elsewhere')}>
    <Links
      rows={[
        {
          icon: mdiEmailOutline,
          title: $t('frameleaf_prefs_landing_emails'),
          body: $t('frameleaf_prefs_landing_emails_where'),
          href: commandCenterUrl('notifications', 'email-preferences'),
        },
        {
          icon: mdiShieldLockOutline,
          title: $t('frameleaf_prefs_landing_security'),
          body: $t('frameleaf_prefs_landing_security_where'),
          href: commandCenterUrl('security'),
        },
      ]}
    />
  </Section>
</KitPage>
