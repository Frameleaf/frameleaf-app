<script lang="ts">
  /**
   * FL-708 (UI review item 20): "Add a Frameleaf account", the optional step after the local
   * administrator exists. Create an account (name and email from the administrator, plus a password),
   * or sign in to one the administrator already has (email and password), then link this server.
   *
   * Frameleaf Cloud has no API yet that creates or signs in to an account with an email and password
   * from a server: sign-up and sign-in happen on frameleaf.cloud. So the form is checked here and
   * the link then runs through the approval flow (`SetupFrameleafLink`, the device code): the code page
   * on frameleaf.cloud creates the account or signs in, and approves this server. The password typed
   * here is never sent or saved; it is cleared as the approval starts.
   */
  import AuthPasswordField from '$lib/components/frameleaf/AuthPasswordField.svelte';
  import SetupFrameleafLink from '$lib/components/frameleaf/setup/SetupFrameleafLink.svelte';
  import FormatMessage from '$lib/elements/FormatMessage.svelte';
  import {
    FRAMELEAF_TERMS_URL,
    validateFrameleafAccount,
    type FrameleafAccountForm,
    type FrameleafAccountMode,
  } from '$lib/frameleaf/first-run-setup';
  import { ICON_SIZE } from '$lib/frameleaf/tokens';
  import { cloudManager } from '$lib/managers/cloud-manager.svelte';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import { CloudLinkRefusal } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiAlertCircleOutline, mdiLoading } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  type Props = { name: string; email: string; linked: boolean; onLinked: () => void };
  const { name, email, linked, onLinked }: Props = $props();

  // svelte-ignore state_referenced_locally
  let form = $state<FrameleafAccountForm>({ mode: 'create', name, email, password: '' });
  let errors = $state<Record<string, string>>({});
  let busy = $state(false);
  let formError = $state('');

  onMount(() => cloudManager.listen());

  const status = $derived(cloudManager.status);
  /** The approval flow has the screen: a code to approve, the linked result, or a region choice. */
  const approving = $derived(
    linked ||
      status?.state === 'linked' ||
      (status?.state === 'pending' && !!status.pending) ||
      (status?.state === 'unlinked' && status.linkRefusal === CloudLinkRefusal.RegionMismatch),
  );
  const unreachable = $derived((!status && !!cloudManager.error) || status?.state === 'not-configured');
  /** Why the last approval did not link, shown above the form when it comes back. */
  const linkResult = $derived(
    status?.state === 'unlinked' && (status.linkResult === 'denied' || status.linkResult === 'expired')
      ? status.linkResult
      : null,
  );

  const switchMode = (mode: FrameleafAccountMode) => {
    errors = {};
    formError = '';
    form = { ...form, mode, password: '' };
  };

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (busy) {
      return;
    }
    const check = validateFrameleafAccount(form);
    errors = Object.fromEntries(Object.entries(check.errors).map(([key, value]) => [key, $t(value as never)]));
    if (!check.ok) {
      return;
    }
    busy = true;
    formError = '';
    // Nothing on this server can use the password: frameleaf.cloud asks for it on the code page.
    form.password = '';
    try {
      await cloudManager.startLink();
    } catch (error) {
      formError = getServerErrorMessage(error) || $t('frameleaf_setup_cloud_unreachable_body');
    } finally {
      busy = false;
    }
  };
</script>

{#if approving || unreachable}
  <SetupFrameleafLink mode="link" {linked} {onLinked} />
  {#if linked || status?.state === 'linked'}
    <p class="auth-note">{$t('frameleaf_setup_frameleaf_account_either')}</p>
  {/if}
{:else}
  <form class="frs-form frs-cloud-form" novalidate onsubmit={(event) => void submit(event)}>
    {#if linkResult}
      <p class="auth-error" role="alert">
        <Icon icon={mdiAlertCircleOutline} size="16" aria-hidden={true} />
        <span>
          {linkResult === 'denied' ? $t('frameleaf_cloud_link_denied_title') : $t('frameleaf_cloud_link_expired_title')}
        </span>
      </p>
    {/if}
    {#if formError}
      <p class="auth-error" role="alert">
        <Icon icon={mdiAlertCircleOutline} size="16" aria-hidden={true} /><span>{formError}</span>
      </p>
    {/if}
    {#if form.mode === 'create'}
      <div class="auth-field">
        <label for="frs-fl-name">{$t('frameleaf_auth_name')}</label>
        <input
          id="frs-fl-name"
          autocomplete="name"
          bind:value={form.name}
          aria-invalid={errors.name ? true : undefined}
          aria-describedby={errors.name ? 'frs-fl-name-error' : undefined}
        />
      </div>
      {#if errors.name}<p id="frs-fl-name-error" class="auth-error frs-field-error">{errors.name}</p>{/if}
    {/if}
    <div class="auth-field">
      <label for="frs-fl-email">{$t('frameleaf_auth_email')}</label>
      <input
        id="frs-fl-email"
        type="email"
        autocomplete="email"
        bind:value={form.email}
        aria-invalid={errors.email ? true : undefined}
        aria-describedby={errors.email ? 'frs-fl-email-error' : undefined}
      />
    </div>
    {#if errors.email}<p id="frs-fl-email-error" class="auth-error frs-field-error">{errors.email}</p>{/if}
    <AuthPasswordField
      id="frs-fl-password"
      label={form.mode === 'create' ? $t('frameleaf_setup_frameleaf_password') : $t('frameleaf_auth_password')}
      autocomplete={form.mode === 'create' ? 'new-password' : 'current-password'}
      bind:value={form.password}
      invalid={!!errors.password}
      describedBy={errors.password ? 'frs-fl-password-error' : undefined}
    />
    {#if errors.password}<p id="frs-fl-password-error" class="auth-error frs-field-error">{errors.password}</p>{/if}
    {#if form.mode === 'create'}
      <p class="auth-note">
        <FormatMessage key="frameleaf_setup_frameleaf_terms">
          {#snippet children({ message })}<a
              class="auth-link"
              href={FRAMELEAF_TERMS_URL}
              target="_blank"
              rel="noreferrer">{message}</a
            >{/snippet}
        </FormatMessage>
      </p>
    {/if}
    <div class="frs-cloud-actions">
      <button type="submit" class="button primary" disabled={busy} aria-busy={busy || undefined}>
        {#if busy}
          <Icon icon={mdiLoading} size={ICON_SIZE.md} class="frs-spin" aria-hidden={true} />
          <span role="status">{$t('frameleaf_setup_frameleaf_linking')}</span>
        {:else}
          {form.mode === 'create' ? $t('frameleaf_setup_frameleaf_create') : $t('frameleaf_setup_frameleaf_sign_in')}
        {/if}
      </button>
      <button
        type="button"
        class="auth-link"
        disabled={busy}
        onclick={() => switchMode(form.mode === 'create' ? 'sign-in' : 'create')}
      >
        {form.mode === 'create'
          ? $t('frameleaf_setup_frameleaf_have_account')
          : $t('frameleaf_setup_frameleaf_new_instead')}
      </button>
    </div>
  </form>
{/if}
