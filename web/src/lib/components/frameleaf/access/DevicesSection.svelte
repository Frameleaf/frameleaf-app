<script lang="ts">
  /**
   * Signed-in devices, from the `devices` section of the design template's `PersonalAccess`:
   * every session of this account with when it was last active, "This device" for the current
   * one, Sign out for each other one, and Sign out other devices. This device is never signed
   * out from here; the server keeps the current session when signing out the others.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { otherSessions, sessionDeviceName, sortSessions } from '$lib/frameleaf/personal-access';
  import { locale } from '$lib/stores/preferences.store';
  import { handleError } from '$lib/utils/handle-error';
  import { deleteAllSessions, deleteSession, getSessions, type SessionResponseDto } from '@immich/sdk';
  import { toastManager } from '@immich/ui';
  import { confirmFrameleaf } from '$lib/frameleaf/confirm';
  import { DateTime } from 'luxon';
  import { t } from 'svelte-i18n';
  import './access.css';

  let { sessions = $bindable([]) }: { sessions?: SessionResponseDto[] } = $props();

  let working = $state(false);

  const sorted = $derived(sortSessions(sessions));
  const others = $derived(otherSessions(sessions));

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
    <ul class="fl-access-list">
      {#each sorted as session (session.id)}
        <li class="fl-access-item">
          <div>
            <strong>{sessionDeviceName(session, $t('frameleaf_access_device_unknown'))}</strong>
            <small>{$t('frameleaf_access_device_last_active', { values: { date: lastActive(session) } })}</small>
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
  {:else}
    <p class="fl-access-empty">{$t('frameleaf_access_devices_empty')}</p>
  {/if}
</section>
