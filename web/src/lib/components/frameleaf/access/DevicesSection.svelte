<script lang="ts">
  /**
   * Signed-in devices, from the `devices` section of the design template's `PersonalAccess`:
   * every session of this account with when it was last active, "This device" for the current
   * one, Sign out for each other one, and Sign out other devices. This device is never signed
   * out from here; the server keeps the current session when signing out the others.
   *
   * FL-367: two groups, "Used lately" and "Not used for a while" (30 days), so a lost phone is not
   * buried in a long list; the second group can be signed out at once. Each row says since when.
   *
   * Drawn as the approved prototype's `Devices` (`settings-v2/cloud/Personal.jsx`): a hero that says
   * how many devices are signed in (or that some have not been used for a while, with "Sign those
   * out"), the devices as rows, "Sign out everywhere else…" on the list, and API keys linked below.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { idleDevices } from '$lib/components/frameleaf/settings/security/sign-in';
  import { describeSession, otherSessions, sessionDeviceName, sortSessions } from '$lib/frameleaf/personal-access';
  import { locale } from '$lib/stores/preferences.store';
  import { handleError } from '$lib/utils/handle-error';
  import { deleteAllSessions, deleteSession, getSessions, type SessionResponseDto } from '@frameleaf/sdk';
  import { toastManager } from '@frameleaf/ui';
  import { confirmFrameleaf } from '$lib/frameleaf/confirm';
  import { DateTime } from 'luxon';
  import { t, type Translations } from 'svelte-i18n';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import Item from '$lib/components/frameleaf/settings/kit/Item.svelte';
  import ItemList from '$lib/components/frameleaf/settings/kit/ItemList.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Links from '$lib/components/frameleaf/settings/kit/Links.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { mdiCellphone, mdiDevices, mdiKeyOutline, mdiLaptop, mdiRobotOutline, mdiTablet } from '@mdi/js';

  let { sessions = $bindable([]) }: { sessions?: SessionResponseDto[] } = $props();

  let working = $state(false);

  const sorted = $derived(sortSessions(sessions));
  const others = $derived(otherSessions(sessions));
  const idle = $derived(idleDevices(sessions));
  const idleIds = $derived(new Set(idle.map((session) => session.id)));
  const recent = $derived(sorted.filter((session) => !idleIds.has(session.id)));
  const idleSorted = $derived(sorted.filter((session) => idleIds.has(session.id)));
  const since = (session: SessionResponseDto) =>
    DateTime.fromISO(session.createdAt, { locale: $locale }).toLocaleString(DateTime.DATE_MED);

  const lastActive = (session: SessionResponseDto) =>
    DateTime.fromISO(session.updatedAt, { locale: $locale }).toLocaleString(DateTime.DATETIME_MED);

  /** "Safari on a Mac", "Frameleaf app on an iPhone", "A script or tool" (prototype Devices). */
  const deviceName = (session: SessionResponseDto) =>
    sessionDeviceName(session, (key, options) => $t(key as Translations, options));

  /** A picture of the kind of device, from what its app reported. */
  const deviceIcon = (session: SessionResponseDto) => {
    const described = describeSession(session);
    if (described.kind === 'unknown') {
      return mdiRobotOutline;
    }
    if (described.device === 'ipad' || described.device === 'android_tablet') {
      return mdiTablet;
    }
    if (described.device === 'iphone' || described.device === 'android_phone') {
      return mdiCellphone;
    }
    return mdiLaptop;
  };

  const refresh = async () => {
    try {
      sessions = await getSessions();
    } catch (error) {
      handleError(error, $t('frameleaf_access_devices_load_failed'));
    }
  };

  const signOut = async (session: SessionResponseDto) => {
    const confirmed = await confirmFrameleaf({
      title: $t('frameleaf_access_device_sign_out'),
      prompt: $t('frameleaf_access_device_sign_out_prompt', {
        values: { device: deviceName(session) },
      }),
      confirmText: $t('frameleaf_access_device_sign_out'),
      danger: true,
    });
    if (!confirmed) {
      return;
    }

    working = true;
    try {
      await deleteSession({ id: session.id });
      toastManager.primary($t('frameleaf_access_device_signed_out'));
    } catch (error) {
      handleError(error, $t('errors.unable_to_log_out_device'));
    } finally {
      working = false;
      await refresh();
    }
  };

  /** FL-367: sign out every device not used for a while, after one confirmation. */
  const signOutIdle = async () => {
    const confirmed = await confirmFrameleaf({
      title: $t('frameleaf_access_devices_sign_out_idle'),
      prompt: $t('frameleaf_access_devices_sign_out_idle_prompt', { values: { count: idle.length } }),
      confirmText: $t('frameleaf_access_devices_sign_out_idle'),
      danger: true,
    });
    if (!confirmed) {
      return;
    }
    working = true;
    try {
      for (const session of idle) {
        await deleteSession({ id: session.id });
      }
      toastManager.primary($t('frameleaf_access_devices_signed_out_idle'));
    } catch (error) {
      handleError(error, $t('errors.unable_to_log_out_device'));
    } finally {
      working = false;
      await refresh();
    }
  };

  const signOutOthers = async () => {
    const confirmed = await confirmFrameleaf({
      title: $t('frameleaf_access_devices_sign_out_others'),
      prompt: $t('frameleaf_access_devices_sign_out_others_prompt', { values: { count: others.length } }),
      confirmText: $t('frameleaf_access_devices_sign_out_others'),
      danger: true,
    });
    if (!confirmed) {
      return;
    }

    working = true;
    try {
      await deleteAllSessions();
      toastManager.primary($t('frameleaf_access_devices_signed_out_others'));
    } catch (error) {
      handleError(error, $t('errors.unable_to_log_out_all_devices'));
    } finally {
      working = false;
      await refresh();
    }
  };
</script>

{#snippet rows(items: SessionResponseDto[], quiet: boolean)}
  <ItemList>
    {#each items as session (session.id)}
      {@const name = deviceName(session)}
      <Item
        icon={deviceIcon(session)}
        {quiet}
        {name}
        detail={$t('frameleaf_access_device_since', { values: { date: since(session) } })}
        tone={quiet && !session.current ? 'warn' : 'good'}
        status={session.current
          ? $t('frameleaf_access_device_current')
          : quiet
            ? $t('frameleaf_access_devices_idle')
            : $t('frameleaf_access_devices_recent')}
        note={session.current
          ? $t('frameleaf_access_device_active_now')
          : $t('frameleaf_access_device_last_active', { values: { date: lastActive(session) } })}
      >
        {#snippet action()}
          {#if !session.current}
            <Button
              label={$t('frameleaf_access_device_sign_out_named', { values: { device: name } })}
              disabled={working}
              onclick={() => signOut(session)}>{$t('frameleaf_access_device_sign_out')}</Button
            >
          {/if}
        {/snippet}
      </Item>
    {/each}
  </ItemList>
{/snippet}

{#snippet signOutIdleAction()}
  <Button variant="primary" disabled={working} onclick={signOutIdle}
    >{$t('frameleaf_access_devices_sign_out_those')}</Button
  >
{/snippet}

{#snippet everywhereElse()}
  <Button disabled={working} onclick={signOutOthers}>{$t('frameleaf_access_devices_sign_out_everywhere')}</Button>
{/snippet}

<KitPage>
  {#if idle.length > 0}
    <Hero
      tone="warn"
      icon={mdiDevices}
      title={$t('frameleaf_access_devices_hero_idle', { values: { count: idle.length } })}
      body={$t('frameleaf_access_devices_hero_idle_body')}
      label={$t('frameleaf_access_devices_title')}
      actions={signOutIdleAction}
    />
  {:else if sorted.length > 0}
    <Hero
      tone="good"
      icon={mdiDevices}
      title={sorted.length === 1
        ? $t('frameleaf_access_devices_hero_one')
        : $t('frameleaf_access_devices_hero_many', { values: { count: sorted.length } })}
      body={sorted.length === 1
        ? $t('frameleaf_access_devices_hero_one_body')
        : $t('frameleaf_access_devices_hero_many_body')}
      label={$t('frameleaf_access_devices_title')}
    />
  {/if}

  <Section title={$t('frameleaf_access_devices_recent')} action={others.length > 0 ? everywhereElse : undefined}>
    {#if recent.length > 0}
      {@render rows(recent, false)}
    {:else}
      <p class="empty">{$t('frameleaf_access_devices_empty')}</p>
    {/if}
  </Section>

  {#if idleSorted.length > 0}
    <Section title={$t('frameleaf_access_devices_idle')} description={$t('frameleaf_access_devices_idle_description')}>
      {@render rows(idleSorted, true)}
    </Section>
  {/if}

  <Section title={$t('frameleaf_access_devices_own')}>
    <Links
      rows={[
        {
          icon: mdiKeyOutline,
          title: $t('frameleaf_access_keys_title'),
          body: $t('frameleaf_access_devices_keys_body'),
          href: commandCenterUrl('privacy', 'api-keys'),
        },
      ]}
    />
  </Section>
</KitPage>

<style>
  .empty {
    margin: 0;
    padding-bottom: var(--fl-space-5);
    color: var(--fl-muted);
  }
</style>
