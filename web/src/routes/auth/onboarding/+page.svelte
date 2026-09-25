<script lang="ts">
  /**
   * First-run onboarding (FL-80 ON-1, O-1…O-6): the September 22 prototype's `Onboarding`
   * (`design/frameleaf/template/src/AuthScreens.jsx:818-1273`) in the Frameleaf auth shell — a
   * numbered step rail (done / reachable / not yet reached) with "Step n of N", the prototype step
   * order ending on a summary, Back / Next / "Open Frameleaf", "Finish later", Alt + arrow keys, and
   * resuming from the step this account stopped on.
   *
   * Each step still owns its setting and saves it when the step closes, exactly as before (theme,
   * language, map, casting, storage template); finishing marks the server (for its first
   * administrator) and the account onboarded, then opens the library. "Finish later" leaves without
   * marking anything, so the next sign-in comes back here.
   */
  import { SvelteSet } from 'svelte/reactivity';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import AuthShell from '$lib/components/frameleaf/AuthShell.svelte';
  import OnboardingBackup from './OnboardingBackup.svelte';
  import OnboardingDone from './OnboardingDone.svelte';
  import OnboardingFrameleafAccount from './OnboardingFrameleafAccount.svelte';
  import OnboardingHello from './OnboardingHello.svelte';
  import OnboardingLanguage from './OnboardingLanguage.svelte';
  import OnboardingLicense from './OnboardingLicense.svelte';
  import OnboardingMobileApp from './OnboardingMobileApp.svelte';
  import OnboardingServerPrivacy from './OnboardingServerPrivacy.svelte';
  import OnboardingStorageTemplate from './OnboardingStorageTemplate.svelte';
  import OnboardingTheme from './OnboardingTheme.svelte';
  import OnboardingUserPrivacy from './OnboardingUserPrivacy.svelte';
  import {
    clearOnboardingProgress,
    loadOnboardingProgress,
    onboardingStepIndex,
    onboardingStepsFor,
    saveOnboardingProgress,
    type OnboardingStepId,
  } from '$lib/frameleaf/onboarding';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { cloudManager } from '$lib/managers/cloud-manager.svelte';
  import { languageManager } from '$lib/managers/language-manager.svelte';
  import { serverConfigManager } from '$lib/managers/server-config-manager.svelte';
  import { systemConfigManager } from '$lib/managers/system-config-manager.svelte';
  import { Route } from '$lib/route';
  import { OnboardingRole } from '$lib/types';
  import { setUserOnboarding, updateAdminOnboarding } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiArrowLeft, mdiArrowRight, mdiCheck } from '@mdi/js';
  import { onMount, tick, type Component } from 'svelte';
  import { t } from 'svelte-i18n';

  const userRole = $derived(
    authManager.user.isAdmin && !serverConfigManager.value.isOnboarded ? OnboardingRole.SERVER : OnboardingRole.USER,
  );
  const steps = $derived(onboardingStepsFor(userRole));

  const components: Record<OnboardingStepId, Component> = {
    hello: OnboardingHello,
    language: OnboardingLanguage,
    theme: OnboardingTheme,
    server_privacy: OnboardingServerPrivacy,
    user_privacy: OnboardingUserPrivacy,
    storage_template: OnboardingStorageTemplate,
    frameleaf_account: OnboardingFrameleafAccount,
    license: OnboardingLicense,
    backup: OnboardingBackup,
    mobile_app: OnboardingMobileApp,
    done: OnboardingDone,
  };

  const saved = loadOnboardingProgress(authManager.user.id);
  // O-6: without an explicit `?step=`, resume from the step this account stopped on.
  const requested = $derived(page.url.searchParams.get('step') ?? saved?.step);
  const index = $derived(onboardingStepIndex(steps, requested));
  const last = $derived(steps.length - 1);
  const step = $derived(steps[index]);
  const StepBody = $derived(components[step.id]);

  let reached = $state(saved?.reached ?? 0);
  // Steps this account has already been shown (FL-80 O-8): a step's own defaults apply only on its
  // first visit, so a choice made there is shown as saved when the admin comes back to it.
  const visited = new SvelteSet<string>(saved ? steps.slice(0, (saved.reached ?? 0) + 1).map(({ id }) => id) : []);
  let shownStep: string | undefined;
  $effect(() => {
    if (shownStep && shownStep !== step.id) {
      visited.add(shownStep);
    }
    shownStep = step.id;
  });
  $effect(() => {
    if (index > reached) {
      reached = index;
    }
  });
  $effect(() => {
    saveOnboardingProgress(authManager.user.id, { step: step.id, reached });
  });

  let heading = $state<HTMLHeadingElement>();
  $effect(() => {
    void step.id;
    void tick().then(() => heading?.focus());
  });

  const go = async (target: number) => {
    const next = Math.min(Math.max(target, 0), last);
    await goto(Route.onboarding({ step: steps[next].id }), { keepFocus: true, noScroll: true });
  };

  let finishing = $state(false);
  const finish = async () => {
    if (finishing) {
      return;
    }
    finishing = true;
    try {
      if (authManager.user.isAdmin) {
        await updateAdminOnboarding({ adminOnboardingUpdateDto: { isOnboarded: true } });
        await serverConfigManager.loadServerConfig();
      }

      await setUserOnboarding({
        onboardingDto: { isOnboarded: true },
      });

      clearOnboardingProgress(authManager.user.id);
      await goto(Route.photos());
    } finally {
      finishing = false;
    }
  };

  const finishLater = () => goto(Route.photos());

  const forward = () => (index === last ? finish() : go(index + 1));

  const onkeydown = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    if (event.altKey && event.key === 'ArrowRight') {
      event.preventDefault();
      void forward();
    } else if (event.altKey && event.key === 'ArrowLeft') {
      event.preventDefault();
      void go(index - 1);
    } else if (
      event.key === 'Enter' &&
      target instanceof HTMLInputElement &&
      !['radio', 'checkbox', 'search'].includes(target.type)
    ) {
      event.preventDefault();
      void forward();
    }
  };

  // The server steps edit the server settings, so they wait until those are loaded.
  let configReady = $state(false);
  onMount(async () => {
    if (userRole === OnboardingRole.SERVER) {
      await systemConfigManager.init();
    }
    configReady = true;
  });
</script>

<AuthShell withHeader={false} wide attribution>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div id="onboarding-page" class="onboarding" {onkeydown}>
    <nav aria-label={$t('frameleaf_onboarding_steps_label')}>
      <ol class="ob-rail">
        {#each steps as entry, position (entry.id)}
          <li class:done={position < index}>
            <button
              type="button"
              aria-current={position === index ? 'step' : undefined}
              disabled={position > reached}
              onclick={() => go(position)}
            >
              <span class="ob-step-mark" aria-hidden="true">
                {#if position < index}<Icon icon={mdiCheck} size="14" />{:else}{position + 1}{/if}
              </span>
              {$t(entry.short)}
            </button>
          </li>
        {/each}
      </ol>
      <div class="ob-progress" aria-hidden="true">
        <span>{$t('frameleaf_onboarding_step_of', { values: { step: index + 1, count: steps.length } })}</span>
        <div class="ob-progress-bar">
          <span style:width="{((index + 1) / steps.length) * 100}%"></span>
        </div>
      </div>
    </nav>
    <div class="ob-panel">
      <div class="auth-heading">
        <h1 bind:this={heading} tabindex="-1">{$t(step.title)}</h1>
        <p class="sr-only">
          {$t('frameleaf_onboarding_step_of', { values: { step: index + 1, count: steps.length } })}
        </p>
      </div>
      {#key step.id}
        <div class="ob-body">
          {#if configReady}
            {#if step.id === 'server_privacy'}
              <OnboardingServerPrivacy firstVisit={!visited.has(step.id)} />
            {:else}
              <StepBody />
            {/if}
          {/if}
        </div>
      {/key}
      <div class="ob-nav">
        <div>
          {#if index > 0}
            <button type="button" class="button" onclick={() => go(index - 1)}>
              <Icon icon={languageManager.rtl ? mdiArrowRight : mdiArrowLeft} size="16" aria-hidden={true} />
              {$t('back')}
            </button>
          {/if}
          {#if index < last}
            <button type="button" class="auth-link" onclick={finishLater}
              >{$t('frameleaf_onboarding_finish_later')}</button
            >
          {/if}
        </div>
        <div>
          <span class="auth-note">{$t('frameleaf_onboarding_keyboard_note')}</span>
          {#if index < last}
            <button type="button" class="button primary" onclick={() => go(index + 1)}>
              <!-- AuthScreens.jsx:1553-1555: the optional account step reads "Skip" until linked -->
              {step.id === 'frameleaf_account' && cloudManager.status?.state !== 'linked'
                ? $t('frameleaf_onboarding_skip')
                : $t('next')}
              <Icon icon={languageManager.rtl ? mdiArrowLeft : mdiArrowRight} size="16" aria-hidden={true} />
            </button>
          {:else}
            <button type="button" class="button primary" disabled={finishing} onclick={finish}>
              {$t('frameleaf_onboarding_open')}
            </button>
          {/if}
        </div>
      </div>
    </div>
  </div>
</AuthShell>

<style>
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }
  .ob-nav .button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  h1:focus {
    outline: none;
  }
</style>
