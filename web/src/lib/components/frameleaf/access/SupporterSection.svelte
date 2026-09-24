<script lang="ts">
  /**
   * Supporter status, from the `supporter` section of the design template's `PersonalAccess`.
   *
   * - Personal: whether this account has supporter status and since when, Activate or Remove, and
   *   the supporter badge preference while it is active.
   * - Administrators also see the server support key: registered or not, its product, a masked
   *   key reference and activation date, Register and Remove. Personal and server actions are
   *   separate buttons calling separate endpoints; a personal key is never registered for the
   *   server and the reverse.
   * - The attribution notice says plainly that no Frameleaf purchase or activation service exists;
   *   no purchase link is offered.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import SettingToggle from '$lib/components/frameleaf/settings/SettingToggle.svelte';
  import SupporterKeyDialog from '$lib/components/frameleaf/access/SupporterKeyDialog.svelte';
  import { withoutLockedRuleIds } from '$lib/frameleaf/locked-rules';
  import { maskLicenseKey } from '$lib/frameleaf/personal-access';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { handleError } from '$lib/utils/handle-error';
  import {
    deleteServerLicense,
    deleteUserLicense,
    getAboutInfo,
    getMyUser,
    getServerLicense,
    isHttpError,
    updateMyPreferences,
    type LicenseResponseDto,
  } from '@immich/sdk';
  import { modalManager, toastManager } from '@immich/ui';
  import { confirmFrameleaf } from '$lib/frameleaf/confirm';
  import { DateTime } from 'luxon';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import './access.css';

  let serverLicensed = $state(false);
  let serverLicense = $state<LicenseResponseDto | null>(null);
  let working = $state(false);

  const isAdmin = $derived(authManager.user.isAdmin);
  const personal = $derived(authManager.user.license ?? null);
  const showBadge = $derived(authManager.preferences.purchase.showSupportBadge);

  const date = (value: string) => DateTime.fromISO(value, { locale: $locale }).toLocaleString(DateTime.DATE_MED);

  const refresh = async () => {
    try {
      const [user, about] = await Promise.all([getMyUser(), getAboutInfo()]);
      authManager.setUser(user);
      serverLicensed = about.licensed;
      serverLicense = isAdmin && about.licensed ? await readServerLicense() : null;
      authManager.isPurchased = !!user.license || about.licensed;
    } catch (error) {
      handleError(error, $t('frameleaf_access_supporter_load_failed'));
    }
  };

  const readServerLicense = async () => {
    try {
      return await getServerLicense();
    } catch (error) {
      if (isHttpError(error) && error.status === 404) {
        return null;
      }
      throw error;
    }
  };

  const activate = async (kind: 'personal' | 'server') => {
    if (!(await modalManager.show(SupporterKeyDialog, { kind }))) {
      return;
    }

    toastManager.primary(
      kind === 'server' ? $t('frameleaf_access_server_key_registered') : $t('frameleaf_access_supporter_activated'),
    );
    await refresh();
  };

  const removePersonal = async () => {
    const confirmed = await confirmFrameleaf({
      title: $t('frameleaf_access_supporter_remove_title'),
      prompt: $t('frameleaf_access_supporter_remove_prompt'),
      confirmText: $t('frameleaf_access_supporter_remove'),
      danger: true,
    });
    if (!confirmed) {
      return;
    }
    working = true;
    try {
      await deleteUserLicense();
      toastManager.primary($t('frameleaf_access_supporter_removed'));
    } catch (error) {
      handleError(error, $t('errors.failed_to_remove_product_key'));
    } finally {
      working = false;
      await refresh();
    }
  };

  const removeServer = async () => {
    const confirmed = await confirmFrameleaf({
      title: $t('frameleaf_access_server_key_remove'),
      prompt: $t('frameleaf_access_server_key_remove_prompt'),
      confirmText: $t('frameleaf_access_server_key_remove'),
      danger: true,
    });
    if (!confirmed) {
      return;
    }
    working = true;
    try {
      await deleteServerLicense();
      toastManager.primary($t('frameleaf_access_server_key_removed'));
    } catch (error) {
      handleError(error, $t('errors.failed_to_remove_product_key'));
    } finally {
      working = false;
      await refresh();
    }
  };

  const setBadge = async (value: boolean) => {
    try {
      const response = await updateMyPreferences({
        userPreferencesUpdateDto: { purchase: { showSupportBadge: value } },
      });
      authManager.setPreferences(withoutLockedRuleIds(response));
    } catch (error) {
      handleError(error, $t('errors.unable_to_update_settings'));
    }
  };

  onMount(() => void refresh());
</script>

<section class="fl-access-section" aria-labelledby="fl-access-supporter">
  <div class="fl-access-head">
    <div>
      <h3 id="fl-access-supporter">{$t('frameleaf_access_supporter_title')}</h3>
      <p>
        {personal
          ? $t('frameleaf_access_supporter_active_since', { values: { date: date(personal.activatedAt) } })
          : $t('frameleaf_access_supporter_inactive')}
      </p>
    </div>
    {#if personal}
      <Button disabled={working} onclick={removePersonal}>{$t('frameleaf_access_supporter_remove')}</Button>
    {:else}
      <Button disabled={working} onclick={() => activate('personal')}>
        {$t('frameleaf_access_supporter_activate_short')}
      </Button>
    {/if}
  </div>

  {#if personal || serverLicensed}
    <SettingToggle
      title={$t('frameleaf_access_supporter_badge')}
      subtitle={$t('frameleaf_access_supporter_badge_description')}
      checked={showBadge}
      onToggle={setBadge}
    />
  {/if}

  {#if isAdmin}
    <div class="fl-access-section">
      <h3>{$t('frameleaf_access_server_key_title')}</h3>
      <dl class="fl-access-facts">
        <dt>{$t('frameleaf_access_server_key_status')}</dt>
        <dd>
          {serverLicensed ? $t('frameleaf_access_server_key_registered_state') : $t('frameleaf_access_server_key_none')}
        </dd>
        <dt>{$t('frameleaf_access_server_key_product')}</dt>
        <dd>{$t('frameleaf_access_server_key_product_name')}</dd>
        {#if serverLicense}
          <dt>{$t('frameleaf_access_server_key_reference')}</dt>
          <dd><code>{maskLicenseKey(serverLicense.licenseKey)}</code></dd>
          <dt>{$t('frameleaf_access_server_key_activated')}</dt>
          <dd>{date(serverLicense.activatedAt)}</dd>
        {/if}
      </dl>
      <div class="fl-access-actions">
        {#if !serverLicensed}
          <Button disabled={working} onclick={() => activate('server')}>
            {$t('frameleaf_access_server_key_register')}
          </Button>
        {/if}
        <Button disabled={working || !serverLicensed} onclick={removeServer}>
          {$t('frameleaf_access_server_key_remove')}
        </Button>
      </div>
    </div>
  {/if}

  <div class="fl-access-notice">
    <strong>{$t('frameleaf_access_supporter_attribution_title')}</strong>
    <p>{$t('frameleaf_access_supporter_attribution')}</p>
    <p>{$t('frameleaf_access_supporter_help')}</p>
  </div>
</section>
