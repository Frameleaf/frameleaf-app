<script lang="ts">
  /**
   * Personal › Your sign-in & privacy (FL-367, the approved prototype's `settings-v2/cloud/Personal.jsx`):
   * what belongs to the person signed in. It opens on "is my account safe" (protected, or the one
   * thing to look at: a device not used for a while, or no Locked PIN yet), then two short groups,
   * each row with its state: Signing in (how you sign in, signed-in devices, and API keys under
   * Advanced) and Locked photos (Locked PIN, Always Locked). An administrator also sees where the
   * rules for everyone are set.
   */
  import Advanced from '$lib/components/frameleaf/settings/kit/Advanced.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Links, { type LinkRow } from '$lib/components/frameleaf/settings/kit/Links.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import { idleDevices } from '$lib/components/frameleaf/settings/security/sign-in';
  import { commandCenterUrl, type SettingsHostSection } from '$lib/frameleaf/settings-areas';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import {
    getApiKeys,
    getAuthStatus,
    getSessions,
    type ApiKeyResponseDto,
    type AuthStatusResponseDto,
    type SessionResponseDto,
  } from '@frameleaf/sdk';
  import { mdiAlertCircleOutline, mdiShieldCheckOutline, mdiShieldLockOutline } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  let { sections }: { sections: SettingsHostSection[] } = $props();

  let auth = $state<AuthStatusResponseDto | null>(null);
  let sessions = $state<SessionResponseDto[] | null>(null);
  let keys = $state<ApiKeyResponseDto[] | null>(null);
  onMount(() => {
    void getAuthStatus()
      .then((value) => (auth = value))
      .catch(() => {});
    void getSessions()
      .then((value) => (sessions = value))
      .catch(() => {});
    void getApiKeys()
      .then((value) => (keys = value))
      .catch(() => {});
  });

  const idle = $derived(sessions ? idleDevices(sessions) : []);
  const noPin = $derived(auth ? !auth.pinCode : false);

  const hero = $derived(
    idle.length > 0
      ? {
          tone: 'warn' as const,
          icon: mdiAlertCircleOutline,
          title: $t('frameleaf_privacy_hero_idle', { values: { count: idle.length } }),
          body: $t('frameleaf_privacy_hero_idle_body'),
        }
      : noPin
        ? {
            tone: 'quiet' as const,
            icon: mdiShieldLockOutline,
            title: $t('frameleaf_privacy_hero_no_pin'),
            body: $t('frameleaf_privacy_hero_no_pin_body'),
          }
        : {
            tone: 'good' as const,
            icon: mdiShieldCheckOutline,
            title: $t('frameleaf_privacy_hero_ok'),
            body: $t('frameleaf_privacy_hero_ok_body'),
          },
  );

  /** What each row says under its name: the current state where it is known, else what the page holds. */
  const rowState = (key: string, fallback: string) => {
    switch (key) {
      case 'password': {
        return auth
          ? $t(auth.password ? 'frameleaf_privacy_password_set' : 'frameleaf_privacy_password_none', {
              values: { email: authManager.user.email },
            })
          : fallback;
      }
      case 'authorized-devices': {
        return sessions
          ? idle.length > 0
            ? $t('frameleaf_privacy_devices_idle', { values: { count: sessions.length, idle: idle.length } })
            : $t('frameleaf_privacy_devices_count', { values: { count: sessions.length } })
          : fallback;
      }
      case 'api-keys': {
        return keys ? $t('frameleaf_privacy_keys_count', { values: { count: keys.length } }) : fallback;
      }
      case 'user-pin-code-settings': {
        return auth ? $t(auth.pinCode ? 'frameleaf_privacy_pin_set' : 'frameleaf_privacy_pin_none') : fallback;
      }
      default: {
        return fallback;
      }
    }
  };
  const row = (key: string): LinkRow[] => {
    const section = sections.find((item) => item.key === key);
    return section
      ? [
          {
            icon: section.icon,
            title: section.title,
            body: rowState(key, section.subtitle),
            href: commandCenterUrl('privacy', key),
          },
        ]
      : [];
  };
</script>

<KitPage>
  <Hero tone={hero.tone} icon={hero.icon} title={hero.title} body={hero.body} label={$t('frameleaf_privacy_status')} />

  <Section title={$t('frameleaf_privacy_signing_in')}>
    <Links stacked rows={[...row('password'), ...row('oauth'), ...row('authorized-devices')]} />
    <Advanced>
      <Links stacked rows={row('api-keys')} />
    </Advanced>
  </Section>

  <Section title={$t('frameleaf_privacy_locked')} description={$t('frameleaf_privacy_locked_description')}>
    <Links stacked rows={[...row('user-pin-code-settings'), ...row('suppressed-content')]} />
  </Section>

  {#if authManager.user.isAdmin}
    <Section title={$t('frameleaf_privacy_everyone')}>
      <Links
        rows={[
          {
            icon: mdiShieldLockOutline,
            title: $t('frameleaf_settings_area_security'),
            body: $t('frameleaf_privacy_everyone_body'),
            href: commandCenterUrl('security'),
          },
        ]}
      />
    </Section>
  {/if}
</KitPage>
