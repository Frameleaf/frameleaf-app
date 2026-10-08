<script lang="ts">
  /**
   * FL-176 "Sign in with Frameleaf" during setup. `link` runs the FL-155 device flow through the
   * cloud manager (the administrator is signed in); `sign-in` hands over to the FL-158 Sign in with
   * Frameleaf redirect. Frameleaf Cloud may not be reachable (or not set up at all): then setup says
   * so plainly and offers the local account instead.
   */
  import symbolUrl from '$lib/assets/frameleaf/frameleaf-symbol.svg?url';
  import CloudPendingCode from '$lib/components/frameleaf/cloud/CloudPendingCode.svelte';
  import { dataRegionKey, displayHost } from '$lib/frameleaf/cloud';
  import { ICON_SIZE } from '$lib/frameleaf/tokens';
  import { startFrameleaf } from '$lib/frameleaf/frameleaf-sign-in';
  import { cloudManager } from '$lib/managers/cloud-manager.svelte';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import { CloudLinkRefusal, getPublicConfig } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiAlertCircleOutline, mdiCheck, mdiCloudOffOutline, mdiRefresh } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    mode: 'link' | 'sign-in';
    linked: boolean;
    onLinked: () => void;
    /** Offered when Frameleaf Cloud can't be reached: continue with a local account. */
    onFallback?: () => void;
    compact?: boolean;
  };
  const { mode, linked, onLinked, onFallback, compact = false }: Props = $props();

  let signInAvailable = $state<boolean | null>(null);
  let busy = $state(false);
  let error = $state('');
  /** Reported by the code block when its countdown reaches zero. */
  let codeExpired = $state(false);

  onMount(() => {
    if (mode === 'link') {
      return cloudManager.listen();
    }
    getPublicConfig()
      .then((config) => (signInAvailable = config.frameleaf.signInAvailable))
      .catch(() => (signInAvailable = false));
  });

  const status = $derived(mode === 'link' ? cloudManager.status : null);
  $effect(() => {
    if (status?.state === 'linked' && !linked) {
      onLinked();
    }
  });

  const unreachable = $derived(
    mode === 'link'
      ? (!status && !!cloudManager.error) || status?.state === 'not-configured'
      : signInAvailable === false,
  );

  const run = async (call: () => Promise<unknown>) => {
    busy = true;
    error = '';
    try {
      await call();
    } catch (error_) {
      error = getServerErrorMessage(error_) || $t('frameleaf_setup_cloud_unreachable_body');
      if (mode === 'sign-in') {
        signInAvailable = false;
      }
    } finally {
      busy = false;
    }
  };

  /** FC-18: Frameleaf Cloud refused the approved link because the account keeps its data in another region. */
  const regionMismatch = $derived(
    status?.state === 'unlinked' && status.linkRefusal === CloudLinkRefusal.RegionMismatch ? status : null,
  );
  const accountRegion = $derived.by(() => {
    const key = regionMismatch?.regionMismatch ? dataRegionKey(regionMismatch.regionMismatch.accountRegion) : null;
    return key ? $t(key) : null;
  });

  /** Why the last code did not link: declined on the approval page, or nobody approved it in time. */
  const linkResult = $derived(
    status?.state === 'unlinked' && (status.linkResult === 'denied' || status.linkResult === 'expired')
      ? status.linkResult
      : null,
  );

  const start = () => run(() => (mode === 'link' ? cloudManager.startLink() : startFrameleaf('sign-in', location)));
</script>

{#if linked || status?.state === 'linked'}
  <div class="frs-linked" role="status">
    <span class="frs-linked-badge fl-brand-frame fl-unfurl"><Icon icon={mdiCheck} size="22" aria-hidden={true} /></span>
    <div>
      <strong>
        {status?.account?.label
          ? $t('frameleaf_setup_linked_as', { values: { account: status.account.label } })
          : $t('frameleaf_cloud_linked_title')}
      </strong>
      <span>{$t('frameleaf_setup_linked_body')}</span>
    </div>
  </div>
{:else if unreachable}
  <div class="frs-unreachable" role="status">
    <Icon icon={mdiCloudOffOutline} size="22" aria-hidden={true} />
    <div>
      <strong>{$t('frameleaf_setup_cloud_unreachable_title')}</strong>
      <span>{$t('frameleaf_setup_cloud_unreachable_body')}</span>
    </div>
    {#if onFallback}
      <button type="button" class="button" onclick={onFallback}>{$t('frameleaf_setup_use_local')}</button>
    {:else if mode === 'link'}
      <button type="button" class="auth-link" onclick={() => void cloudManager.refresh()}>
        {$t('frameleaf_personal_try_again')}
      </button>
    {/if}
  </div>
{:else if status?.state === 'pending' && status.pending}
  <section
    class="frs-device"
    aria-label={$t('frameleaf_setup_approve', { values: { host: displayHost(status.pending.verificationUri) } })}
  >
    <CloudPendingCode
      compact
      pending={status.pending}
      lastError={status.lastError}
      pollError={!!cloudManager.pollError}
      bind:expired={codeExpired}
    />
    <div class="frs-device-actions">
      {#if codeExpired}
        <span class="frs-device-status" role="status">{$t('frameleaf_cloud_code_expired')}</span>
      {:else}
        <span class="frs-device-status frs-waiting" role="status">{$t('frameleaf_cloud_waiting')}</span>
      {/if}
      <button
        type="button"
        class="button"
        class:primary={codeExpired}
        disabled={busy}
        onclick={() => void run(() => cloudManager.startLink())}
      >
        <Icon icon={mdiRefresh} size={ICON_SIZE.md} aria-hidden={true} />{$t('frameleaf_cloud_new_code')}
      </button>
      <button type="button" class="auth-link" disabled={busy} onclick={() => void run(() => cloudManager.cancelLink())}>
        {$t('cancel')}
      </button>
    </div>
  </section>
{:else if regionMismatch?.regionMismatch?.canContinue}
  <div class="frs-region-mismatch" role="alert">
    <strong>{$t('frameleaf_cloud_link_refusal_region_mismatch_title')}</strong>
    <span>{regionMismatch.lastError || $t('frameleaf_cloud_link_refusal_region_mismatch_body')}</span>
    <div>
      <button type="button" class="button" disabled={busy} onclick={() => void run(() => cloudManager.continueLink())}>
        {accountRegion
          ? $t('frameleaf_cloud_link_continue_region', { values: { region: accountRegion } })
          : $t('frameleaf_cloud_link_continue_account_region')}
      </button>
      <button type="button" class="auth-link" disabled={busy} onclick={() => void run(() => cloudManager.cancelLink())}>
        {$t('cancel')}
      </button>
    </div>
  </div>
{:else}
  {#if regionMismatch}
    <p class="auth-error" role="alert">
      {regionMismatch.lastError || $t('frameleaf_cloud_link_refusal_region_mismatch_body')}
    </p>
  {:else if linkResult}
    <div class="frs-link-result" role="alert">
      <Icon icon={mdiAlertCircleOutline} size={ICON_SIZE.lg} aria-hidden={true} />
      <div>
        <strong>
          {linkResult === 'denied' ? $t('frameleaf_cloud_link_denied_title') : $t('frameleaf_cloud_link_expired_title')}
        </strong>
        <span>
          {linkResult === 'denied' ? $t('frameleaf_cloud_link_denied_body') : $t('frameleaf_cloud_link_expired_body')}
        </span>
      </div>
    </div>
  {/if}
  <button
    type="button"
    class="button auth-frameleaf frs-frameleaf-button"
    class:compact
    disabled={busy || (mode === 'link' ? !status : signInAvailable === null)}
    onclick={start}
  >
    <img src={symbolUrl} alt="" width="18" height="18" />
    {$t('frameleaf_setup_sign_in_frameleaf')}
  </button>
{/if}
{#if error && !unreachable}
  <p class="auth-error" role="alert">{error}</p>
{/if}
