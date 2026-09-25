<script lang="ts">
  /**
   * Onboarding → Frameleaf account (FL-158; AuthScreens.jsx:1219-1296, effd05ffb7): an optional
   * server step that links this server to a Frameleaf account with the real device flow. It is
   * skippable ("Skip" in the step navigation until linked), never required for anything local, and
   * says so when Frameleaf Cloud is not set up on this server.
   */
  import Logo from '$lib/components/frameleaf/Logo.svelte';
  import { displayHost } from '$lib/frameleaf/cloud';
  import { cloudManager } from '$lib/managers/cloud-manager.svelte';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import { Icon } from '@immich/ui';
  import { mdiCheckDecagramOutline } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  onMount(() => cloudManager.listen());

  const status = $derived(cloudManager.status);
  let busy = $state(false);
  let error = $state('');

  const run = async (call: () => Promise<unknown>) => {
    busy = true;
    error = '';
    try {
      await call();
    } catch (error_) {
      error = getServerErrorMessage(error_) ?? $t('frameleaf_cloud_action_failed');
    } finally {
      busy = false;
    }
  };
</script>

<div class="ob-cloud">
  <p>{$t('frameleaf_onboarding_account_intro')}</p>
  <ul class="ob-list">
    <li><strong>{$t('frameleaf_cloud_benefit_remote_title')}</strong> — {$t('frameleaf_onboarding_account_remote')}</li>
    <li><strong>{$t('frameleaf_cloud_benefit_backup_title')}</strong> — {$t('frameleaf_onboarding_account_backup')}</li>
    <li>
      <strong>{$t('frameleaf_onboarding_account_processing_title')}</strong> — {$t(
        'frameleaf_onboarding_account_processing',
      )}
    </li>
  </ul>

  {#if !status}
    <p class="auth-note" role="status">{$t('frameleaf_cloud_loading')}</p>
  {:else if status.state === 'not-configured'}
    <p class="auth-note">{$t('frameleaf_onboarding_account_not_configured')}</p>
  {:else if status.state === 'linked'}
    <div class="auth-card ob-cloud-card">
      <span class="ob-cloud-badge"><Icon icon={mdiCheckDecagramOutline} size="24" /></span>
      <div>
        <strong>
          {status.account?.label
            ? $t('frameleaf_onboarding_account_linked_to', { values: { account: status.account.label } })
            : $t('frameleaf_cloud_linked_title')}
        </strong>
        <span>{$t('frameleaf_onboarding_account_linked_body')}</span>
      </div>
      <button type="button" class="auth-link" disabled={busy} onclick={() => void run(() => cloudManager.unlink())}>
        {$t('frameleaf_onboarding_account_unlink')}
      </button>
    </div>
  {:else if status.state === 'pending' && status.pending}
    <div class="auth-card ob-cloud-card" role="status">
      <span
        class="ob-code"
        aria-label={$t('frameleaf_onboarding_account_code', { values: { code: status.pending.userCode } })}
      >
        {status.pending.userCode}
      </span>
      <div>
        <strong>
          {$t('frameleaf_cloud_pending_title', { values: { host: displayHost(status.pending.verificationUri) } })}
        </strong>
        <span>
          <a href={status.pending.verificationUriComplete} target="_blank" rel="noopener noreferrer">
            {displayHost(status.pending.verificationUri)}
          </a>
          · {$t('frameleaf_onboarding_account_waiting')}
        </span>
      </div>
      <button type="button" class="auth-link" disabled={busy} onclick={() => void run(() => cloudManager.cancelLink())}>
        {$t('frameleaf_cloud_cancel')}
      </button>
    </div>
  {:else}
    <div class="ob-cloud-actions">
      <button
        type="button"
        class="button auth-frameleaf"
        disabled={busy}
        onclick={() => void run(() => cloudManager.startLink())}
      >
        <Logo variant="icon" size="tiny" decorative />
        {$t('frameleaf_onboarding_account_link')}
      </button>
      <span class="auth-note">{$t('frameleaf_onboarding_account_optional')}</span>
    </div>
  {/if}
  {#if error}
    <p class="auth-error" role="alert">{error}</p>
  {/if}
</div>
