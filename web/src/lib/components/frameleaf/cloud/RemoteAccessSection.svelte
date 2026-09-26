<script lang="ts">
  /**
   * Settings → Frameleaf Cloud → Remote access (FL-161): the prototype's "Who can connect" card
   * (design/frameleaf/template/src/FrameleafCloud.jsx:1540-1567, with its confirmation at 1599-1624) on
   * real state from `admin/cloud/status`. A Frameleaf sign-in for remote visitors is a fixed policy;
   * original downloads through the relay and password sign-in away from home stay off until an
   * administrator confirms turning one on, and need a linked server. The rest of the prototype's
   * Remote access page (the switch, connection, relay, direct and address cards) arrives with the edge
   * worker stories.
   */
  import './cloud-account.css';
  import { goto } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import CloudCard from '$lib/components/frameleaf/cloud/CloudCard.svelte';
  import CloudToggleRow from '$lib/components/frameleaf/cloud/CloudToggleRow.svelte';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { cloudManager } from '$lib/managers/cloud-manager.svelte';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  type Setting = 'allowOriginalsOverRelay' | 'allowPasswordOverRelay';

  onMount(() => cloudManager.listen());

  const status = $derived(cloudManager.status);
  const linked = $derived(status?.state === 'linked');
  let busy = $state(false);
  let failure = $state('');
  let notice = $state('');
  let confirming = $state<Setting | null>(null);
  let confirmOpen = $state(false);

  const confirmTitle = $derived(
    confirming === 'allowOriginalsOverRelay'
      ? $t('frameleaf_remote_originals_confirm_title')
      : $t('frameleaf_remote_password_confirm_title'),
  );
  const confirmBody = $derived(
    confirming === 'allowOriginalsOverRelay'
      ? $t('frameleaf_remote_originals_confirm_body')
      : $t('frameleaf_remote_password_confirm_body'),
  );

  const save = async (setting: Setting, value: boolean) => {
    busy = true;
    failure = '';
    notice = '';
    try {
      await cloudManager.setRemoteAccess({ [setting]: value });
      if (setting === 'allowOriginalsOverRelay') {
        notice = value ? $t('frameleaf_remote_originals_on_notice') : $t('frameleaf_remote_originals_off_notice');
      } else {
        notice = value ? $t('frameleaf_remote_password_on_notice') : $t('frameleaf_remote_password_off_notice');
      }
      return true;
    } catch (error) {
      failure = getServerErrorMessage(error) ?? $t('frameleaf_cloud_action_failed');
      return false;
    } finally {
      busy = false;
    }
  };

  /** Turning a setting on asks first, as in the prototype; turning it off is immediate. */
  const change = (setting: Setting, value: boolean) => {
    if (!value) {
      void save(setting, false);
      return;
    }
    confirming = setting;
    confirmOpen = true;
  };

  const confirm = async () => {
    if (confirming && (await save(confirming, true))) {
      confirmOpen = false;
      confirming = null;
    }
  };

  const keepOff = () => {
    confirmOpen = false;
    confirming = null;
  };
</script>

<div class="frameleaf-cloud" data-section="cloud-remote">
  <CloudCard title={$t('frameleaf_remote_who_title')} description={$t('frameleaf_remote_who_description')}>
    <CloudToggleRow
      label={$t('frameleaf_remote_require_signin')}
      help={$t('frameleaf_remote_require_signin_help')}
      checked
      policy={$t('frameleaf_signin_always_on')}
    />
    <CloudToggleRow
      label={$t('frameleaf_remote_allow_originals')}
      help={$t('frameleaf_remote_allow_originals_help')}
      checked={!!status?.allowOriginalsOverRelay}
      disabled={!linked || busy}
      reason={$t('frameleaf_signin_link_first')}
      onChange={(value) => change('allowOriginalsOverRelay', value)}
    />
    <CloudToggleRow
      label={$t('frameleaf_remote_allow_password')}
      help={$t('frameleaf_remote_allow_password_help')}
      checked={!!status?.allowPasswordOverRelay}
      disabled={!linked || busy}
      reason={$t('frameleaf_signin_link_first')}
      onChange={(value) => change('allowPasswordOverRelay', value)}
    />
    {#if failure}
      <p class="fc-notice is-error" role="alert">{failure}</p>
    {:else if notice}
      <p class="fc-notice" role="status">{notice}</p>
    {/if}
    {#if !linked}
      <div class="fc-actions">
        <Button variant="primary" onclick={() => goto(commandCenterUrl('cloud', 'cloud-account'))}
          >{$t('frameleaf_cloud_link_action')}</Button
        >
      </div>
    {/if}
  </CloudCard>
</div>

<Dialog bind:open={confirmOpen} title={confirmTitle} closeLabel={$t('close')} onRequestClose={keepOff}>
  <p>{confirmBody}</p>
  {#snippet actions()}
    <Button onclick={keepOff}>{$t('frameleaf_remote_keep_off')}</Button>
    <Button variant="primary" disabled={busy} onclick={() => void confirm()}>{$t('frameleaf_remote_turn_on')}</Button>
  {/snippet}
</Dialog>
