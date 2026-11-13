<script lang="ts">
  /**
   * Personal › Your sign-in & privacy (FL-367, the approved prototype's `settings-v2/cloud/Personal.jsx`):
   * what belongs to the person signed in. It opens on "is my account safe" (protected, or the one
   * thing to look at: a device not used for a while, or no Locked PIN yet), then two short groups,
   * each row with its state: Signing in (how you sign in, signed-in devices, FL-860 connected apps,
   * FL-824 account activity, and API keys under Advanced) and Locked photos (Locked PIN, Always Locked, and FL-721 Locked encryption). An administrator also sees where the
   * rules for everyone are set.
   */
  import { goto } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Advanced from '$lib/components/frameleaf/settings/kit/Advanced.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Item from '$lib/components/frameleaf/settings/kit/Item.svelte';
  import ItemList from '$lib/components/frameleaf/settings/kit/ItemList.svelte';
  import type { KitTone } from '$lib/components/frameleaf/settings/kit/Pill.svelte';
  import TextLink from '$lib/components/frameleaf/settings/kit/TextLink.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import { idleDevices } from '$lib/components/frameleaf/settings/security/sign-in';
  import {
    ACTIVITY_PAGE_SIZE,
    activityDay,
    activityTime,
    daysAgo,
    lastSignIn,
    recentFailures,
    type ActivityEvent,
  } from '$lib/frameleaf/account-activity';
  import { locale } from '$lib/stores/preferences.store';
  import { commandCenterUrl, type SettingsHostSection } from '$lib/frameleaf/settings-areas';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { lockedEncryptionView } from '$lib/frameleaf/locked-encryption';
  import { staleMonths } from '$lib/frameleaf/connected-apps';
  import {
    getApiKeys,
    getAuthStatus,
    getFrameleafAccountLink,
    getLockedEncryption,
    getMyActivity,
    getOAuthAppGrants,
    getSessions,
    LockedEncryptionMode,
    type ApiKeyResponseDto,
    type AuthStatusResponseDto,
    type FrameleafAccountLinkResponseDto,
    type LockedEncryptionStatusResponseDto,
    type OAuthAppGrantDto,
    type SessionResponseDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiAlertCircleOutline, mdiChevronRight, mdiShieldCheckOutline, mdiShieldLockOutline } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  let { sections }: { sections: SettingsHostSection[] } = $props();

  let auth = $state<AuthStatusResponseDto | null>(null);
  let sessions = $state<SessionResponseDto[] | null>(null);
  let keys = $state<ApiKeyResponseDto[] | null>(null);
  let frameleaf = $state<FrameleafAccountLinkResponseDto | null>(null);
  let encryption = $state<LockedEncryptionStatusResponseDto | null>(null);
  let apps = $state<OAuthAppGrantDto[] | null>(null);
  let activity = $state<ActivityEvent[] | null>(null);
  onMount(() => {
    // FL-824: the account activity row says when you last signed in, or that sign-ins did not work
    void (async () => {
      try {
        const page = await getMyActivity({ take: ACTIVITY_PAGE_SIZE });
        activity = page.events;
      } catch {
        // the row says what the page holds instead
      }
    })();
    void (async () => {
      try {
        encryption = await getLockedEncryption();
      } catch {
        // the row says what the page holds instead
      }
    })();
    void getAuthStatus()
      .then((value) => (auth = value))
      .catch(() => {});
    void getSessions()
      .then((value) => (sessions = value))
      .catch(() => {});
    void getApiKeys()
      .then((value) => (keys = value))
      .catch(() => {});
    void getFrameleafAccountLink()
      .then((value) => (frameleaf = value))
      .catch(() => {});
    // FL-860: the connected apps row says how many apps can use the library
    void getOAuthAppGrants()
      .then((value) => (apps = value))
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
            // FL-859: the "is my account safe" hero counts a passkey as protection; FL-831: and two-step sign-in
            body: $t(
              auth?.twoFactorEnabled
                ? auth.hasPasskeys
                  ? 'frameleaf_two_step_privacy_hero_passkey_body'
                  : 'frameleaf_two_step_privacy_hero_body'
                : auth?.hasPasskeys
                  ? 'frameleaf_privacy_hero_ok_passkey_body'
                  : 'frameleaf_privacy_hero_ok_body',
            ),
          },
  );

  /** What each row says under its name: the current state where it is known, else what the page holds. */
  const rowState = (key: string, fallback: string) => {
    switch (key) {
      case 'password': {
        // "How you sign in": the ways in, as the prototype's row says them.
        if (!auth) {
          return fallback;
        }
        const password = auth.password;
        // FL-859: a passkey is a way in too (FL-767 prototype: "Passkey, password and Frameleaf account")
        if (auth.hasPasskeys && !password) {
          return $t(frameleaf?.linked ? 'frameleaf_privacy_ways_passkey_frameleaf' : 'frameleaf_privacy_ways_passkey');
        }
        if (auth.hasPasskeys) {
          return $t(
            frameleaf?.linked
              ? 'frameleaf_privacy_ways_passkey_password_frameleaf'
              : 'frameleaf_privacy_ways_passkey_password',
          );
        }
        return frameleaf?.linked
          ? $t(password ? 'frameleaf_privacy_ways_password_frameleaf' : 'frameleaf_privacy_ways_frameleaf')
          : $t(password ? 'frameleaf_privacy_ways_password' : 'frameleaf_privacy_password_none', {
              values: { email: authManager.user.email },
            });
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
      case 'connected-apps': {
        return apps ? $t('frameleaf_privacy_apps_count', { values: { count: apps.length } }) : fallback;
      }
      case 'account-activity': {
        if (!activity) {
          return fallback;
        }
        const now = new Date();
        const failures = recentFailures(activity, now);
        if (failures) {
          return $t('frameleaf_account_activity_row_failed', { values: { count: failures.events.length } });
        }
        const last = lastSignIn(activity);
        if (!last) {
          return activity.length === 0 ? $t('frameleaf_account_activity_row_none') : fallback;
        }
        const time = activityTime(last.createdAt, $locale);
        const days = daysAgo(last.createdAt, now);
        return days <= 0
          ? $t('frameleaf_account_activity_row_last_today', { values: { time } })
          : days === 1
            ? $t('frameleaf_account_activity_row_last_yesterday', { values: { time } })
            : $t('frameleaf_account_activity_row_last_on', {
                values: { day: activityDay($t, last.createdAt, now, $locale) },
              });
      }
      case 'user-pin-code-settings': {
        return auth ? $t(auth.pinCode ? 'frameleaf_privacy_pin_set' : 'frameleaf_privacy_pin_none') : fallback;
      }
      case 'locked-encryption': {
        if (!encryption) {
          return fallback;
        }
        const view = lockedEncryptionView(encryption);
        return $t(
          view === 'off'
            ? 'frameleaf_le_privacy_off'
            : view === 'working'
              ? 'frameleaf_le_privacy_working'
              : view === 'finish'
                ? encryption.mode === LockedEncryptionMode.Advanced
                  ? 'frameleaf_le_privacy_finish_passphrase'
                  : 'frameleaf_le_privacy_finish_pin'
                : view === 'decrypting'
                  ? 'frameleaf_le_privacy_decrypting'
                  : view === 'needs'
                    ? 'frameleaf_le_privacy_needs'
                    : view === 'advanced'
                      ? 'frameleaf_le_privacy_on_advanced'
                      : 'frameleaf_le_privacy_on_pin',
        );
      }
      default: {
        return fallback;
      }
    }
  };
  /** The dot beside a row's state: green when it is in order, amber when it needs a look. */
  const rowTone = (key: string): KitTone => {
    switch (key) {
      case 'password': {
        if (!auth) {
          return 'off';
        }
        return auth.password || auth.hasPasskeys || frameleaf?.linked ? 'good' : 'warn';
      }
      case 'authorized-devices': {
        return sessions ? (idle.length > 0 ? 'warn' : 'good') : 'off';
      }
      case 'api-keys': {
        return keys && keys.length > 0 ? 'good' : 'off';
      }
      case 'connected-apps': {
        if (!apps || apps.length === 0) {
          return 'off';
        }
        return apps.some((app) => staleMonths(app.lastUsedAt) !== null) ? 'warn' : 'good';
      }
      case 'account-activity': {
        if (!activity || activity.length === 0) {
          return 'off';
        }
        return recentFailures(activity, new Date()) ? 'warn' : 'good';
      }
      case 'user-pin-code-settings': {
        return auth?.pinCode ? 'good' : 'off';
      }
      case 'locked-encryption': {
        return encryption && lockedEncryptionView(encryption) !== 'off' ? 'good' : 'off';
      }
      default: {
        return 'good';
      }
    }
  };
  type Row = { icon: string; name: string; detail: string; status: string; tone: KitTone; href: string };
  const row = (key: string): Row[] => {
    const section = sections.find((item) => item.key === key);
    if (!section) {
      return [];
    }
    const status = rowState(key, '');
    return [
      {
        icon: section.icon,
        name: section.title,
        detail: section.subtitle,
        status,
        tone: status ? rowTone(key) : 'good',
        href: commandCenterUrl('privacy', key),
      },
    ];
  };
</script>

{#snippet items(rows: Row[])}
  <ItemList>
    {#each rows as item (item.name)}
      <Item
        icon={item.icon}
        off={item.tone === 'off'}
        name={item.name}
        detail={item.detail}
        tone={item.tone}
        status={item.status || undefined}
      >
        {#snippet action()}
          <Button label={`${$t('frameleaf_security_who_open')}: ${item.name}`} onclick={() => goto(item.href)}
            >{$t('frameleaf_security_who_open')}<Icon icon={mdiChevronRight} size="1em" aria-hidden /></Button
          >
        {/snippet}
      </Item>
    {/each}
  </ItemList>
{/snippet}

<KitPage>
  <Hero tone={hero.tone} icon={hero.icon} title={hero.title} body={hero.body} label={$t('frameleaf_privacy_status')} />

  <Section title={$t('frameleaf_privacy_signing_in')}>
    <!-- The sign-in provider is a row of "How you sign in" (Personal.jsx MySignIn), not a page of its own. -->
    {@render items([
      ...row('password'),
      ...row('authorized-devices'),
      ...row('connected-apps'),
      ...row('account-activity'),
    ])}
    <Advanced>
      {@render items(row('api-keys'))}
    </Advanced>
  </Section>

  <Section title={$t('frameleaf_privacy_locked')} description={$t('frameleaf_privacy_locked_description')}>
    {@render items([...row('user-pin-code-settings'), ...row('suppressed-content'), ...row('locked-encryption')])}
    {#if authManager.user.isAdmin}
      <p class="hint">
        {$t('frameleaf_privacy_everyone_hint')}
        <TextLink href={commandCenterUrl('security')}>{$t('frameleaf_settings_area_security')}</TextLink>.
      </p>
    {/if}
  </Section>
</KitPage>

<style>
  .hint {
    margin: 0;
    padding: 0 0 var(--fl-space-5);
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
    line-height: 1.5;
  }
</style>
