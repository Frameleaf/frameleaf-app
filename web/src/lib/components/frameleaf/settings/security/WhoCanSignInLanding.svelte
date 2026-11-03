<script lang="ts">
  /**
   * Your server › Who can sign in (FL-367, the approved prototype's `settings-v2/cloud/SecurityLanding.jsx`):
   * what an administrator sets for everyone. It opens on the answer for the household (everyone can
   * sign in at home and away, or at home only while the server is not linked), then the sign-in
   * methods, Sign in with Frameleaf and the rule for signing in away from home, each with its state,
   * and who has an account. A person's own password, PIN and devices are on "Your sign-in & privacy".
   */
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Links, { type LinkRow } from '$lib/components/frameleaf/settings/kit/Links.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import { signInMethodsState } from '$lib/components/frameleaf/settings/security/sign-in';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { getSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { cloudManager } from '$lib/managers/cloud-manager.svelte';
  import { searchUsersAdmin } from '@frameleaf/sdk';
  import {
    mdiAccountLockOutline,
    mdiAccountMultipleOutline,
    mdiEarth,
    mdiHomeOutline,
    mdiKeyOutline,
    mdiShieldAccountOutline,
    mdiShieldCheckOutline,
  } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  onMount(() => cloudManager.listen());
  let people = $state<number | null>(null);
  onMount(() => {
    void searchUsersAdmin({ withDeleted: false })
      .then((users) => (people = users.length))
      .catch(() => (people = null));
  });

  const saved = $derived(getSystemConfigDraft()?.baseline);
  const status = $derived(cloudManager.status);
  const linked = $derived(status?.state === 'linked');
  const linkedPeople = $derived(status?.signInLinkedAccounts ?? 0);
  const methods = $derived(
    signInMethodsState({
      password: saved?.passwordLogin.enabled ?? true,
      provider: saved?.oauth.enabled ?? false,
      frameleaf: linked,
    }),
  );

  const hero = $derived(
    linked
      ? people !== null && linkedPeople < people
        ? {
            tone: 'warn' as const,
            icon: mdiHomeOutline,
            title: $t('frameleaf_security_who_some_home', { values: { count: people - linkedPeople } }),
            body: $t('frameleaf_security_who_some_home_body'),
          }
        : {
            tone: 'good' as const,
            icon: mdiShieldCheckOutline,
            title: $t('frameleaf_security_who_everyone'),
            body: $t('frameleaf_security_who_everyone_body'),
          }
      : {
          tone: 'quiet' as const,
          icon: mdiHomeOutline,
          title: $t('frameleaf_security_who_home_only'),
          body: $t('frameleaf_security_who_home_only_body'),
        },
  );

  const rows = $derived<LinkRow[]>([
    {
      icon: mdiKeyOutline,
      title: $t('frameleaf_security_who_methods'),
      body: $t(`frameleaf_security_methods_${methods}`),
      href: commandCenterUrl('security', 'authentication'),
    },
    {
      icon: mdiShieldAccountOutline,
      title: $t('frameleaf_security_who_frameleaf'),
      body: linked
        ? people === null
          ? $t('frameleaf_security_who_frameleaf_linked', { values: { count: linkedPeople } })
          : $t('frameleaf_security_who_frameleaf_of', { values: { count: linkedPeople, people } })
        : $t('frameleaf_security_who_frameleaf_not_linked'),
      href: commandCenterUrl('security', 'frameleaf-signin'),
    },
    {
      icon: mdiEarth,
      title: $t('frameleaf_security_who_away'),
      body: linked ? $t('frameleaf_security_who_away_frameleaf') : $t('frameleaf_security_who_away_off'),
      href: commandCenterUrl('cloud', 'cloud-remote'),
    },
  ]);
</script>

<KitPage>
  <Hero
    tone={hero.tone}
    icon={hero.icon}
    title={hero.title}
    body={hero.body}
    label={$t('frameleaf_security_who_status')}
  />

  <Section title={$t('frameleaf_security_who_ways')} description={$t('frameleaf_security_who_ways_description')}>
    <Links stacked {rows} />
  </Section>

  <Section title={$t('frameleaf_security_who_accounts')}>
    <Links
      rows={[
        {
          icon: mdiAccountMultipleOutline,
          title: $t('frameleaf_security_who_people'),
          body:
            people === null
              ? $t('frameleaf_security_who_people_body')
              : $t('frameleaf_security_who_people_count', { values: { count: people } }),
          href: commandCenterUrl('users'),
        },
        {
          icon: mdiAccountLockOutline,
          title: $t('frameleaf_settings_area_privacy'),
          body: $t('frameleaf_security_who_yours_elsewhere'),
          href: commandCenterUrl('privacy'),
        },
      ]}
    />
  </Section>
</KitPage>
