<script lang="ts">
  /**
   * Settings → Access & security → Sign in with Frameleaf (FL-158): the prototype's `FrameleafSignIn`
   * card (design/frameleaf/template/src/FrameleafCloud.jsx:2835-2885, effd05ffb7) on real state from
   * `admin/cloud/status`. Remote access always requires a Frameleaf sign-in; the administrator only
   * chooses whether the button is also offered at home, once the server is linked. The client proves
   * itself with this server's key only, so there is no client secret to manage (FL-177).
   */
  import './cloud-account.css';
  import { goto } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import CloudCard from '$lib/components/frameleaf/cloud/CloudCard.svelte';
  import CloudToggleRow from '$lib/components/frameleaf/cloud/CloudToggleRow.svelte';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { cloudManager } from '$lib/managers/cloud-manager.svelte';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import { mdiShieldAccountOutline } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  onMount(() => cloudManager.listen());

  const status = $derived(cloudManager.status);
  const linked = $derived(status?.state === 'linked');
  let busy = $state(false);
  let failure = $state('');

  const provider = $derived(
    status?.signInIssuer ? `Frameleaf · ${new URL(status.signInIssuer).host}` : $t('frameleaf_signin_provider_unknown'),
  );

  const save = async (call: () => Promise<unknown>) => {
    busy = true;
    failure = '';
    try {
      await call();
    } catch (error) {
      failure = getServerErrorMessage(error) ?? $t('frameleaf_cloud_action_failed');
    } finally {
      busy = false;
    }
  };

  const setShowOnLocalLogin = (value: boolean) => save(() => cloudManager.setShowOnLocalLogin(value));

  // The button's text, edited here and saved on its own (the login page shows it).
  // Follows the saved text until edited; a save or a refresh brings it back in step.
  let buttonText = $derived(status?.signInButtonText ?? '');
  const buttonTextChanged = $derived(
    !!status && buttonText.trim().length > 0 && buttonText.trim() !== status.signInButtonText,
  );
  const saveButtonText = () => save(() => cloudManager.setButtonText(buttonText.trim()));
  const buttonTextId = $props.id();
</script>

<div class="frameleaf-cloud" data-section="frameleaf-signin">
  <CloudCard
    icon={mdiShieldAccountOutline}
    title={$t('frameleaf_signin_title')}
    description={$t('frameleaf_signin_description')}
    status={linked ? $t('frameleaf_signin_available') : $t('frameleaf_signin_not_linked')}
    tone={linked ? 'ok' : 'muted'}
  >
    <dl class="fc-facts">
      <dt>{$t('frameleaf_signin_provider')}</dt>
      <dd>{linked ? provider : '—'}</dd>
      <dt>{$t('frameleaf_signin_client_id')}</dt>
      <dd>
        {#if status?.signInClientId ?? status?.instanceId}<code>{status?.signInClientId ?? status?.instanceId}</code>
        {:else}—{/if}
      </dd>
      <dt>{$t('frameleaf_signin_linked_accounts')}</dt>
      <dd>
        {linked
          ? $t('frameleaf_signin_linked_accounts_count', { values: { count: status?.signInLinkedAccounts ?? 0 } })
          : '—'}
      </dd>
    </dl>
    <CloudToggleRow
      label={$t('frameleaf_signin_require_remote')}
      help={$t('frameleaf_signin_require_remote_help')}
      checked
      policy={$t('frameleaf_signin_always_on')}
    />
    <CloudToggleRow
      label={$t('frameleaf_signin_show_at_home')}
      help={$t('frameleaf_signin_show_at_home_help')}
      checked={linked && !!status?.signInShowOnLocalLogin}
      disabled={!linked || busy}
      reason={$t('frameleaf_signin_link_first')}
      onChange={(value) => void setShowOnLocalLogin(value)}
    />
    <div class="fc-field">
      <div>
        <label class="fc-field-label" for={buttonTextId}>{$t('frameleaf_signin_button_text')}</label>
        <p>{$t('frameleaf_signin_button_text_help')}</p>
      </div>
      <div class="fc-inline">
        <input id={buttonTextId} class="fc-input" type="text" maxlength="100" bind:value={buttonText} disabled={busy} />
        <Button disabled={busy || !buttonTextChanged} onclick={() => void saveButtonText()}>{$t('save')}</Button>
      </div>
    </div>
    {#if failure}
      <p class="fc-notice is-error" role="alert">{failure}</p>
    {/if}
    <div class="fc-actions">
      {#if !linked}
        <Button variant="primary" onclick={() => goto(commandCenterUrl('cloud', 'cloud-account'))}
          >{$t('frameleaf_cloud_link_action')}</Button
        >
      {/if}
      <Button onclick={() => goto(commandCenterUrl('security', 'authentication'))}
        >{$t('frameleaf_signin_own_provider')}</Button
      >
      <Button onclick={() => goto(commandCenterUrl('preferences', 'frameleaf-account'))}
        >{$t('frameleaf_signin_link_own_account')}</Button
      >
    </div>
  </CloudCard>
</div>
