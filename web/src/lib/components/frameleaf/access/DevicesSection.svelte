<script lang="ts">
  /**
   * Signed-in devices, from the `devices` section of the design template's `PersonalAccess`:
   * every session of this account with when it was last active, "This device" for the current
   * one, Sign out for each other one, and Sign out other devices. This device is never signed
   * out from here; the server keeps the current session when signing out the others.
   *
   * FL-367: two groups, "Used lately" and "Not used for a while" (30 days), so a lost phone is not
   * buried in a long list; the second group can be signed out at once. Each row says since when.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { idleDevices } from '$lib/components/frameleaf/settings/security/sign-in';
  import { otherSessions, sessionDeviceName, sortSessions } from '$lib/frameleaf/personal-access';
  import { locale } from '$lib/stores/preferences.store';
  import { handleError } from '$lib/utils/handle-error';
  import { deleteAllSessions, deleteSession, getSessions, type SessionResponseDto } from '@frameleaf/sdk';
  import { toastManager } from '@frameleaf/ui';
  import { confirmFrameleaf } from '$lib/frameleaf/confirm';
  import { DateTime } from 'luxon';
  import { t } from 'svelte-i18n';
  import './access.css';

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
        values: { device: sessionDeviceName(session, $t('frameleaf_access_device_unknown')) },
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

<section class="fl-access-section" aria-labelledby="fl-access-devices">
  <div class="fl-access-head">
    <div>
      <h3 id="fl-access-devices">{$t('frameleaf_access_devices_title')}</h3>
      <p>{$t('frameleaf_access_devices_description')}</p>
    </div>
    <Button disabled={working || others.length === 0} onclick={signOutOthers}>
      {$t('frameleaf_access_devices_sign_out_others')}
    </Button>
  </div>
  {#if sorted.length > 0}
    {#if idle.length > 0}
      <div class="fl-access-notice idle">
        <p>{$t('frameleaf_access_devices_idle_notice', { values: { count: idle.length } })}</p>
        <Button disabled={working} onclick={signOutIdle}>{$t('frameleaf_access_devices_sign_out_idle')}</Button>
      </div>
    {/if}
    {#snippet list(items: SessionResponseDto[])}
      <ul class="fl-access-list">
        {#each items as session (session.id)}
          <li class="fl-access-item">
            <div>
              <strong>{sessionDeviceName(session, $t('frameleaf_access_device_unknown'))}</strong>
              <small>{$t('frameleaf_access_device_last_active', { values: { date: lastActive(session) } })}</small>
              <small>{$t('frameleaf_access_device_since', { values: { date: since(session) } })}</small>
            </div>
            {#if session.current}
              <span class="fl-access-status">{$t('frameleaf_access_device_current')}</span>
            {:else}
              <Button disabled={working} onclick={() => signOut(session)}>
                {$t('frameleaf_access_device_sign_out')}
              </Button>
            {/if}
          </li>
        {/each}
      </ul>
    {/snippet}
    <h4 class="group">{$t('frameleaf_access_devices_recent')}</h4>
    {@render list(recent)}
    {#if idleSorted.length > 0}
      <h4 class="group">{$t('frameleaf_access_devices_idle')}</h4>
      {@render list(idleSorted)}
    {/if}
  {:else}
    <p class="fl-access-empty">{$t('frameleaf_access_devices_empty')}</p>
  {/if}
</section>

<style>
  .group {
    margin: var(--fl-space-4) 0 var(--fl-space-2);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    font-weight: 600;
  }
  .idle {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--fl-space-3);
  }
  .idle p {
    margin: 0;
  }
</style>
