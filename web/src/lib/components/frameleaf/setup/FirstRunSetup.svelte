<script lang="ts">
  /**
   * Frameleaf first-run setup (FL-176): the prototype's `FirstRunSetup`
   * (`design/frameleaf/template/src/FirstRunSetup.jsx`). Two administrator flows share one always-dark
   * stage — a new server, and the first Frameleaf launch on an existing library — with the chapter
   * rail, the logo intro, step slide/fade and count-ups. Motion is gated on
   * `mediaQueryManager.reducedMotion` (plain fades).
   *
   * Progress is saved after every change: in this browser, and on the server once an administrator
   * is signed in. Passwords live only in `secrets` and go straight to the sign-up and login calls.
   * Finishing writes the choices to the server settings, then asks the server to finish, which
   * re-checks the administrator and the library location.
   */
  import { goto } from '$app/navigation';
  import logoDarkUrl from '$lib/assets/frameleaf/frameleaf-logo-dark.svg?url';
  import AuthPasswordField from '$lib/components/frameleaf/AuthPasswordField.svelte';
  import AuthPasswordQuality from '$lib/components/frameleaf/AuthPasswordQuality.svelte';
  import SetupChange from '$lib/components/frameleaf/setup/SetupChange.svelte';
  import SetupChoiceCard from '$lib/components/frameleaf/setup/SetupChoiceCard.svelte';
  import SetupCountUp from '$lib/components/frameleaf/setup/SetupCountUp.svelte';
  import SetupFrameleafLink from '$lib/components/frameleaf/setup/SetupFrameleafLink.svelte';
  import SetupImports from '$lib/components/frameleaf/setup/SetupImports.svelte';
  import SetupLogoIntro from '$lib/components/frameleaf/setup/SetupLogoIntro.svelte';
  import SetupRadio from '$lib/components/frameleaf/setup/SetupRadio.svelte';
  import SetupRecommended from '$lib/components/frameleaf/setup/SetupRecommended.svelte';
  import SetupSwitch from '$lib/components/frameleaf/setup/SetupSwitch.svelte';
  import { stepIn, staggerIn } from '$lib/components/frameleaf/setup/setup-motion';
  import { findCloudBackup, type FoundCloudBackup } from '$lib/frameleaf/cloud-backup-discovery';
  import {
    accountToolSections,
    applySetupChoices,
    chapterIndex,
    clearLocalSetup,
    firstInvalidStep,
    flowSteps,
    formatTb,
    goToStep,
    itemsPerHour,
    KEEP_LAYOUT,
    layoutPattern,
    layoutPresets,
    modelTiers,
    needsReindex,
    processingOptions,
    reindexHours,
    saveLocalSetup,
    setLinked,
    setupChapters,
    SETUP_THEME,
    themeAfterSetup,
    toProgress,
    validateStep,
    type SetupChoices,
    type SetupState,
  } from '$lib/frameleaf/first-run-setup';
  import { renderStorageTemplate } from '$lib/frameleaf/onboarding';
  import '$lib/frameleaf/auth.css';
  import '$lib/frameleaf/first-run-setup.css';
  import '$lib/frameleaf/tokens.css';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { serverConfigManager } from '$lib/managers/server-config-manager.svelte';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { Route } from '$lib/route';
  import { handleSystemConfigSave } from '$lib/services/system-config.service';
  import { lang } from '$lib/stores/preferences.store';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import { convertBCP47, langs } from '$lib/utils/i18n';
  import {
    finishFrameleafSetup,
    FrameleafSetupFlow,
    getConfig,
    getFrameleafSetupLibrary,
    getFrameleafSetupStorage,
    getHardwareCheck,
    getPublicConfig,
    getSummary,
    HardwareBackend,
    login,
    QueueCommand,
    QueueName,
    runQueueCommandLegacy,
    searchUsersAdmin,
    setUserOnboarding,
    signUpAdmin,
    updateFrameleafSetup,
    type AdminConfigDto,
    type FrameleafSetupLibraryResponseDto,
    type FrameleafSetupStorageResponseDto,
    type HardwareCheckResponseDto,
    type UserAdminResponseDto,
  } from '@immich/sdk';
  import { Icon, ThemePreference, themeManager } from '@immich/ui';
  import {
    mdiAccountMultipleOutline,
    mdiAccountOutline,
    mdiAlertCircleOutline,
    mdiAlertOutline,
    mdiArrowLeft,
    mdiArrowRight,
    mdiBackupRestore,
    mdiCheck,
    mdiCheckCircle,
    mdiChip,
    mdiClockOutline,
    mdiCloudCheckOutline,
    mdiCloudOutline,
    mdiDatabaseCheckOutline,
    mdiFolderOutline,
    mdiFolderSearchOutline,
    mdiHarddisk,
    mdiImageAlbum,
    mdiImageBrokenVariant,
    mdiImageMultipleOutline,
    mdiInformationOutline,
    mdiLoading,
    mdiMoonWaningCrescent,
    mdiMovieEditOutline,
    mdiServerOutline,
    mdiShieldCheck,
    mdiShieldCheckOutline,
    mdiShieldLockOutline,
    mdiSprout,
    mdiTimerSandComplete,
    mdiTranslate,
    mdiWhiteBalanceSunny,
  } from '@mdi/js';
  import { onMount, tick } from 'svelte';
  import { locale as i18nLocale, t } from 'svelte-i18n';

  type Props = { initial: SetupState; authenticated: boolean };
  const { initial, authenticated }: Props = $props();

  // svelte-ignore state_referenced_locally
  let setup = $state<SetupState>(initial);
  // svelte-ignore state_referenced_locally
  let signedIn = $state(authenticated);
  let secrets = $state({ email: '', password: '', confirm: '' });
  let errors = $state<Record<string, string>>({});
  let formError = $state('');
  let direction = $state(1);
  let introReady = $state(false);
  let busy = $state(false);
  let heading = $state<HTMLHeadingElement>();

  let storage = $state<FrameleafSetupStorageResponseDto | null>(null);
  let config = $state<AdminConfigDto | null>(null);
  let library = $state<FrameleafSetupLibraryResponseDto | null>(null);
  let health = $state<{ missing: number; damaged: number } | null>(null);
  let hardware = $state<HardwareCheckResponseDto | null>(null);
  let users = $state<UserAdminResponseDto[]>([]);
  let backup = $state<FoundCloudBackup | null>(null);

  const steps = $derived(flowSteps(setup.flow));
  const current = $derived(steps[setup.step]);
  const choices = $derived(setup.choices);
  const linked = $derived(choices.linked);
  const context = $derived({ secrets, storageWritable: storage ? storage.writable : null });
  const chapterAt = $derived(chapterIndex(current.chapter));
  const last = $derived(setup.step === steps.length - 1);
  const blocked = $derived(!validateStep(setup, current.id, context).ok);

  const loadServerData = async () => {
    const [storageResult, configResult, libraryResult, summary, hardwareResult, usersResult] = await Promise.allSettled(
      [
        getFrameleafSetupStorage(),
        getConfig(),
        setup.flow === 'existing' ? getFrameleafSetupLibrary() : Promise.resolve(null),
        setup.flow === 'existing' ? getSummary({ allAccounts: true }) : Promise.resolve(null),
        getHardwareCheck(),
        setup.flow === 'existing' ? searchUsersAdmin({}) : Promise.resolve([]),
      ],
    );
    storage = storageResult.status === 'fulfilled' ? storageResult.value : null;
    config = configResult.status === 'fulfilled' ? configResult.value : null;
    library = libraryResult.status === 'fulfilled' ? libraryResult.value : null;
    if (summary.status === 'fulfilled' && summary.value) {
      const queues = summary.value.queues;
      health = { missing: queues.missing, damaged: queues.damagedConfirmed + queues.damagedSuspected };
    }
    hardware = hardwareResult.status === 'fulfilled' ? hardwareResult.value : null;
    users = usersResult.status === 'fulfilled' ? usersResult.value : [];
  };

  /**
   * Whether this server can offer Sign in with Frameleaf (FL-158). Until Frameleaf Cloud is
   * reachable a brand-new server can't, so the local account becomes the default and the Frameleaf
   * card says why it's unavailable.
   */
  let frameleafAvailable = $state<boolean | null>(null);

  onMount(() => {
    if (signedIn) {
      void loadServerData();
    }
    if (setup.flow === 'new') {
      Promise.resolve()
        .then(() => getPublicConfig())
        .then((config) => (frameleafAvailable = config.frameleaf?.signInAvailable === true))
        .catch(() => (frameleafAvailable = false));
    }
  });

  $effect(() => {
    if (frameleafAvailable === false && setup.choices.signIn === 'frameleaf' && !setup.choices.linked) {
      choose({ signIn: 'local' });
    }
  });

  // Saved after every change: here always, on the server once an administrator is signed in.
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    const snapshot = $state.snapshot(setup) as SetupState;
    saveLocalSetup(snapshot);
    if (!signedIn || snapshot.completed) {
      return;
    }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      updateFrameleafSetup({
        frameleafSetupUpdateDto: {
          flow: snapshot.flow === 'new' ? FrameleafSetupFlow.New : FrameleafSetupFlow.Existing,
          progress: toProgress(snapshot),
        },
      }).catch(() => {
        // this browser's copy still resumes; the next change tries again
      });
    }, 300);
  });

  let firstStep = true;
  $effect(() => {
    void setup.step;
    errors = {};
    formError = '';
    if (firstStep) {
      firstStep = false;
      return;
    }
    if (current.id !== 'admin-sign-in') {
      void tick().then(() => heading?.focus({ preventScroll: true }));
    }
  });

  // "We found a backup" appears only when the Cloud reports one (FL-145 wires the discovery).
  $effect(() => {
    if (linked && setup.flow === 'new') {
      void findCloudBackup().then((found) => (backup = found));
    } else {
      backup = null;
    }
  });

  const choose = (patch: Partial<SetupChoices>) => {
    setup = { ...setup, choices: { ...setup.choices, ...patch } };
  };
  const link = (value: boolean) => {
    setup = setLinked(setup, value);
  };

  const translateErrors = (raw: Record<string, string>) =>
    Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, $t(value as never)]));

  const move = (target: number) => {
    direction = target >= setup.step ? 1 : -1;
    setup = goToStep(setup, target, context);
  };

  /** The side effects a step needs before it can be left: creating or signing in the admin. */
  const leaveStep = async () => {
    if (current.id === 'admin-sign-in' && !signedIn) {
      const user = await login({ loginCredentialDto: { email: secrets.email.trim(), password: secrets.password } });
      secrets.password = '';
      if (!user.isAdmin) {
        // Other accounts aren't part of setup: they go on to the library as usual.
        await goto(user.isOnboarded ? Route.photos() : Route.onboarding(), { invalidateAll: true });
        return false;
      }
      await authManager.load();
      signedIn = true;
      choose({ signedIn: true });
      await loadServerData();
    }
    if (current.id === 'account' && setup.flow === 'new' && choices.signIn === 'local' && !choices.accountCreated) {
      const email = choices.adminEmail.trim();
      await signUpAdmin({ signUpDto: { email, password: secrets.password, name: choices.adminName.trim() } });
      await login({ loginCredentialDto: { email, password: secrets.password } });
      secrets.password = '';
      secrets.confirm = '';
      await Promise.all([authManager.load(), serverConfigManager.loadServerConfig()]);
      signedIn = true;
      choose({ accountCreated: true });
      // Record the new-server flow now, not on the debounced save: a reload before that save would
      // otherwise resume this server as an existing library.
      try {
        await updateFrameleafSetup({
          frameleafSetupUpdateDto: { flow: FrameleafSetupFlow.New, progress: toProgress(setup) },
        });
      } catch {
        // the server also reads one account with nothing uploaded as a new server
      }
      await loadServerData();
    }
    return true;
  };

  const go = async (target: number) => {
    if (busy) {
      return;
    }
    if (target > setup.step) {
      const check = validateStep(setup, current.id, context);
      if (!check.ok) {
        errors = translateErrors(check.errors);
        return;
      }
      busy = true;
      try {
        if (!(await leaveStep())) {
          return;
        }
      } catch (error) {
        formError = getServerErrorMessage(error) || $t('frameleaf_setup_error_generic');
        return;
      } finally {
        busy = false;
      }
    }
    move(target);
  };
  const next = () => go(setup.step + 1);

  const finish = async () => {
    if (busy) {
      return;
    }
    // A required step can go stale (storage became read-only, account unlinked): go back to it.
    const invalid = firstInvalidStep(setup, Infinity, context);
    if (invalid >= 0) {
      direction = -1;
      setup = { ...setup, step: invalid };
      errors = translateErrors(validateStep(setup, steps[invalid].id, context).errors);
      return;
    }
    busy = true;
    formError = '';
    try {
      const current = await getConfig();
      await handleSystemConfigSave(applySetupChoices(current, setup));
      if (needsReindex(current, setup)) {
        await runQueueCommandLegacy({
          name: QueueName.SmartSearch,
          queueCommandDto: { command: QueueCommand.Start, force: true },
        });
      }
      await finishFrameleafSetup();
      await setUserOnboarding({ onboardingDto: { isOnboarded: true } });
      setup = { ...setup, completed: true };
      clearLocalSetup();
      await serverConfigManager.loadServerConfig();
      themeManager.setPreference(
        themeAfterSetup(choices.theme) === 'light' ? ThemePreference.Light : ThemePreference.Dark,
      );
      await goto(
        choices.restore === 'restore' && linked ? commandCenterUrl('cloud', 'cloud-account') : Route.photos(),
        { invalidateAll: true },
      );
    } catch (error) {
      formError = getServerErrorMessage(error) || $t('frameleaf_setup_error_generic');
    } finally {
      busy = false;
    }
  };

  const chooseLanguage = async (value: string) => {
    choose({ language: value });
    $lang = value;
    await i18nLocale.set(convertBCP47(value));
  };

  const onkeydown = (event: KeyboardEvent) => {
    if (event.altKey && event.key === 'ArrowLeft') {
      void go(setup.step - 1);
    }
  };

  // ------------------------------------------------------------- derived copy
  const currentTemplate = $derived(config?.storageTemplate.template ?? '{{y}}/{{y}}-{{MM}}-{{dd}}/{{filename}}');
  const storageLabel = $derived(authManager.authenticated ? authManager.user.storageLabel || 'admin' : 'admin');
  const examplePath = (layout: string) =>
    renderStorageTemplate(layoutPattern(layout, currentTemplate), storageLabel).path;
  const preset = $derived(layoutPresets.find((entry) => entry.id === choices.layout) ?? layoutPresets[0]);
  const pathParts = $derived(examplePath(choices.layout).split('/'));
  const tier = $derived(modelTiers.find((entry) => entry.id === choices.model) ?? modelTiers[1]);
  const gpu = $derived(!!hardware && hardware.ml.backend !== HardwareBackend.Cpu && hardware.ml.reachable);
  const perHour = $derived(itemsPerHour(gpu, hardware?.benchmark?.embeddingMs));
  const items = $derived(library?.items ?? 0);
  const hours = $derived(reindexHours(items, choices.model, perHour));
  const options = $derived(processingOptions(setup));
  const existing = $derived(setup.flow === 'existing');
  const formatCount = (value: number) => new Intl.NumberFormat().format(Math.round(value));
  const hardwareName = (entry: HardwareCheckResponseDto['ml'] | undefined) =>
    entry ? [entry.vendor, entry.model].filter(Boolean).join(' ') || entry.backend.toUpperCase() : '';

  const recommendedSteps = new Set(['sign-in-choice', 'processing', 'protection', 'privacy', 'library-check']);
  const usesRecommended = $derived(
    recommendedSteps.has(current.id) || (current.id === 'account' && existing && !linked && choices.signIn === 'local'),
  );
  const isRecommendedChoice = $derived(
    (current.id === 'sign-in-choice' && choices.signIn === (frameleafAvailable === false ? 'local' : 'frameleaf')) ||
      (current.id === 'library-check' && choices.layout === KEEP_LAYOUT) ||
      (current.id === 'account' && existing) ||
      (current.id === 'processing' && choices.processing === 'local' && choices.model === 'balanced') ||
      (current.id === 'protection' && choices.nightlyBackup) ||
      current.id === 'privacy',
  );

  const summaryRows = $derived.by(() => {
    const rows: [string, string][] = [
      [
        $t('frameleaf_setup_chapter_account'),
        linked
          ? $t('frameleaf_setup_summary_linked')
          : existing
            ? $t('frameleaf_setup_summary_local_kept')
            : $t('frameleaf_setup_summary_local'),
      ],
      [
        $t('frameleaf_setup_chapter_library'),
        existing && choices.layout === KEEP_LAYOUT
          ? $t('frameleaf_setup_summary_layout_kept')
          : examplePath(choices.layout),
      ],
      [
        $t('frameleaf_setup_processing_title'),
        $t('frameleaf_setup_summary_processing', {
          values: {
            tier: $t(tier.label),
            where:
              choices.processing === 'cloud'
                ? $t('frameleaf_setup_summary_where_cloud')
                : choices.processing === 'later'
                  ? $t('frameleaf_setup_summary_where_later')
                  : $t('frameleaf_setup_summary_where_local'),
          },
        }),
      ],
      [
        $t('frameleaf_setup_summary_database_backups'),
        choices.nightlyBackup ? $t('frameleaf_setup_summary_nightly') : $t('frameleaf_setup_summary_off'),
      ],
    ];
    const on = [
      choices.updates && $t('frameleaf_setup_summary_updates'),
      choices.map && $t('frameleaf_setup_summary_map'),
    ]
      .filter(Boolean)
      .join(', ');
    rows.push([
      $t('frameleaf_setup_privacy_title'),
      on ? on[0].toUpperCase() + on.slice(1) : $t('frameleaf_setup_summary_everything_off'),
    ]);
    return rows;
  });

  const jobs = $derived.by(() => {
    if (!existing) {
      return [{ id: 'index', label: $t('frameleaf_setup_job_index'), detail: $t('frameleaf_setup_job_index_detail') }];
    }
    if (choices.processing === 'later') {
      return [];
    }
    return [
      {
        id: 'reindex',
        label: $t('frameleaf_setup_job_reindex', { values: { count: formatCount(items) } }),
        detail: $t('frameleaf_setup_job_reindex_detail', { values: { hours } }),
      },
      { id: 'health', label: $t('frameleaf_setup_job_health'), detail: $t('frameleaf_setup_job_health_detail') },
    ];
  });

  const headingText = $derived(
    current.id === 'account' && !existing && choices.signIn === 'local'
      ? $t('frameleaf_setup_account_create_title')
      : current.id === 'account' && !existing
        ? $t('frameleaf_setup_sign_in_frameleaf')
        : $t(current.title),
  );
  const people = $derived(users.filter((user) => user.id !== (authManager.authenticated ? authManager.user.id : '')));
</script>

{#snippet languagePicker()}
  <label class="frs-language">
    <Icon icon={mdiTranslate} size="16" aria-hidden={true} />
    <span class="sr-only">{$t('language')}</span>
    <select value={choices.language} onchange={(event) => void chooseLanguage(event.currentTarget.value)}>
      {#each langs as entry (entry.code)}
        <option value={convertBCP47(entry.code)}>{entry.name}</option>
      {/each}
    </select>
  </label>
{/snippet}

{#snippet stat(icon: string, value: number, label: string, delay: number, format?: (value: number) => string)}
  <div class="frs-stat">
    <Icon {icon} size="20" aria-hidden={true} />
    <strong><SetupCountUp {value} {format} {delay} /></strong>
    <span>{label}</span>
  </div>
{/snippet}

{#snippet layoutChoices(withKeep: boolean)}
  <div class="frs-radios" role="radiogroup" aria-label={$t('frameleaf_setup_layout_label')}>
    {#if withKeep}
      <SetupRadio
        name="frs-layout"
        value={KEEP_LAYOUT}
        checked={choices.layout === KEEP_LAYOUT}
        onchange={(layout) => choose({ layout })}
        title={$t('frameleaf_setup_layout_keep')}
        detail={examplePath(KEEP_LAYOUT)}
        recommended
      />
    {/if}
    {#each layoutPresets as entry (entry.id)}
      <SetupRadio
        name="frs-layout"
        value={entry.id}
        checked={choices.layout === entry.id}
        onchange={(layout) => choose({ layout })}
        title={$t(entry.label)}
        detail={examplePath(entry.id)}
        recommended={!withKeep && entry.recommended}
      />
    {/each}
  </div>
{/snippet}

{#snippet facts(rows: [string, string][])}
  <dl class="frs-facts">
    {#each rows as [label, value] (label)}
      <div>
        <dt>{label}</dt>
        <dd>{value}</dd>
      </div>
    {/each}
  </dl>
{/snippet}

<section class="frameleaf auth-screen frs-root" data-theme={SETUP_THEME} data-flow={setup.flow}>
  {#if current.id === 'admin-sign-in'}
    <div class="frs frs-stage-screen">
      <div class="frs-stage">
        <div class="frs-gate">
          <img class="frs-gate-logo" src={logoDarkUrl} alt="Frameleaf" />
          <div class="frs-gate-note">
            <Icon icon={mdiDatabaseCheckOutline} size="20" aria-hidden={true} />
            <span>{$t('frameleaf_setup_gate_note')}</span>
          </div>
          <form
            class="auth-card frs-gate-card"
            novalidate
            onsubmit={(event) => {
              event.preventDefault();
              void next();
            }}
          >
            <div class="auth-heading">
              <h1 bind:this={heading} tabindex="-1">{$t('frameleaf_setup_gate_title')}</h1>
              <p>{$t('frameleaf_setup_gate_body')}</p>
            </div>
            {#if errors.password || formError}
              <p class="auth-error" role="alert">
                <Icon icon={mdiAlertCircleOutline} size="16" /><span>{errors.password || formError}</span>
              </p>
            {/if}
            <div class="auth-field">
              <label for="frs-gate-email">{$t('frameleaf_setup_gate_email')}</label>
              <input id="frs-gate-email" type="email" autocomplete="username" bind:value={secrets.email} />
            </div>
            <AuthPasswordField
              id="frs-gate-password"
              label={$t('frameleaf_auth_password')}
              autocomplete="current-password"
              bind:value={secrets.password}
            />
            <button type="submit" class="button primary auth-submit" disabled={busy}>
              {$t('frameleaf_setup_gate_submit')}
            </button>
          </form>
        </div>
      </div>
    </div>
  {:else if current.id === 'welcome'}
    <div class="frs frs-stage-screen" data-flow={setup.flow}>
      <div class="frs-stage">
        <div class="frs-stage-corner">
          {#if signedIn}<a class="auth-link" href={Route.logout()}>{$t('frameleaf_setup_sign_out')}</a>{/if}
          {@render languagePicker()}
        </div>
        {#if !existing}
          <SetupLogoIntro onSettled={() => (introReady = true)}>
            <p class="frs-tagline" data-intro>{$t('frameleaf_setup_tagline_new')}</p>
            <button
              type="button"
              class="button primary frs-continue"
              data-intro
              data-ready={introReady || undefined}
              onclick={() => void next()}
            >
              {$t('frameleaf_setup_continue_setup')}<Icon icon={mdiArrowRight} size="16" aria-hidden={true} />
            </button>
          </SetupLogoIntro>
        {:else}
          <SetupLogoIntro onSettled={() => (introReady = true)}>
            <p class="frs-tagline" data-intro>{$t('frameleaf_setup_tagline_existing')}</p>
            <div class="frs-safe" data-intro>
              <div class="frs-stats" aria-label={$t('frameleaf_setup_your_library')}>
                {@render stat(mdiImageMultipleOutline, library?.items ?? 0, $t('frameleaf_setup_stat_items'), 2600)}
                {@render stat(mdiAccountMultipleOutline, library?.people ?? 0, $t('frameleaf_setup_stat_people'), 2700)}
                {@render stat(mdiImageAlbum, library?.albums ?? 0, $t('frameleaf_setup_stat_albums'), 2800)}
                {@render stat(mdiHarddisk, library?.bytes ?? 0, $t('frameleaf_setup_stat_originals'), 2900, formatTb)}
              </div>
              <p class="frs-safe-note">
                <Icon icon={mdiShieldCheckOutline} size="16" aria-hidden={true} />{$t('frameleaf_setup_safe_note')}
              </p>
            </div>
            <div class="frs-whatsnew" data-intro>
              {#each [[mdiMovieEditOutline, 'frameleaf_setup_new_studio', 'frameleaf_setup_new_studio_body'], [mdiShieldCheckOutline, 'frameleaf_setup_new_care', 'frameleaf_setup_new_care_body'], [mdiCloudOutline, 'frameleaf_setup_new_cloud', 'frameleaf_setup_new_cloud_body']] as const as [icon, title, body] (title)}
                <article>
                  <Icon {icon} size="22" aria-hidden={true} />
                  <strong>{$t(title)}</strong>
                  <span>{$t(body)}</span>
                </article>
              {/each}
            </div>
            <button
              type="button"
              class="button primary frs-continue"
              data-intro
              data-ready={introReady || undefined}
              onclick={() => void next()}
            >
              {$t('frameleaf_setup_continue_setup')}<Icon icon={mdiArrowRight} size="16" aria-hidden={true} />
            </button>
          </SetupLogoIntro>
        {/if}
      </div>
    </div>
  {:else}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="frs frs-flow" data-flow={setup.flow} {onkeydown}>
      <aside class="frs-rail">
        <img class="frs-rail-logo" src={logoDarkUrl} alt="Frameleaf" />
        <nav aria-label={$t('frameleaf_setup_chapters')}>
          <ol style:--frs-progress={chapterAt / (setupChapters.length - 1)}>
            {#each setupChapters as chapter, position (chapter.id)}
              {@const first = steps.findIndex((entry) => entry.chapter === chapter.id)}
              {@const reachable = first >= 0 && first <= setup.reached}
              {@const status = position < chapterAt ? 'done' : position === chapterAt ? 'current' : 'todo'}
              <li data-status={status}>
                <button
                  type="button"
                  aria-current={status === 'current' ? 'step' : undefined}
                  disabled={!reachable || status === 'current'}
                  onclick={() => void go(first)}
                >
                  <span class="frs-rail-dot" aria-hidden="true">
                    {#if status === 'done'}<Icon icon={mdiCheck} size="13" />{:else}{position + 1}{/if}
                  </span>
                  <span>{$t(chapter.label)}</span>
                </button>
                {#if status === 'current'}
                  <ul>
                    {#each steps.filter((entry) => entry.chapter === chapter.id && entry.id !== 'welcome' && entry.id !== 'admin-sign-in') as entry (entry.id)}
                      <li aria-current={entry.id === current.id ? 'true' : undefined}>{$t(entry.title)}</li>
                    {/each}
                  </ul>
                {/if}
              </li>
            {/each}
          </ol>
        </nav>
        {@render languagePicker()}
      </aside>
      <main class="frs-main">
        {#key current.id}
          <div class="frs-step" use:stepIn={direction}>
            <header class="frs-head">
              <span class="frs-eyebrow">
                {$t('frameleaf_setup_eyebrow', {
                  values: { chapter: $t(setupChapters[chapterAt].label), step: setup.step + 1, count: steps.length },
                })}
              </span>
              <h1 bind:this={heading} tabindex="-1">{headingText}</h1>
              {#if current.required}<span class="frs-required">{$t('frameleaf_setup_required')}</span>{/if}
            </header>
            <div class="frs-body">
              {#if formError}
                <p class="auth-error" role="alert">
                  <Icon icon={mdiAlertCircleOutline} size="16" /><span>{formError}</span>
                </p>
              {/if}
              {#if current.id === 'sign-in-choice'}
                <div class="frs-choices two" role="radiogroup" aria-label={$t('frameleaf_setup_sign_in_choice_title')}>
                  <SetupChoiceCard
                    name="frs-signin"
                    value="frameleaf"
                    checked={choices.signIn === 'frameleaf'}
                    onchange={() => choose({ signIn: 'frameleaf' })}
                    icon="frameleaf"
                    title={$t('frameleaf_setup_choice_frameleaf')}
                    recommended={frameleafAvailable !== false}
                    disabled={frameleafAvailable === false}
                  >
                    {#if frameleafAvailable === false}
                      <strong class="frs-unavailable">{$t('frameleaf_setup_choice_frameleaf_unavailable')}</strong>
                    {/if}
                    <ul class="frs-ticks">
                      <li>{$t('frameleaf_setup_choice_frameleaf_remote')}</li>
                      <li>{$t('frameleaf_setup_choice_frameleaf_anywhere')}</li>
                      <li>{$t('frameleaf_setup_choice_frameleaf_cloud')}</li>
                      <li>{$t('frameleaf_setup_choice_frameleaf_license')}</li>
                    </ul>
                    <small>{$t('frameleaf_setup_choice_frameleaf_note')}</small>
                  </SetupChoiceCard>
                  <SetupChoiceCard
                    name="frs-signin"
                    value="local"
                    checked={choices.signIn === 'local'}
                    onchange={() => {
                      link(false);
                      choose({ signIn: 'local' });
                    }}
                    icon={mdiServerOutline}
                    title={$t('frameleaf_setup_choice_local')}
                    recommended={frameleafAvailable === false}
                  >
                    <ul class="frs-ticks">
                      <li>{$t('frameleaf_setup_choice_local_stored')}</li>
                      <li>{$t('frameleaf_setup_choice_local_network')}</li>
                      <li>{$t('frameleaf_setup_choice_local_later')}</li>
                    </ul>
                    <small>{$t('frameleaf_setup_choice_local_note')}</small>
                  </SetupChoiceCard>
                </div>
              {:else if current.id === 'account' && existing}
                <div class="frs-choices two" role="radiogroup" aria-label={$t('frameleaf_setup_account_title')}>
                  <SetupChoiceCard
                    name="frs-keep"
                    value="local"
                    checked={!linked && choices.signIn === 'local'}
                    onchange={() => choose({ signIn: 'local' })}
                    icon={mdiAccountOutline}
                    title={$t('frameleaf_setup_keep_local')}
                    recommended
                  >
                    <span>{$t('frameleaf_setup_keep_local_body')}</span>
                  </SetupChoiceCard>
                  <SetupChoiceCard
                    name="frs-keep"
                    value="frameleaf"
                    checked={choices.signIn === 'frameleaf' || linked}
                    onchange={() => choose({ signIn: 'frameleaf' })}
                    icon="frameleaf"
                    title={$t('frameleaf_setup_link_frameleaf')}
                  >
                    <span>{$t('frameleaf_setup_link_frameleaf_body')}</span>
                  </SetupChoiceCard>
                </div>
                {#if choices.signIn === 'frameleaf' || linked}
                  <SetupFrameleafLink
                    mode="link"
                    {linked}
                    onLinked={() => link(true)}
                    onFallback={() => choose({ signIn: 'local' })}
                  />
                {/if}
              {:else if current.id === 'account' && choices.signIn === 'frameleaf'}
                <p class="frs-lead">{$t('frameleaf_setup_frameleaf_lead')}</p>
                {#if errors.link}
                  <p class="auth-error" role="alert">
                    <Icon icon={mdiAlertCircleOutline} size="16" /><span>{errors.link}</span>
                  </p>
                {/if}
                <SetupFrameleafLink
                  mode="sign-in"
                  {linked}
                  onLinked={() => link(true)}
                  onFallback={() => {
                    link(false);
                    choose({ signIn: 'local' });
                  }}
                />
                {#if linked && backup}
                  <section class="frs-found" aria-labelledby="frs-found-title">
                    <header>
                      <span class="frs-found-icon"
                        ><Icon icon={mdiCloudCheckOutline} size="26" aria-hidden={true} /></span
                      >
                      <div>
                        <h2 id="frs-found-title">{$t('frameleaf_setup_found_title')}</h2>
                        <p>{$t('frameleaf_setup_found_body')}</p>
                      </div>
                    </header>
                    {@render facts([
                      [$t('frameleaf_setup_found_server'), backup.server],
                      [$t('frameleaf_setup_found_last'), new Date(backup.date).toLocaleString()],
                      [$t('frameleaf_setup_stat_items'), formatCount(backup.items)],
                      [$t('size'), formatTb(backup.bytes)],
                    ])}
                    <div class="frs-choices two" role="radiogroup" aria-label={$t('frameleaf_setup_found_title')}>
                      <SetupChoiceCard
                        name="frs-restore"
                        value="restore"
                        checked={choices.restore === 'restore'}
                        onchange={() => choose({ restore: 'restore' })}
                        icon={mdiBackupRestore}
                        title={$t('frameleaf_setup_found_restore')}
                      >
                        <span>{$t('frameleaf_setup_found_restore_body')}</span>
                      </SetupChoiceCard>
                      <SetupChoiceCard
                        name="frs-restore"
                        value="fresh"
                        checked={choices.restore === 'fresh'}
                        onchange={() => choose({ restore: 'fresh' })}
                        icon={mdiSprout}
                        title={$t('frameleaf_setup_found_fresh')}
                      >
                        <span>{$t('frameleaf_setup_found_fresh_body')}</span>
                      </SetupChoiceCard>
                    </div>
                  </section>
                {/if}
              {:else if current.id === 'account'}
                <div class="frs-form">
                  {#if choices.accountCreated}
                    <p class="frs-quiet">
                      <Icon icon={mdiCheckCircle} size="16" aria-hidden={true} />
                      {$t('frameleaf_setup_account_created', { values: { email: choices.adminEmail } })}
                    </p>
                  {:else}
                    <div class="auth-field">
                      <label for="frs-name">{$t('frameleaf_auth_name')}</label>
                      <input
                        id="frs-name"
                        autocomplete="name"
                        value={choices.adminName}
                        aria-invalid={errors.name ? true : undefined}
                        oninput={(event) => choose({ adminName: event.currentTarget.value })}
                      />
                    </div>
                    {#if errors.name}<p class="auth-error" role="alert">{errors.name}</p>{/if}
                    <div class="auth-field">
                      <label for="frs-email">{$t('frameleaf_auth_email')}</label>
                      <input
                        id="frs-email"
                        type="email"
                        autocomplete="username"
                        value={choices.adminEmail}
                        aria-invalid={errors.email ? true : undefined}
                        oninput={(event) => choose({ adminEmail: event.currentTarget.value })}
                      />
                    </div>
                    {#if errors.email}<p class="auth-error" role="alert">{errors.email}</p>{/if}
                    <AuthPasswordField
                      id="frs-password"
                      label={$t('frameleaf_auth_password')}
                      bind:value={secrets.password}
                      describedBy="frs-password-quality"
                    />
                    <AuthPasswordQuality id="frs-password-quality" password={secrets.password} />
                    {#if errors.password}<p class="auth-error" role="alert">{errors.password}</p>{/if}
                    <AuthPasswordField
                      id="frs-confirm"
                      label={$t('frameleaf_auth_confirm_password')}
                      bind:value={secrets.confirm}
                    />
                    {#if errors.confirm}<p class="auth-error" role="alert">{errors.confirm}</p>{/if}
                    <p class="auth-note">{$t('frameleaf_setup_password_note')}</p>
                  {/if}
                </div>
              {:else if current.id === 'library'}
                <section class="frs-panel">
                  <div class="auth-field">
                    <label for="frs-storage">{$t('frameleaf_setup_storage_location')}</label>
                    <div class="frs-storage">
                      <Icon icon={mdiFolderOutline} size="18" aria-hidden={true} />
                      <input
                        id="frs-storage"
                        value={storage?.path ?? ''}
                        readonly
                        spellcheck="false"
                        aria-describedby="frs-storage-check"
                      />
                    </div>
                  </div>
                  <p
                    id="frs-storage-check"
                    class="frs-check"
                    data-status={storage ? (storage.writable ? 'ok' : 'error') : 'checking'}
                    aria-live="polite"
                  >
                    {#if !storage}
                      <Icon icon={mdiLoading} size="16" class="frs-spin" aria-hidden={true} />{$t(
                        'frameleaf_setup_storage_checking',
                      )}
                    {:else if storage.writable}
                      <Icon icon={mdiCheckCircle} size="16" aria-hidden={true} />{$t('frameleaf_setup_storage_ok', {
                        values: { free: formatTb(storage.freeBytes) },
                      })}
                    {:else}
                      <Icon icon={mdiAlertCircleOutline} size="16" aria-hidden={true} />{$t(
                        'frameleaf_setup_error_storage',
                      )}
                    {/if}
                  </p>
                  <p class="auth-note">{$t('frameleaf_setup_storage_note')}</p>
                </section>
                <SetupChange>
                  {#snippet summary()}
                    <strong>
                      {$t('frameleaf_setup_layout_summary', { values: { layout: $t(preset.label) } })}
                      {#if preset.recommended}<SetupRecommended />{/if}
                    </strong>
                    <span class="frs-path">
                      {#each pathParts as part, index (index)}
                        <span style:animation-delay="{index * 80}ms"
                          >{part}{index < pathParts.length - 1 ? '/' : ''}</span
                        >
                      {/each}
                    </span>
                  {/snippet}
                  {@render layoutChoices(false)}
                </SetupChange>
              {:else if current.id === 'library-check'}
                <div class="frs-health">
                  <div class="frs-health-ring" aria-hidden="true"><Icon icon={mdiShieldCheck} size="34" /></div>
                  <div>
                    <strong>
                      {$t('frameleaf_setup_health_healthy', {
                        values: {
                          healthy: formatCount(Math.max(0, items - (health?.missing ?? 0) - (health?.damaged ?? 0))),
                          count: formatCount(items),
                        },
                      })}
                    </strong>
                    <span>{$t('frameleaf_setup_health_body')}</span>
                  </div>
                </div>
                <div class="frs-health-grid">
                  <a class="frs-health-card" class:warn={(health?.missing ?? 0) > 0} href={Route.missingMediaUtility()}>
                    <Icon icon={mdiFolderSearchOutline} size="20" aria-hidden={true} />
                    <strong><SetupCountUp value={health?.missing ?? 0} duration={900} /></strong>
                    <span>{$t('frameleaf_setup_health_missing')}</span>
                    <small>{$t('frameleaf_setup_health_review')}</small>
                  </a>
                  <a class="frs-health-card" class:warn={(health?.damaged ?? 0) > 0} href={Route.corruptMediaUtility()}>
                    <Icon icon={mdiImageBrokenVariant} size="20" aria-hidden={true} />
                    <strong><SetupCountUp value={health?.damaged ?? 0} duration={900} /></strong>
                    <span>{$t('frameleaf_setup_health_damaged')}</span>
                    <small>{$t('frameleaf_setup_health_review')}</small>
                  </a>
                </div>
                <SetupChange>
                  {#snippet summary()}
                    <strong>{$t('frameleaf_setup_layout_keep')}</strong>
                    <code>{examplePath(choices.layout)}</code>
                  {/snippet}
                  <div class="frs-warning">
                    <Icon icon={mdiAlertOutline} size="18" aria-hidden={true} />
                    <span>{$t('frameleaf_setup_layout_warning')}</span>
                  </div>
                  {@render layoutChoices(true)}
                </SetupChange>
              {:else if current.id === 'processing'}
                <section class="frs-hardware" aria-label={$t('frameleaf_setup_hardware_label')}>
                  <header>
                    <Icon icon={mdiChip} size="20" aria-hidden={true} />
                    <strong>{$t('frameleaf_setup_hardware_title')}</strong>
                    {#if gpu}
                      <span class="frs-ok"
                        ><Icon icon={mdiCheckCircle} size="14" aria-hidden={true} />
                        {$t('frameleaf_setup_gpu_ready')}</span
                      >
                    {/if}
                  </header>
                  {#if hardware}
                    {@render facts([
                      [
                        $t('frameleaf_setup_hardware_ml'),
                        hardwareName(hardware.ml) || $t('frameleaf_setup_hardware_cpu'),
                      ],
                      [
                        $t('frameleaf_setup_hardware_server'),
                        hardwareName(hardware.server) || $t('frameleaf_setup_hardware_cpu'),
                      ],
                    ])}
                  {:else}
                    <p class="frs-quiet">{$t('frameleaf_setup_hardware_unknown')}</p>
                  {/if}
                </section>
                <SetupChange>
                  {#snippet summary()}
                    <strong>
                      {$t('frameleaf_setup_tier_models', { values: { tier: $t(tier.label) } })}
                      {#if tier.recommended}<SetupRecommended />{/if}
                    </strong>
                    <span>{$t(tier.summary)}</span>
                  {/snippet}
                  <div class="frs-radios" role="radiogroup" aria-label={$t('frameleaf_setup_tier_label')}>
                    {#each modelTiers as entry (entry.id)}
                      <SetupRadio
                        name="frs-tier"
                        value={entry.id}
                        checked={choices.model === entry.id}
                        onchange={() => choose({ model: entry.id })}
                        title={$t('frameleaf_setup_tier_models', { values: { tier: $t(entry.label) } })}
                        detail={$t(entry.summary)}
                        recommended={entry.recommended}
                      />
                    {/each}
                  </div>
                </SetupChange>
                {#if existing}
                  <p class="frs-estimate">
                    <Icon icon={mdiTimerSandComplete} size="18" aria-hidden={true} />
                    <span
                      >{$t('frameleaf_setup_reindex_estimate', { values: { count: formatCount(items), hours } })}</span
                    >
                  </p>
                {/if}
                <div
                  class="frs-choices"
                  class:three={existing && options.includes('cloud')}
                  class:two={!existing || !options.includes('cloud')}
                  role="radiogroup"
                  aria-label={$t('frameleaf_setup_where_label')}
                >
                  <SetupChoiceCard
                    name="frs-where"
                    value="local"
                    checked={choices.processing === 'local'}
                    onchange={() => choose({ processing: 'local' })}
                    icon={mdiServerOutline}
                    title={existing ? $t('frameleaf_setup_where_here') : $t('frameleaf_setup_where_local_only')}
                    recommended
                  >
                    <span>
                      {existing
                        ? $t('frameleaf_setup_where_here_body', { values: { hours } })
                        : $t('frameleaf_setup_where_local_only_body')}
                    </span>
                  </SetupChoiceCard>
                  {#if options.includes('cloud')}
                    <SetupChoiceCard
                      name="frs-where"
                      value="cloud"
                      checked={choices.processing === 'cloud'}
                      onchange={() => choose({ processing: 'cloud' })}
                      icon={mdiCloudOutline}
                      title={$t('frameleaf_setup_where_cloud')}
                    >
                      <span>{$t('frameleaf_setup_where_cloud_body')}</span>
                    </SetupChoiceCard>
                  {/if}
                  {#if existing}
                    <SetupChoiceCard
                      name="frs-where"
                      value="later"
                      checked={choices.processing === 'later'}
                      onchange={() => choose({ processing: 'later' })}
                      icon={mdiClockOutline}
                      title={$t('frameleaf_setup_where_later')}
                    >
                      <span>{$t('frameleaf_setup_where_later_body')}</span>
                    </SetupChoiceCard>
                  {/if}
                </div>
                {#if existing}<p class="auth-note">{$t('frameleaf_setup_jobs_note')}</p>{/if}
              {:else if current.id === 'protection'}
                <div class="frs-switches">
                  <SetupSwitch
                    label={$t('frameleaf_setup_nightly_title')}
                    description={choices.nightlyBackup
                      ? $t('frameleaf_setup_nightly_on')
                      : $t('frameleaf_setup_nightly_off')}
                    checked={choices.nightlyBackup}
                    onchange={(nightlyBackup) => choose({ nightlyBackup })}
                  />
                </div>
                {#if linked}
                  <section class="frs-cloud-backup">
                    <header>
                      <span class="frs-found-icon"><Icon icon={mdiCloudOutline} size="24" aria-hidden={true} /></span>
                      <div>
                        <h2>{$t('frameleaf_setup_cloud_backup_title')}</h2>
                        <p>{$t('frameleaf_setup_cloud_backup_body')}</p>
                      </div>
                    </header>
                    <a class="auth-link" href={commandCenterUrl('cloud', 'cloud-account')}
                      >{$t('frameleaf_setup_cloud_backup_link')}</a
                    >
                  </section>
                {:else}
                  <p class="frs-quiet">
                    <Icon icon={mdiInformationOutline} size="16" aria-hidden={true} />{$t(
                      'frameleaf_setup_cloud_backup_needs_account',
                    )}
                  </p>
                {/if}
              {:else if current.id === 'privacy'}
                <div class="frs-switches">
                  <SetupSwitch
                    label={$t('frameleaf_setup_privacy_updates')}
                    description={$t('frameleaf_setup_privacy_updates_body')}
                    checked={choices.updates}
                    onchange={(updates) => choose({ updates })}
                  />
                  <SetupSwitch
                    label={$t('frameleaf_setup_privacy_map')}
                    description={$t('frameleaf_setup_privacy_map_body')}
                    checked={choices.map}
                    onchange={(map) => choose({ map })}
                  />
                </div>
                {#if existing}
                  <p class="frs-quiet">
                    <Icon icon={mdiShieldLockOutline} size="16" aria-hidden={true} />{$t(
                      'frameleaf_setup_privacy_quiet',
                    )}
                  </p>
                {/if}
              {:else if current.id === 'people'}
                <p class="frs-lead">{$t('frameleaf_setup_people_lead', { values: { count: people.length } })}</p>
                <div class="frs-people">
                  <ul class="frs-people-list">
                    {#each people.slice(0, 6) as person (person.id)}
                      <li>
                        <span class="frs-avatar">{person.name.slice(0, 1).toUpperCase()}</span>
                        <div>
                          <strong>{person.name}</strong>
                          <span>{$t('frameleaf_setup_people_keeps')}</span>
                        </div>
                      </li>
                    {/each}
                  </ul>
                  <div class="frs-people-preview" aria-label={$t('frameleaf_setup_people_preview')}>
                    <span class="frs-eyebrow">{$t('frameleaf_setup_people_preview')}</span>
                    <strong>{$t('frameleaf_setup_tool_title')}</strong>
                    {#each accountToolSections as section (section.id)}
                      <span><Icon icon={mdiCheck} size="16" aria-hidden={true} />{$t(section.title)}</span>
                    {/each}
                  </div>
                </div>
              {:else if current.id === 'imports'}
                <SetupImports />
              {:else if current.id === 'ready'}
                <ul class="frs-ready" use:staggerIn>
                  {#each summaryRows as [label, value] (label)}
                    <li>
                      <span class="frs-ready-check"><Icon icon={mdiCheck} size="14" aria-hidden={true} /></span>
                      <span>{label}</span>
                      <strong>{value}</strong>
                    </li>
                  {/each}
                </ul>
                {#if choices.restore === 'restore' && linked && backup}
                  <div class="frs-handoff">
                    <Icon icon={mdiBackupRestore} size="20" aria-hidden={true} />
                    <span>{$t('frameleaf_setup_restore_next', { values: { server: backup.server } })}</span>
                  </div>
                {/if}
                <section class="frs-jobs" aria-label={$t('frameleaf_setup_jobs_label')}>
                  {#each jobs as job (job.id)}
                    <div>
                      <span class="frs-pulse" aria-hidden="true"></span>
                      <strong>{job.label}</strong>
                      <span>{job.detail}</span>
                    </div>
                  {:else}
                    <div>
                      <strong>{$t('frameleaf_setup_jobs_none')}</strong>
                      <span>{$t('frameleaf_setup_jobs_none_body')}</span>
                    </div>
                  {/each}
                  {#if jobs.length > 0}
                    <a class="auth-link" href={Route.activity()}>{$t('frameleaf_setup_jobs_follow')}</a>
                  {/if}
                </section>
                <div class="frs-theme" role="radiogroup" aria-label={$t('frameleaf_setup_theme_after')}>
                  <span>{$t('frameleaf_setup_theme_after')}</span>
                  {#each [['dark', 'dark', mdiMoonWaningCrescent], ['light', 'light', mdiWhiteBalanceSunny]] as const as [value, label, icon] (value)}
                    <label class:checked={choices.theme === value}>
                      <input
                        type="radio"
                        name="frs-theme"
                        {value}
                        checked={choices.theme === value}
                        onchange={() => choose({ theme: value })}
                      />
                      <Icon {icon} size="16" aria-hidden={true} />{$t(label)}
                    </label>
                  {/each}
                </div>
              {/if}
            </div>
          </div>
        {/key}
        <div class="frs-nav">
          <button
            type="button"
            class="button"
            onclick={() => void go(setup.step - 1)}
            disabled={setup.step === 0 || busy}
          >
            <Icon icon={mdiArrowLeft} size="16" aria-hidden={true} />{$t('back')}
          </button>
          <div>
            {#if last}
              <button type="button" class="button primary frs-open" onclick={() => void finish()} disabled={busy}>
                {$t('frameleaf_setup_open')}<Icon icon={mdiArrowRight} size="16" aria-hidden={true} />
              </button>
            {:else}
              <button
                type="button"
                class="button primary"
                onclick={() => void next()}
                aria-disabled={blocked || busy || undefined}
              >
                {usesRecommended && isRecommendedChoice ? $t('frameleaf_setup_use_recommended') : $t('continue')}
                <Icon icon={mdiArrowRight} size="16" aria-hidden={true} />
              </button>
            {/if}
          </div>
        </div>
        <footer class="frs-foot">
          <span class="auth-note">{$t('frameleaf_setup_saved_note')}</span>
          {#if signedIn}
            <!-- A way out when setup can't finish; the app's own sign-out page ends the session. -->
            <a class="auth-link" href={Route.logout()}>{$t('frameleaf_setup_sign_out')}</a>
          {/if}
        </footer>
      </main>
    </div>
  {/if}
</section>

<style>
  .frs-root {
    position: fixed;
    inset: 0;
    display: flex;
    flex-direction: column;
    background: #050b10;
    color-scheme: dark;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  h1:focus {
    outline: none;
  }
</style>
