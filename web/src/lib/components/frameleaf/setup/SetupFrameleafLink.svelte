<script lang="ts">
  /**
   * FL-176 "Sign in with Frameleaf" during setup. `link` runs the FL-155 device flow through the
   * cloud manager (the administrator is signed in); `sign-in` hands over to the FL-158 Sign in with
   * Frameleaf redirect. Frameleaf Cloud may not be reachable (or not set up at all): then setup says
   * so plainly and offers the local account instead.
   */
  import symbolUrl from '$lib/assets/frameleaf/frameleaf-symbol.svg?url';
  import { displayHost } from '$lib/frameleaf/cloud';
  import { startFrameleaf } from '$lib/frameleaf/frameleaf-sign-in';
  import { cloudManager } from '$lib/managers/cloud-manager.svelte';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import { getPublicConfig } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiCheckDecagram, mdiCloudOffOutline } from '@mdi/js';
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

  const start = () =>
    run(() => (mode === 'link' ? cloudManager.startLink() : startFrameleaf('sign-in', globalThis.location)));
</script>

{#if linked || status?.state === 'linked'}
  <div class="frs-linked" role="status">
    <span class="frs-linked-badge"><Icon icon={mdiCheckDecagram} size="22" aria-hidden={true} /></span>
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
  <div class="frs-device" role="status">
    <span
      class="frs-device-code"
      aria-label={$t('frameleaf_setup_code', { values: { code: status.pending.userCode } })}
    >
      {status.pending.userCode}
    </span>
    <div>
      <strong>{$t('frameleaf_setup_approve', { values: { host: displayHost(status.pending.verificationUri) } })}</strong
      >
      <span>
        <a href={status.pending.verificationUriComplete} target="_blank" rel="noopener noreferrer">
          {$t('frameleaf_setup_approve_open')}
        </a>
        <span class="frs-dots" aria-hidden="true"></span>
      </span>
    </div>
    <button type="button" class="auth-link" disabled={busy} onclick={() => void run(() => cloudManager.cancelLink())}>
      {$t('cancel')}
    </button>
  </div>
{:else}
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
