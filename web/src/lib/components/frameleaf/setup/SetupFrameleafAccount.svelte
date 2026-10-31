<script lang="ts">
  /**
   * FL-708 (UI review item 20): "Add a Frameleaf account", the optional step after the local
   * administrator exists. Create an account (name and email from the administrator, plus a password),
   * or sign in to one the administrator already has (email and password). This server sends them to
   * Frameleaf Cloud (FC-222, `cloudManager.linkWithAccount`) and is linked straight away, with no
   * approval code: that is for first-run setup only. A new account (and one with an authenticator app)
   * first asks for a code. The password is sent once and never kept, here or on the server.
   */
  import AuthPasswordField from '$lib/components/frameleaf/AuthPasswordField.svelte';
  import SetupFrameleafLink from '$lib/components/frameleaf/setup/SetupFrameleafLink.svelte';
  import FormatMessage from '$lib/elements/FormatMessage.svelte';
  import {
    accountLinkRefusalMessage,
    FRAMELEAF_TERMS_URL,
    validateFrameleafAccount,
    type FrameleafAccountForm,
    type FrameleafAccountMode,
  } from '$lib/frameleaf/first-run-setup';
  import { dataRegionKey } from '$lib/frameleaf/cloud';
  import { ICON_SIZE } from '$lib/frameleaf/tokens';
  import { cloudManager } from '$lib/managers/cloud-manager.svelte';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import {
    CloudAccountLinkCreateMode,
    CloudAccountLinkRefusal,
    CloudAccountLinkSignInMode,
    CloudLinkRefusal,
    DataRegion,
    getCloudAccountLinkConsents,
    type CloudAccountConsentsResponseDto,
    type CloudAccountLinkResponseDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiAlertCircleOutline, mdiLoading } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  type Props = { name: string; email: string; linked: boolean; onLinked: () => void };
  const { name, email, linked, onLinked }: Props = $props();

  type Challenge = NonNullable<CloudAccountLinkResponseDto['challenge']>;

  /** Refusals while a code is open that leave it usable (FC-222): a wrong code, too many tries, a pause. */
  const KEEPS_CODE_STEP = new Set<CloudAccountLinkRefusal>([
    CloudAccountLinkRefusal.CodeInvalid,
    CloudAccountLinkRefusal.RateLimited,
    CloudAccountLinkRefusal.Paused,
    CloudAccountLinkRefusal.Unavailable,
  ]);

  // svelte-ignore state_referenced_locally
  let form = $state<FrameleafAccountForm>({ mode: 'create', name, email, password: '' });
  let errors = $state<Record<string, string>>({});
  let busy = $state(false);
  let formError = $state('');
  let consents = $state<CloudAccountConsentsResponseDto | null>(null);
  let consentsFailed = $state(false);
  /** A new account's emailed code, or an authenticator app's, before the link is made. */
  let challenge = $state<Challenge | null>(null);
  let code = $state('');
  let codeError = $state('');
  /**
   * FC-18: the account keeps its data in another region. Linking there changes where this server's
   * cloud data lives, so it is the administrator's choice (`offeredRegion`), never automatic.
   */
  let offeredRegion = $state<DataRegion | null>(null);
  let chosenRegion = $state<DataRegion | null>(null);
  const regionName = (region: string | null) => {
    const key = region ? dataRegionKey(region) : null;
    return key ? $t(key) : null;
  };

  const loadConsents = async () => {
    consentsFailed = false;
    try {
      consents = await getCloudAccountLinkConsents();
    } catch {
      consentsFailed = true;
    }
  };

  onMount(() => {
    const stop = cloudManager.listen();
    void loadConsents();
    return stop;
  });

  const status = $derived(cloudManager.status);
  /** The link has the screen: linked, a code from an earlier approval flow, or a region choice. */
  const approving = $derived(
    linked ||
      status?.state === 'linked' ||
      (status?.state === 'pending' && !!status.pending) ||
      (status?.state === 'unlinked' && status.linkRefusal === CloudLinkRefusal.RegionMismatch),
  );
  const unreachable = $derived((!status && !!cloudManager.error) || status?.state === 'not-configured');

  const switchMode = (mode: FrameleafAccountMode) => {
    errors = {};
    formError = '';
    form = { ...form, mode, password: '' };
    offeredRegion = null;
    chosenRegion = null;
    if (mode === 'create' && !consents) {
      void loadConsents();
    }
  };

  /** The code's own lifetime, from the cloud's `expiresIn` (FC-222), never a fixed number. */
  const minutesLeft = (expiresAt: string) => Math.max(1, Math.round((Date.parse(expiresAt) - Date.now()) / 60_000));

  const restart = () => {
    challenge = null;
    code = '';
    codeError = '';
  };

  /** What came back: linked (the linked view takes over), a code to enter, or a refusal in plain words. */
  const answered = (answer: CloudAccountLinkResponseDto) => {
    if (answer.outcome === 'code-needed' && answer.challenge) {
      challenge = answer.challenge;
      code = '';
      codeError = '';
      return;
    }
    if (answer.outcome !== 'refused' || !answer.refusal) {
      restart();
      return;
    }
    const message = $t(accountLinkRefusalMessage(answer.refusal, answer.retryAfterSeconds, answer.attemptsLeft), {
      values: {
        minutes: Math.max(1, Math.ceil((answer.retryAfterSeconds ?? 0) / 60)),
        count: answer.attemptsLeft ?? 0,
      },
    });
    if (challenge && KEEPS_CODE_STEP.has(answer.refusal)) {
      // a wrong code, or a wait: the same code can still be tried
      codeError = message;
      return;
    }
    // an expired code or a final refusal ends the code step: the form comes back with the reason
    restart();
    formError = message;
    const region = answer.accountRegion;
    if (
      answer.refusal === 'region-mismatch' &&
      (region === DataRegion.Eu || region === DataRegion.Na) &&
      regionName(region)
    ) {
      offeredRegion = region;
      formError = $t('frameleaf_setup_frameleaf_error_region_mismatch_in', { values: { region: regionName(region) } });
    }
    if (answer.refusal === 'consent-outdated') {
      void loadConsents();
    }
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
    if (form.mode === 'create' && !consents) {
      formError = $t('frameleaf_setup_frameleaf_consents_unavailable');
      void loadConsents();
      return;
    }
    busy = true;
    formError = '';
    offeredRegion = null;
    const password = form.password;
    // the password goes to Frameleaf Cloud once; nothing on this page keeps it
    form.password = '';
    try {
      answered(
        await cloudManager.linkWithAccount(
          form.mode === 'create' && consents
            ? {
                mode: CloudAccountLinkCreateMode.Create,
                email: form.email.trim(),
                password,
                name: form.name.trim(),
                consent: { tos: consents.tos.version, privacy: consents.privacy.version },
              }
            : {
                mode: CloudAccountLinkSignInMode.SignIn,
                email: form.email.trim(),
                password,
                ...(chosenRegion && { dataRegion: chosenRegion }),
              },
        ),
      );
    } catch (error) {
      formError = getServerErrorMessage(error) || $t('frameleaf_setup_cloud_unreachable_body');
    } finally {
      busy = false;
    }
  };

  const verify = async (event: SubmitEvent) => {
    event.preventDefault();
    if (busy || !challenge) {
      return;
    }
    if (!code.trim()) {
      codeError = $t('frameleaf_setup_frameleaf_code_required');
      return;
    }
    busy = true;
    codeError = '';
    try {
      answered(await cloudManager.verifyAccountLink(challenge.challengeId, code.trim()));
    } catch (error) {
      codeError = getServerErrorMessage(error) || $t('frameleaf_setup_cloud_unreachable_body');
    } finally {
      busy = false;
    }
  };
</script>

{#snippet spinner(label: string)}
  <Icon icon={mdiLoading} size={ICON_SIZE.md} class="frs-spin" aria-hidden={true} />
  <span role="status">{label}</span>
{/snippet}

{#if approving || unreachable}
  <SetupFrameleafLink mode="link" {linked} {onLinked} />
  {#if linked || status?.state === 'linked'}
    <p class="auth-note">{$t('frameleaf_setup_frameleaf_account_either')}</p>
  {/if}
{:else if challenge}
  <form class="frs-form frs-cloud-form" novalidate onsubmit={(event) => void verify(event)}>
    <h2 class="frs-cloud-code-title">
      {challenge.kind === 'email-code'
        ? $t('frameleaf_setup_frameleaf_code_email_title')
        : $t('frameleaf_setup_frameleaf_code_2fa_title')}
    </h2>
    <p class="auth-note">
      {challenge.kind === 'email-code'
        ? $t('frameleaf_setup_frameleaf_code_email_body', {
            values: { email: form.email.trim(), minutes: minutesLeft(challenge.expiresAt) },
          })
        : $t('frameleaf_setup_frameleaf_code_2fa_body')}
    </p>
    <div class="auth-field">
      <label for="frs-fl-code">{$t('frameleaf_setup_frameleaf_code_label')}</label>
      <!-- svelte-ignore a11y_autofocus -->
      <input
        id="frs-fl-code"
        autocomplete="one-time-code"
        inputmode={challenge.kind === 'email-code' ? 'numeric' : 'text'}
        spellcheck="false"
        autofocus
        bind:value={code}
        aria-invalid={codeError ? true : undefined}
        aria-describedby={codeError ? 'frs-fl-code-error' : undefined}
      />
    </div>
    {#if codeError}
      <p id="frs-fl-code-error" class="auth-error frs-field-error" role="alert">
        <Icon icon={mdiAlertCircleOutline} size="16" aria-hidden={true} /><span>{codeError}</span>
      </p>
    {/if}
    <div class="frs-cloud-actions">
      <button type="submit" class="button primary" disabled={busy} aria-busy={busy || undefined}>
        {#if busy}
          {@render spinner($t('frameleaf_setup_frameleaf_linking'))}
        {:else}
          {$t('frameleaf_setup_frameleaf_code_submit')}
        {/if}
      </button>
      <button type="button" class="auth-link" disabled={busy} onclick={restart}>
        {$t('frameleaf_setup_frameleaf_code_restart')}
      </button>
    </div>
  </form>
{:else}
  <form class="frs-form frs-cloud-form" novalidate onsubmit={(event) => void submit(event)}>
    {#if formError}
      <p class="auth-error" role="alert">
        <Icon icon={mdiAlertCircleOutline} size="16" aria-hidden={true} /><span>{formError}</span>
      </p>
    {/if}
    {#if offeredRegion}
      <button
        type="button"
        class="button frs-cloud-region"
        onclick={() => {
          chosenRegion = offeredRegion;
          offeredRegion = null;
          formError = '';
          document.querySelector<HTMLInputElement>('#frs-fl-password')?.focus();
        }}
      >
        {$t('frameleaf_setup_frameleaf_region_use', { values: { region: regionName(offeredRegion) } })}
      </button>
    {:else if chosenRegion}
      <p class="auth-note" role="status">
        {$t('frameleaf_setup_frameleaf_region_chosen', { values: { region: regionName(chosenRegion) } })}
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
      {#if consents}
        <!-- FC-222: Frameleaf Cloud records that these statements were shown when the account is made. -->
        <p class="auth-note frs-cloud-consent">{consents.tos.text}</p>
        <p class="auth-note frs-cloud-consent">{consents.privacy.text}</p>
      {:else if consentsFailed}
        <p class="auth-note frs-cloud-consent">{$t('frameleaf_setup_frameleaf_consents_unavailable')}</p>
      {/if}
    {/if}
    <div class="frs-cloud-actions">
      <button type="submit" class="button primary" disabled={busy} aria-busy={busy || undefined}>
        {#if busy}
          {@render spinner($t('frameleaf_setup_frameleaf_linking'))}
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
