<script lang="ts">
  import { requestKey } from './request-key';
  import { onMount, tick } from 'svelte';
  import Icon from './Icon.svelte';
  import MoveLibrary from './MoveLibrary.svelte';
  import ExternalFolders from './ExternalFolders.svelte';
  import FolderPicker from './FolderPicker.svelte';
  import ServerCheck from './ServerCheck.svelte';
  import { CHECKING, checkOrder, checkRows, checkSummary, type CheckAction, type CheckContext, type CheckRow } from './server-check';
  import { encodeQr, qrPath } from './qr.mjs';
  import { regenerationPresentation } from './regeneration';
  import { operationNames, operationProgress, canCancel, serviceState, readable, formatBytes, hasGpu, processorName, plural, newerReleases, releaseNotesText, navSection, CONTAINERS, emptyContainers, parseContainerSettings, containerSummary, containerOverrides, containerText, photoAppName, photoAppDetail, photoAppReason, untestedNotice, lossText, restrictionText, ownerEmailProblems, isPhotoAppCapture, isFolderImport, sourceVersion, type PhotoAppSource } from './presentation';

  let httpSession = '';
  let csrf = '',
    claimed = $state(false),
    claimProofRequired = $state(false),
    signedIn = $state(false),
    loading = $state(true),
    busy = $state(false),
    checking = $state(false);
  let error = $state(''),
    disconnected = $state(false),
    toast = $state('');
  let password = $state(''),
    name = $state(''),
    newPassword = $state('');
  let screen = $state('welcome'),
    menu = $state(false),
    accountMenu = $state(false),
    installMenu = $state(false),
    dialog: HTMLDialogElement;
  let modal = $state(''),
    modalAction = $state(''),
    selectedOperation = $state('');
  let dashboard = $state<any>(null),
    sources = $state<any[]>([]),
    refused = $state<any[]>([]),
    discoveryLoaded = $state(false);
  let releases = $state<any[]>([]),
    releasesLoaded = $state(false),
    storage = $state<any[]>([]),
    snapshots = $state<any[]>([]),
    backupsLoaded = $state(false);
  let sourceId = $state(''),
    sourceReview = $state<any>(null),
    advancedSettings = $state(''),
    advancedOpen = $state(false),
    tag = $state(''),
    review = $state<any>(null);
  let libraryName = $state('Home library');
  // Imports from other photo apps (Beta): capture → inspect → accounts and losses → prepare → common import review.
  let photoApps = $state<PhotoAppSource[]>([]),
    photoAppChoice = $state(''),
    photoAppOperation = $state(''),
    photoAppInspection = $state<any>(null),
    photoAppOwners = $state<{ sourceId: string; name: string; assets: number; restrictions: string[]; email: string; acknowledged: boolean }[]>([]),
    photoAppLossesAccepted = $state(false),
    photoAppUntestedAccepted = $state(false),
    photoAppCaptured = $state<PhotoAppSource | null>(null),
    // Ente Photos: the owner exports with Ente's own tool, then points Manager at the folder.
    enteFolder = $state('');
  const ENTE_CHOICE = 'ente-folder';
  let photoAppAwaitingInspect = '';
  let kind = $state<'install' | 'import'>('install'),
    step = $state(0),
    mediaPath = $state(''),
    backupPath = $state(''),
    browsing = $state<'' | 'media' | 'database' | 'backups'>(''),
    databaseRoot = $state(''),
    port = $state(2283),
    ml = $state(false),
    containers = $state(emptyContainers()),
    containersOpen = $state(false),
    containersSaved = $state<Record<string, unknown>>({});
  let lifecycle = $state(false),
    mappingsAccepted = $state(false),
    cutoverAccepted = $state(false),
    restoreAccepted = $state(false);
  let importAdminName = $state(''),
    importAdminEmail = $state(''),
    importAdminPassword = $state('');
  let backupStatus = $state({ configured: false, unlocked: false, keyAvailable: false });
  let recoveryKey = $state(''),
    snapshot = $state(''),
    restoreReview = $state<any>(null),
    /** FL-1320: why the thumbnails folder can't be used, offered as a fallback to the photos folder. */
    // The recovery point whose missing thumbnails folder the administrator chose to replace with the photos folder.
    restoreThumbnailFallback = $state(''),
    updateReview = $state<any>(null);
  let firstName = $state(''),
    lastName = $state(''),
    email = $state(''),
    account = $state('local');
  let logs = $state(''),
    logService = $state(''),
    checks = $state<{ name: string; ok: boolean | null; detail: string }[] | null>(null),
    diagnosing = $state<'' | 'checks' | 'report'>(''),
    theme = $state('dark');
  let page = $state<HTMLElement>(),
    bootstrapped = false,
    previousOperationState = '';
  const requests = new Map<string, string>();
  const apps = [
    {
      name: 'iPhone & iPad',
      label: 'iOS',
      href: 'https://frameleaf.app/apps/iphone/',
      image: '/assets/ios-library-months.avif',
    },
    {
      name: 'Android',
      label: 'Android',
      href: 'https://frameleaf.app/apps/android/',
      image: '/assets/android-library-all.avif',
    },
  ];
  const navigation = [
    {
      title: 'Installation',
      entries: [
        ['welcome', 'plus', 'Set up Frameleaf'],
        ['overview', 'grid', 'Overview'],
        ['services', 'server', 'Services'],
        ['storage', 'drive', 'Storage'],
      ],
    },
    {
      title: 'Protection & maintenance',
      entries: [
        ['backups', 'shield', 'Backups'],
        ['updates', 'update', 'Updates'],
        ['activity', 'activity', 'Activity'],
      ],
    },
    { title: 'Administration', entries: [['settings', 'settings', 'Manager settings']] },
  ];
  const labels: Record<string, string> = {
    welcome: 'Setup',
    import: 'Library import',
    fresh: 'New installation',
    restore: 'Restore backup',
    progress: 'Operation in progress',
    success: 'Server ready',
    profile: 'Your details',
    downloads: 'Get the app',
    phone: 'Library preparation',
    'setup-complete': 'Setup complete',
    'photo-app': 'Import from another app',
    overview: 'Overview',
    services: 'Services',
    storage: 'Storage',
    backups: 'Backups',
    updates: 'Updates',
    activity: 'Activity',
    settings: 'Manager settings',
  };
  const phases: Record<string, string> = {
    'awaiting-account': 'Finish your photo account setup',
    rescanning: 'Rescanning your library',
    verifying: 'Checking your library',
    'needs-attention': 'Review the findings in Library Care',
    complete: 'Library ready',
    unavailable: 'Waiting for Frameleaf',
  };
  const installation = $derived(dashboard?.installation);
  const photoAppChosen = $derived(photoApps.find((app) => app.container === photoAppChoice && app.importable));
  const enteChosen = $derived(photoAppChoice === ENTE_CHOICE);
  const photoAppKind = $derived(
    photoAppInspection?.source?.kind ?? photoAppCaptured?.kind ?? dashboard?.operations?.find(isPhotoAppCapture)?.photoApp?.kind,
  );
  const photoAppFolder = $derived(isFolderImport(photoAppKind));
  const photoAppLabel = $derived(photoAppName(photoAppKind));
  const photoAppProblems = $derived(ownerEmailProblems(photoAppOwners));
  const photoAppReady = $derived(
    !!photoAppInspection &&
      (photoAppInspection.tested || photoAppUntestedAccepted) &&
      (!photoAppInspection.losses.length || photoAppLossesAccepted) &&
      !Object.keys(photoAppProblems).length &&
      photoAppOwners.every((owner) => !owner.restrictions.length || owner.acknowledged),
  );
  const otherInstallations = $derived((dashboard?.installations ?? []).filter((i: any) => !i.current));
  // Manager and app ports sit in pairs (2282/2283); suggest the next free number after every known one.
  const nextManagerPort = $derived(
    Math.max(
      Number(dashboard?.managerOrigin ? new URL(dashboard.managerOrigin).port || 0 : 0),
      installation?.port ?? 0,
      ...(dashboard?.installations ?? []).flatMap((i: any) => [i.appPort ?? 0, i.managerUrl ? Number(new URL(i.managerUrl).port || 0) : 0]),
      2283,
    ) + 1,
  );
  const source = $derived(sources.find((item) => item.id === sourceId));
  const operation = $derived(
    dashboard?.operations?.find((item: any) => item.id === selectedOperation) ?? dashboard?.operations?.[0],
  );
  const activeOperation = $derived(dashboard?.operations?.find((item: any) => item.state !== 'complete'));
  const timeline = $derived(operation ? operationProgress(operation, operation.backupSkipped) : null);
  const running = $derived(
    dashboard?.services?.some((service: any) => service.service === 'frameleaf-server' && service.running),
  );
  const healthy = $derived(
    dashboard?.services?.length > 0 &&
      dashboard.services.every(
        (service: any) => service.running && service.health !== 'unhealthy' && service.health !== 'starting',
      ),
  );
  const importSteps = $derived(
    sourceReview?.backup?.action === 'reuse'
      ? ['Installation', 'Library & settings', 'Checks', 'Import']
      : ['Installation', 'Library & settings', 'Database backup', 'Checks', 'Import'],
  );
  const lastImportStep = $derived(importSteps.length - 1);
  // FL-1317 Check this server: the review's results in the words of this host, with fixes made in place.
  const checkContext = $derived<CheckContext>({
    host: (screen === 'restore' ? restoreReview : review)?.host ?? 'linux',
    folderSetup: !!dashboard?.folderSetup,
    paths: { media: mediaPath, database: databaseRoot, backups: backupPath || dashboard?.backupRoot },
    chosen: screen === 'restore' ? ['database'] : [...(screen === 'fresh' ? (['media'] as const) : []), 'database', 'backups'],
    fixedPort: screen === 'restore',
  });
  const reviewRows = $derived(review?.checks ? checkRows(review.checks, checkContext) : null);
  const restoreRows = $derived(restoreReview?.checks ? checkRows(restoreReview.checks, checkContext) : null);
  let recheckAfterPick: (() => Promise<void>) | null = null;
  // Setup follows the prototype's first-run flow: full-screen, dark, step rail instead of the admin shell.
  // Maintenance on an existing installation (moves, updates, restores) stays in the admin shell.
  const setupMode = $derived(
    !signedIn ||
      (installation
        ? !dashboard?.onboardingFinished &&
          (['success', 'profile', 'downloads', 'phone'].includes(screen) ||
            (screen === 'progress' && ['install', 'import'].includes(operation?.kind)))
        : ['welcome', 'import', 'photo-app', 'fresh', 'restore', 'progress', 'setup-complete'].includes(screen)),
  );
  const photoAppSteps = ['Choose an app', 'Review your library', 'Start import'];
  const onboardingSteps = ['Server ready', 'Your details', 'Get the app', 'Finish setup'];
  const flowSteps = $derived(
    screen === 'import'
      ? importSteps
      : screen === 'photo-app'
        ? photoAppSteps
      : screen === 'fresh'
        ? ['Storage', 'Checks', 'Install']
        : screen === 'restore'
          ? ['Database backup', 'Recovery point', 'Checks', 'Restore']
          : [],
  );
  const chapters = $derived([
    { label: 'Administrator', screens: [] as string[], items: [] as string[], current: -1 },
    { label: 'Choose how to begin', screens: ['welcome'], items: [], current: -1 },
    {
      label: screen === 'import' ? 'Import library' : screen === 'photo-app' ? 'Import from another app' : screen === 'restore' ? 'Restore a backup' : screen === 'fresh' || installation ? 'New library' : 'Set up',
      screens: ['import', 'photo-app', 'fresh', 'restore'],
      items: flowSteps,
      current: step,
    },
    { label: 'Install', screens: ['progress'], items: [], current: -1 },
    {
      label: 'Make it yours',
      screens: ['success', 'profile', 'downloads'],
      items: onboardingSteps.slice(0, 3),
      current: ['success', 'profile', 'downloads'].indexOf(screen),
    },
    { label: 'Finish', screens: ['phone', 'setup-complete'], items: [], current: -1 },
  ]);
  const chapter = $derived(signedIn ? Math.max(1, chapters.findIndex((item) => item.screens.includes(screen))) : 0);
  const availableUpdates = $derived(newerReleases(releases, installation?.release));
  const activeSection = $derived(navSection(screen, !!installation, operation?.kind));
  const latestBackup = $derived(snapshots[0]);
  // Setup follows the machine learning toggle; an installed server follows what it was installed with.
  const containersMl = $derived(installation ? !!installation.ml : ml);
  const containerRows = $derived(
    CONTAINERS.filter((container) => containersMl || container.id !== 'frameleaf-machine-learning')
      .map((container) => ({ ...container, ...parseContainerSettings(containers[container.id]) }))
      .map((parsed) => ({ ...parsed, summary: containerSummary(parsed) }))
      .filter((parsed) => parsed.summary || parsed.errors.length),
  );

  function qrSvg(url: string) {
    const code = encodeQr(url);
    return `<svg class="download-qr" viewBox="0 0 ${code.size + 8} ${code.size + 8}" role="presentation"><rect width="100%" height="100%" fill="white"/><path d="${qrPath(code.modules)}" fill="#101416"/></svg>`;
  }
  function notify(message: string) {
    toast = message;
  }
  async function api(path: string, body?: unknown, signal?: AbortSignal) {
    const response = await fetch(`/manager-api/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, ...(httpSession ? { 'X-Frameleaf-Manager-Session': httpSession } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
    // A proxy or a restarting Manager can answer with an HTML page or nothing: say so plainly.
    // JSON `null` (or any non-object) is no Manager answer either; arrays are, for the endpoints that return one
    const parsed = await response.json().catch(() => null);
    const value = parsed !== null && typeof parsed === 'object' ? parsed : { code: 'manager_unexpected_response' };
    if (!response.ok || value.code === 'manager_unexpected_response') {
      if (response.status === 401 && value.code === 'sign_in_required') {
        signedIn = false;
        dashboard = null;
        csrf = '';
        httpSession = '';
        password = '';
        recoveryKey = '';
        dialog?.close();
      }
      throw Object.assign(new Error(value.code ?? 'request_failed'), { detail: value.detail });
    }
    const session = response.headers.get('X-Frameleaf-Manager-Session');
    if (location.protocol === 'http:' && session && /^[a-f0-9]{64}$/.test(session)) httpSession = session;
    if (value.csrf) csrf = value.csrf;
    return value;
  }
  async function run(work: () => Promise<void>) {
    if (busy) return;
    busy = true;
    error = '';
    // Show a spinner on the button that started this work. run() is always called while its click or
    // submit is dispatching, so window.event is that event. Buttons that draw their own spinner manage aria-busy.
    const trigger = window.event;
    const source = trigger instanceof SubmitEvent ? trigger.submitter : trigger?.target instanceof Element ? trigger.target.closest('button') : null;
    const button = source instanceof HTMLButtonElement && !source.hasAttribute('aria-busy') ? source : null;
    button?.classList.add('working');
    button?.setAttribute('aria-busy', 'true');
    try {
      await work();
    } catch (e) {
      error = e instanceof Error ? readable(e.message, (e as { detail?: string }).detail) : 'Could not complete this request';
    } finally {
      busy = false;
      button?.classList.remove('working');
      button?.removeAttribute('aria-busy');
    }
  }
  async function go(value: string) {
    if (value === 'overview' && location.hash === '#storage') {
      value = 'storage';
      history.replaceState(null, '', location.pathname + location.search);
    }
    // Frameleaf's Add a folder links here so an external folder can be connected.
    if (value === 'overview' && location.hash === '#services' && installation) {
      value = 'services';
      history.replaceState(null, '', location.pathname + location.search);
    }
    if (screen !== value) importAdminPassword = '';
    screen = value;
    menu = false;
    accountMenu = false;
    installMenu = false;
    error = '';
    await tick();
    page?.scrollTo({ top: 0 });
    document.querySelector<HTMLElement>('#main h1')?.focus();
    if (value === 'welcome' && !installation) await Promise.all([loadSources(), loadPhotoApps()]);
    if (value === 'backups') await loadBackups();
    if (value === 'services' && installation) await loadContainerSettings();
    if (value === 'updates') await loadReleases();
    if (['storage', 'overview', 'welcome'].includes(value)) {
      storage = await api('storage');
      if (installation && !backupsLoaded) await loadBackups();
    }
  }
  async function refresh(signal?: AbortSignal) {
    const next = await api('dashboard', undefined, signal);
    dashboard = next;
    disconnected = false;
    if (!bootstrapped) {
      databaseRoot = next.databaseStorage.suggestedPath;
      if (next.folderSetup) { databaseRoot = next.folderSetup.database; mediaPath = next.folderSetup.media; backupPath = next.folderSetup.backups; }
      name = next.administrator?.name ?? '';
      // A detected GPU makes machine learning cheap enough to turn on by default.
      ml = hasGpu(next.host?.acceleration);
      if (next.profile) {
        firstName = next.profile.firstName;
        lastName = next.profile.lastName;
        email = next.profile.email;
        account = next.profile.account;
      }
      bootstrapped = true;
    }
    const latest = next.operations?.[0];
    if (previousOperationState && latest?.state === 'complete' && previousOperationState !== `${latest.id}:complete`) {
      backupsLoaded = false;
      // its own deadline: a slow dashboard answer must not use up the backup request's time
      if (screen === 'backups' || screen === 'overview') await loadBackups(AbortSignal.timeout(30_000));
    }
    previousOperationState = latest ? `${latest.id}:${latest.state}` : '';
  }
  async function loadSources() {
    const result = await api('sources');
    sources = result.sources;
    refused = result.refused;
    discoveryLoaded = true;
    if (sources.length === 1) sourceId = sources[0].id;
  }
  async function loadPhotoApps() {
    // Beta: a Manager without the photo-app routes (or a failed scan) just shows no other apps.
    try {
      photoApps = (await api('photo-app-sources')).sources ?? [];
    } catch (e) {
      if (e instanceof Error && e.message === 'sign_in_required') throw e;
      photoApps = [];
    }
    if (photoAppChoice !== ENTE_CHOICE && !photoApps.some((app) => app.container === photoAppChoice && app.importable))
      photoAppChoice = photoApps.find((app) => app.importable)?.container ?? '';
  }
  function resetPhotoApp() {
    photoAppOperation = '';
    photoAppAwaitingInspect = '';
    photoAppInspection = null;
    photoAppOwners = [];
    photoAppLossesAccepted = false;
    photoAppUntestedAccepted = false;
  }
  async function capturePhotoApp() {
    const chosen = photoAppChosen;
    if (!chosen) return;
    resetPhotoApp();
    photoAppCaptured = chosen;
    await start('photo-app-capture', { container: chosen.container });
    photoAppOperation = photoAppAwaitingInspect = selectedOperation;
  }
  async function startEnteFolder() {
    const path = enteFolder.trim();
    if (!path) return;
    resetPhotoApp();
    photoAppCaptured = { container: '', kind: 'ente', name: 'Ente Photos', version: null, database: 'export', importable: true };
    await start('photo-app-folder', { kind: 'ente', path });
    photoAppOperation = photoAppAwaitingInspect = selectedOperation;
  }
  async function copyCommand(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      notify('Command copied.');
    } catch {
      notify('Select the command and copy it.');
    }
  }
  async function inspectPhotoApp(id: string) {
    photoAppAwaitingInspect = '';
    const inspection = await api('photo-app-inspect', { operationId: id });
    photoAppOperation = id;
    photoAppInspection = inspection;
    photoAppOwners = inspection.owners.map((owner: any) => ({ ...owner, email: owner.email ?? '', acknowledged: false }));
    photoAppLossesAccepted = false;
    photoAppUntestedAccepted = !!inspection.tested;
    // The same storage, port and release choices as an Immich import, starting fresh for this library.
    kind = 'import';
    port = !otherInstallations.some((i: any) => i.appPort === 2283) ? 2283 : (dashboard?.suggestedPort ?? 2283);
    review = null;
    containers = emptyContainers();
    containersOpen = false;
    lifecycle = false;
    cutoverAccepted = false;
    importAdminName = importAdminEmail = importAdminPassword = '';
    if (!releasesLoaded) await loadReleases();
    if (!releases.some((release) => release.tag === tag)) tag = releases[0]?.tag ?? '';
    step = 1;
    await go('photo-app');
  }
  async function preparePhotoApp() {
    if (!photoAppReady) return;
    if (!document.querySelector<HTMLFormElement>('#configuration-form')?.reportValidity()) return;
    const overrides = containerOverrides(containers, containersMl);
    if (overrides.invalid) {
      containersOpen = true;
      throw new Error('container_settings_invalid');
    }
    checking = true;
    try {
      review = await api('photo-app-prepare', {
        operationId: photoAppOperation,
        owners: photoAppOwners.map((owner) => ({
          sourceId: owner.sourceId,
          email: owner.email.trim(),
          ...(owner.restrictions.length ? { acknowledgeRestrictions: owner.acknowledged } : {}),
        })),
        approvedLossCodes: photoAppInspection.losses.map((loss: { code: string }) => loss.code),
        review: {
          tag,
          databaseRoot,
          mediaPath,
          ...(dashboard.folderSetup ? { backupPath } : {}),
          port,
          ml,
          name: libraryName,
          ...(Object.keys(overrides.services).length ? { services: overrides.services } : {}),
        },
      });
    } finally {
      checking = false;
    }
    cutoverAccepted = false;
    step = 2;
    await tick();
    page?.scrollTo({ top: 0 });
  }
  async function cancelPhotoApp(id: string) {
    const app = photoAppLabel;
    const folder = photoAppFolder;
    await api('photo-app-cancel', { operationId: id });
    resetPhotoApp();
    review = null;
    closeModal();
    await refresh();
    await go(installation ? 'overview' : 'welcome');
    notify(folder ? 'Import cancelled. Your export folder is unchanged.' : `Import cancelled. ${app === 'your photo app' ? 'Your photo app' : app} is starting again.`);
  }
  async function loadReleases() {
    releases = await api('releases');
    releasesLoaded = true;
  }
  async function loadBackups(signal?: AbortSignal) {
    const result = await api('backup-status', undefined, signal);
    backupStatus = result;
    snapshots = result.snapshots;
    backupsLoaded = true;
  }
  async function signIn() {
    await api(claimed ? 'login' : 'claim', claimed ? { password } : { password, name });
    password = '';
    claimed = true;
    signedIn = true;
    await refresh();
    await go(activeOperation ? 'progress' : installation ? 'overview' : 'welcome');
  }
  async function signOut() {
    await api('logout', {});
    httpSession = '';
    signedIn = false;
    dashboard = null;
    csrf = '';
    password = '';
    importAdminPassword = '';
    recoveryKey = '';
    logs = '';
    accountMenu = false;
    installMenu = false;
    bootstrapped = false;
    requests.clear();
  }
  async function choose(value: 'install' | 'import') {
    kind = value;
    // An import keeps Immich's usual port (Immich stops first) unless another Frameleaf library already has it.
    port = value === 'import' && !otherInstallations.some((i: any) => i.appPort === 2283) ? 2283 : (dashboard?.suggestedPort ?? 2283);
    step = 0;
    review = null;
    containers = emptyContainers();
    containersOpen = false;
    sourceReview = null;
    mappingsAccepted = false;
    lifecycle = false;
    cutoverAccepted = false;
    importAdminName = importAdminEmail = importAdminPassword = '';
    await refresh();
    await loadReleases();
    tag = releases[0]?.tag ?? '';
    if (value === 'import') await loadSources();
    await go(value === 'install' ? 'fresh' : 'import');
  }
  async function inspectSource() {
    sourceReview = await api('source-review', { sourceId });
    sources = sources.map((item) => (item.id === sourceId ? sourceReview.source : item));
    advancedOpen = sourceReview.source.unsupportedSettings.length > 0;
    step = 1;
  }
  function applySourceSettings(result: any) {
    advancedSettings = JSON.stringify(result.settings, null, 2);
    sourceReview = { ...sourceReview, source: result.source };
    sources = sources.map((item) => (item.id === sourceId ? result.source : item));
  }
  async function loadSourceSettings() {
    applySourceSettings(await api('source-settings', { sourceId }));
  }
  async function saveSourceSettings(reset = false) {
    let settings: unknown = null;
    if (!reset) {
      try {
        settings = JSON.parse(advancedSettings);
      } catch {
        throw new Error('settings_not_json');
      }
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('settings_not_json');
    }
    applySourceSettings(await api('source-settings', { sourceId, settings }));
    notify(reset ? 'Using the settings from your original installation' : 'Settings saved for this import');
  }
  async function prepare() {
    const form = document.querySelector<HTMLFormElement>('#configuration-form');
    if (form && !form.reportValidity()) return;
    const overrides = containerOverrides(containers, containersMl);
    if (overrides.invalid) {
      containersOpen = true;
      throw new Error('container_settings_invalid');
    }
    checking = true;
    try {
      review = await api('review', {
        kind,
        tag,
        name: libraryName,
        ...(kind === 'import' ? { sourceId } : { mediaPath }),
        ...(dashboard.folderSetup ? { backupPath } : {}),
        databaseRoot,
        port,
        ml,
        lifecycle: 'docker-only',
        ...(Object.keys(overrides.services).length ? { services: overrides.services } : {}),
      });
    } finally {
      checking = false;
    }
  }
  /** Moves to the Checks step and runs every check; a refusal before the checks returns to the step before. */
  async function checkServer(at: number, work: () => Promise<void>) {
    // A restore sends no configuration or container settings: leftovers from Services never block it.
    if (screen !== 'restore' && !configurationReady()) return;
    if (screen === 'restore') restoreReview = null;
    else review = null;
    // A recheck starts on the Checks step itself: if it can't finish, go back to the step before it, not a screen with no results.
    const before = step === at ? at - 1 : step;
    step = at;
    await tick();
    page?.scrollTo({ top: 0 });
    document.querySelector<HTMLElement>('#main h1')?.focus();
    try {
      await work();
    } catch (e) {
      step = before;
      throw e;
    }
    if (!(screen === 'restore' ? restoreReview : review)) step = before;
    await tick();
    document.querySelector<HTMLElement>('#main h1')?.focus();
  }
  const recheckInstall = () => checkServer(kind === 'install' ? 1 : lastImportStep - 1, prepare);
  const recheckRestore = () => checkServer(2, prepareRestore);
  function checkAction(action: CheckAction, recheck: () => Promise<void>) {
    if (action.kind === 'folder') {
      recheckAfterPick = recheck;
      browsing = action.folder;
      return;
    }
    if (action.kind === 'thumbnails') restoreThumbnailFallback = snapshot;
    else if (action.kind === 'port') port = action.port;
    else if (action.kind === 'ml') ml = false;
    void run(recheck);
  }
  /** Leaving the configuration on an import's library step: the same browser checks the review would run. */
  function configurationReady() {
    const form = document.querySelector<HTMLFormElement>('#configuration-form');
    if (form && !form.reportValidity()) return false;
    if (containerOverrides(containers, containersMl).invalid) {
      containersOpen = true;
      error = readable('container_settings_invalid');
      return false;
    }
    return true;
  }
  async function start(
    path: string,
    body: Record<string, unknown>,
    bootstrap?: { name: string; email: string; password: string },
  ) {
    const identity = JSON.stringify([path, body]);
    let key = requests.get(identity);
    if (!key) {
      key = requestKey();
      requests.set(identity, key);
    }
    const result = await api(path, { ...body, key, ...(bootstrap && { bootstrap }) });
    requests.delete(identity);
    selectedOperation = result.id;
    await refresh();
    await go('progress');
    dialog?.close();
  }
  async function startCommonImport() {
    try {
      await start('install', { reviewId: review.id, approvalToken: review.approvalToken }, review.commonImport.requiresBootstrap
        ? { name: importAdminName, email: importAdminEmail, password: importAdminPassword }
        : undefined);
    } finally {
      importAdminPassword = '';
    }
  }
  async function resumeCommonImport(id: string) {
    try {
      await api('resume', {
        id,
        bootstrap: { name: importAdminName, email: importAdminEmail, password: importAdminPassword },
      });
      await refresh();
    } finally {
      importAdminPassword = '';
    }
  }
  async function control(action: string) {
    await start('control', { action });
  }
  async function loadContainerSettings() {
    containersSaved = (await api('container-settings')).services ?? {};
    containers = containerText(containersSaved);
    containersOpen = false;
  }
  async function saveContainerSettings() {
    const overrides = containerOverrides(containers, containersMl);
    if (overrides.invalid) {
      containersOpen = true;
      throw new Error('container_settings_invalid');
    }
    // Machine learning off hides its settings; saving must not discard what was stored for it.
    const kept = !containersMl && containersSaved['frameleaf-machine-learning'] ? { 'frameleaf-machine-learning': containersSaved['frameleaf-machine-learning'] } : {};
    await start('container-settings', { services: { ...kept, ...overrides.services } });
  }
  async function saveProfile() {
    await api('profile', { firstName, lastName, email, account });
    await refresh();
    await go('downloads');
  }
  async function startRestore(id = '') {
    snapshot = id;
    step = 0;
    restoreAccepted = false;
    restoreReview = null;
    restoreThumbnailFallback = '';
    await loadBackups();
    await go('restore');
  }
  async function unlockBackups() {
    try {
      await api('unlock-backups', { key: recoveryKey });
      await loadBackups();
      step = 1;
    } finally {
      recoveryKey = '';
    }
  }
  async function prepareRestore() {
    // FL-1320: with the thumbnails drive gone, the administrator may keep thumbnails in the photos folder (a check fix).
    restoreReview = await api('review-restore', { snapshot, databaseRoot, ...(restoreThumbnailFallback && restoreThumbnailFallback === snapshot ? { thumbnailFallback: true } : {}) });
  }
  async function showModal(value: string, action = '') {
    modal = value;
    modalAction = action;
    password = '';
    newPassword = '';
    accountMenu = false;
    await tick();
    dialog.showModal();
  }
  function closeModal() {
    dialog.close();
    password = '';
    newPassword = '';
    modal = '';
  }
  async function download(path: string, filename: string, body: unknown, done = 'Download complete. Keep recovery files private.') {
    const response = await fetch(`/manager-api/${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, ...(httpSession ? { 'X-Frameleaf-Manager-Session': httpSession } : {}) },
      body: JSON.stringify(body),
    });
    // A proxy or a restarting Manager can answer with an HTML page: same plain message as api().
    if (!response.ok) throw new Error((await response.json().catch(() => null))?.code ?? 'manager_unexpected_response');
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    closeModal();
    notify(done);
  }
  function downloadLogs() {
    const url = URL.createObjectURL(new Blob([logs], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'frameleaf-manager-logs.txt';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function showLogs(id: string) {
    logService = id;
    logs = (await api('logs', { id })).logs;
  }
  async function updateAdministrator() {
    await api('administrator', { name, password, ...(newPassword ? { newPassword } : {}) });
    password = '';
    newPassword = '';
    await refresh();
    closeModal();
    notify('Administrator updated. Previous sessions were signed out.');
  }
  async function credentialAction() {
    try {
      if (modal === 'administrator') await updateAdministrator();
      else
        await download(
          modal === 'export' ? 'export' : 'backup-key',
          modal === 'export' ? 'frameleaf-manager-recovery.json' : 'frameleaf-manager-recovery-key.txt',
          { password },
        );
    } finally {
      password = '';
      newPassword = '';
    }
  }
  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(dashboard.appUrl);
      notify('Server address copied.');
    } catch {
      notify('Copy the server address shown here.');
    }
  }
  onMount(() => {
    try {
      theme = localStorage.getItem('frameleaf-manager-theme') === 'light' ? 'light' : 'dark';
    } catch {}
    void run(async () => {
      const status = await api('status');
      claimed = status.claimed;
      claimProofRequired = status.claimProofRequired === true;
      if (claimProofRequired) return;
      try {
        await refresh();
        signedIn = true;
        await go(activeOperation ? 'progress' : installation ? 'overview' : 'welcome');
      } catch (e) {
        if (!(e instanceof Error && e.message === 'sign_in_required')) throw e;
      }
    }).finally(() => (loading = false));
    // A slow Docker host can take longer than one interval to answer: never stack dashboard requests,
    // and give up on one that never answers so polling resumes once the connection is back.
    let polling = false;
    const timer = setInterval(() => {
      if (signedIn && !document.hidden && !busy && !polling) {
        polling = true;
        void refresh(AbortSignal.timeout(30_000))
          .then(() => {
            if (!photoAppAwaitingInspect || screen !== 'progress') return;
            const captured = dashboard?.operations?.find((item: any) => item.id === photoAppAwaitingInspect);
            if (captured?.state === 'awaiting-review') void run(() => inspectPhotoApp(captured.id));
            else if (!captured || captured.state !== 'running') photoAppAwaitingInspect = '';
          })
          .catch(() => {
            disconnected = true;
            if (!signedIn) error = 'Your session expired. Sign in to continue.';
          })
          .finally(() => (polling = false));
      }
    }, 10_000);
    return () => clearInterval(timer);
  });
  $effect(() => {
    // ponytail: setup is always dark, like the prototype's first-run stage; the saved choice returns afterwards.
    document.documentElement.dataset.theme = setupMode ? 'dark' : theme;
    try {
      localStorage.setItem('frameleaf-manager-theme', theme);
    } catch {}
  });
</script>

{#snippet heading(title: string, subtitle: string)}
  <div class="page-heading"><div class="spread"><h1 tabindex="-1">{title}</h1></div><p>{subtitle}</p></div>
{/snippet}
{#snippet steps(items: string[], current: number)}
  {#if setupMode}<p class="setup-eyebrow">{chapters[chapter].label} · Step {current + 1} of {items.length}</p>{:else}<ol class="steps" aria-label="Setup progress">{#each items as item, index}<li class:active={index === current} class:complete={index < current} aria-current={index === current ? 'step' : undefined}><span class="step-number">{#if index < current}<Icon name="check" />{:else}{index + 1}{/if}</span><span>{item}</span></li>{/each}</ol>{/if}
{/snippet}
{#snippet checksStep(rows: CheckRow[] | null, order: string[], back: () => void, next: () => void, nextLabel: string, recheck: () => Promise<void>)}
  {@const summary = rows ? checkSummary(rows, screen === 'restore' ? 'restore' : screen === 'import' ? 'import' : 'install') : null}
  {@render heading(summary?.title ?? CHECKING.title, summary?.lead ?? CHECKING.lead)}
  <ServerCheck {rows} {order} {busy} onaction={(action) => checkAction(action, recheck)} onreport={() => run(() => download('diagnostics-report', `frameleaf-troubleshooting-${new Date().toISOString().slice(0, 10)}.txt`, {}, 'Report downloaded. Read it before you post it.'))} />
  <div class="wizard-footer"><button class="button quiet" disabled={!rows} onclick={back}><Icon name="back"/>Back</button>{#if !rows}<button class="button primary" disabled aria-busy="true"><span class="spinner" aria-hidden="true"></span>Checking…</button>{:else if summary?.problems}<button class="button primary" disabled={busy} onclick={() => run(recheck)}>Check again<Icon name="refresh"/></button>{:else}<button class="button primary" onclick={next}>{nextLabel}<Icon name="arrow"/></button>{/if}</div>
{/snippet}
{#snippet notice(title: string, detail: string, type = 'good', icon = 'shield')}
  <div class="notice {type}"><Icon name={icon}/><div class="grow"><strong>{title}</strong><p>{detail}</p></div></div>
{/snippet}
{#snippet importAdministratorFields()}
  <div class="form-grid mt16">
                      <label class="field"><span>Name</span><input bind:value={importAdminName} autocomplete="name" required maxlength="200"/></label>
                      <label class="field"><span>Email</span><input type="email" bind:value={importAdminEmail} autocomplete="email" required maxlength="254"/></label>
                      <label class="field full"><span>Password</span><input type="password" bind:value={importAdminPassword} autocomplete="new-password" required minlength="8" maxlength="72"/></label>
                    </div>
{/snippet}
{#snippet mappings(items: any[])}
  <div class="table-wrap"><table><thead><tr><th>Source location</th><th>Inside container</th><th>Access</th></tr></thead><tbody>{#each items as mount}<tr><td class="mapping-source"><strong><code>{mount.source}</code></strong><small>{mount.type === 'volume' ? 'Named volume' : 'Bind mount'}</small></td><td><code>{mount.target}</code></td><td><span class="badge">{mount.readOnly ? 'Read only' : 'Read & write'}</span></td></tr>{/each}</tbody></table></div>
{/snippet}
{#snippet regeneration()}
  {#if dashboard?.librarySetup?.regeneration}
    {@const progress = regenerationPresentation(dashboard.librarySetup.regeneration)}
    <section class="card mt16" aria-live="polite"><div class="card-header"><h2>{progress.label}</h2><span class="badge" class:warning={progress.attention}>Background work</span></div><div class="card-body"><p>{progress.detail}</p><p class="meta">Regeneration continues in the background. Finishing setup does not mark this work complete.</p>{#if progress.attention}<a href={dashboard.appUrl + '/utilities'} target="_blank" rel="noreferrer">Review background activity in Frameleaf ↗</a>{/if}</div></section>
  {/if}
{/snippet}
{#snippet services()}
  {#each dashboard?.services ?? [] as service}<div class="list-row"><Icon name={service.service === 'database' ? 'database' : service.service.includes('learning') ? 'cpu' : 'server'}/><div><strong>{service.service === 'frameleaf-server' ? 'Frameleaf server' : service.service === 'database' ? 'PostgreSQL' : service.service.includes('learning') ? 'Machine learning' : service.service}</strong><p>{service.service === 'database' ? 'Dedicated database on your host disk' : service.service.includes('learning') ? 'Local processing' : installation.release}</p></div><span class="badge" class:good={service.running && service.health === 'healthy'} class:warning={service.health === 'unhealthy'}>{serviceState(service)}</span>{#if screen === 'services'}<button class="button quiet" disabled={busy} onclick={() => run(() => showLogs(service.id))}>Logs</button>{/if}</div>{/each}
  {#if !installation?.ml}<div class="list-row"><Icon name="cpu"/><div><strong>Machine learning</strong><p>Optional processing was not enabled for this installation.</p></div><span class="badge">Off</span></div>{/if}
  {#if !dashboard?.services?.length}<div class="card-body"><p class="muted">No managed containers are visible. Review service availability before starting the stack.</p></div>{/if}
{/snippet}

<svelte:head><title>{installation?.name ? installation.name + ' · ' : ''}Frameleaf Manager · {!signedIn ? 'Local administrator' : labels[screen]}</title><meta name="theme-color" content={theme === 'dark' ? '#101416' : '#f4f6f7'}/></svelte:head>
<a class="skip-link" href="#main">Skip to content</a>
{#if setupMode}
<div class="setup-shell" class:setup-stage={!signedIn || loading}>
  {#if signedIn && !loading}
    <aside class="setup-rail" aria-label="Setup progress">
      <img class="setup-rail-logo" src="/assets/frameleaf-logo-white.svg" alt="Frameleaf"/>
      <p class="setup-rail-meta"><span class="status-dot" class:offline={disconnected}></span>{dashboard?.host?.name ?? 'This server'} · Manager</p>
      <ol style="--setup-progress: {chapter / (chapters.length - 1)}">{#each chapters as item, index}<li data-status={index < chapter ? 'done' : index === chapter ? 'current' : 'next'} aria-current={index === chapter ? 'step' : undefined}>{#if index === 1 && chapter > 1 && !installation && !activeOperation}<button class="setup-rail-row" disabled={busy} onclick={() => run(() => go('welcome'))}><span class="setup-rail-dot"><Icon name="check"/></span>{item.label}</button>{:else}<span class="setup-rail-row"><span class="setup-rail-dot">{#if index < chapter}<Icon name="check"/>{:else}{index + 1}{/if}</span>{item.label}</span>{/if}{#if index === chapter && item.items.length}<ul>{#each item.items as sub, subIndex}<li class:done={subIndex < item.current} aria-current={subIndex === item.current ? 'step' : undefined}>{sub}</li>{/each}</ul>{/if}</li>{/each}</ol>
      <div class="setup-rail-foot">
        <button class="text-button" disabled={busy} onclick={() => run(async () => { await refresh(); await go(screen); })} aria-label="Refresh Manager"><Icon name="update"/>Refresh</button>
        <button class="text-button" onclick={() => showModal('help')}><Icon name="help"/>Manager guide</button>
        <button class="text-button" disabled={busy} onclick={() => run(() => go('settings'))}><Icon name="settings"/>Manager settings</button>
        {#if installation}<button class="text-button" disabled={busy} onclick={() => run(() => go('overview'))}><Icon name="grid"/>Open Manager overview</button>{/if}
        <button class="text-button" disabled={busy} onclick={() => run(signOut)}><Icon name="user"/>Sign out</button>
      </div>
    </aside>
  {/if}
  <div class="setup-scroll" bind:this={page}><main id="main" class="setup-main" aria-busy={busy}>
    {#if !signedIn || loading}<div class="setup-hero"><span class="setup-hero-mark"><span class="setup-hero-glow" aria-hidden="true"></span><img src="/assets/frameleaf-symbol.svg" alt=""/></span><span class="setup-hero-wordmark" role="img" aria-label="Frameleaf"><img src="/assets/frameleaf-logo-white.svg" alt=""/></span><p>Your photos, beautifully kept. On your own server.</p></div>{/if}
    {@render body()}
  </main></div>
</div>
{:else}
<div class="shell" class:menu-open={menu} class:onboarding-layout={['profile', 'downloads', 'phone', 'setup-complete'].includes(screen)}>
  <header class="topbar"><button class="button quiet icon-button mobile-menu" onclick={() => menu = !menu} aria-label="Toggle navigation" aria-expanded={menu}><Icon name="menu"/></button>
    <button class="brand" onclick={() => signedIn && run(() => go(installation ? 'overview' : 'welcome'))} aria-label="Frameleaf Manager home"><img class="brand-dark" src="/assets/frameleaf-logo-white.svg" alt="Frameleaf"/><img class="brand-light" src="/assets/frameleaf-logo-light.svg" alt="Frameleaf"/><span class="brand-divider"></span><span class="brand-label">Manager</span></button>
    <span class="live-pill">Local management</span><div class="topbar-right"><button class="button quiet icon-button" onclick={() => theme = theme === 'dark' ? 'light' : 'dark'} aria-label="Toggle light or dark theme"><Icon name={theme === 'dark' ? 'sun' : 'moon'}/></button>
    {#if signedIn}<button class="row" onclick={() => accountMenu = !accountMenu} aria-label="Local administrator menu" aria-expanded={accountMenu}><span class="avatar"><Icon name="user"/></span><span class="local-account">{dashboard?.administrator?.name ?? 'Local admin'}</span></button>{/if}</div>
    {#if accountMenu}<div class="account-menu"><button onclick={() => run(() => go('settings'))}>Manager settings</button><button onclick={() => run(signOut)}>Sign out</button></div>{/if}
  </header>
  <div class="workspace"><button class="mobile-shade" onclick={() => menu = false} aria-label="Close navigation"></button>
    <aside class="sidebar"><div class="install-switch"><button class="server-select" disabled={!signedIn} onclick={() => installMenu = !installMenu} aria-expanded={installMenu} aria-haspopup="menu" aria-label="Switch installation"><Icon name="server"/><div><strong>{installation?.name ?? dashboard?.host?.name ?? 'This server'}</strong><small>{installation ? `${dashboard?.host?.name ?? 'This server'} · ` : ''}{dashboard?.host?.platform ?? 'Local Docker'}</small></div><Icon name="chevron"/></button>
      {#if installMenu}<div class="install-menu" role="menu" aria-label="Frameleaf installations"><p class="nav-caption">On {dashboard?.host?.name ?? 'this server'}</p>
        {#each otherInstallations.length || installation ? [{ name: installation?.name ?? 'This Manager', current: true, appPort: installation?.port }, ...otherInstallations] : [] as item}{#if item.current}<span class="install-item current" role="menuitem" aria-current="true"><Icon name="check"/><span><strong>{item.name}</strong><small>This Manager</small></span></span>{:else}<a class="install-item" role="menuitem" href={item.managerUrl} target="_blank" rel="noopener"><Icon name="server"/><span><strong>{item.name}</strong><small>{item.running ? 'Running' : 'Stopped'}{item.appPort ? ` · port ${item.appPort}` : ''}</small></span><Icon name="arrow"/></a>{/if}{/each}
        <button class="install-item" role="menuitem" onclick={() => { installMenu = false; void showModal('add-installation'); }}><Icon name="plus"/><span><strong>Add installation</strong><small>Its own Manager and library</small></span></button></div>{/if}</div>
      <nav aria-label="Manager">{#each navigation as group}<p class="nav-caption" class:separated={group.title !== 'Installation'}>{group.title}</p>{#each group.entries as [value, icon, label]}<button class="nav-item" class:active={activeSection === value} disabled={!signedIn || busy} aria-current={activeSection === value ? 'page' : undefined} onclick={() => run(() => go(value))}><Icon name={icon}/><span>{label}</span>{#if value === 'updates' && releasesLoaded && availableUpdates.length}<span class="nav-badge">{availableUpdates.length}</span>{/if}</button>{/each}{/each}</nav>
      <div class="sidebar-bottom"><button class="button quiet" onclick={() => showModal('help')}><Icon name="help"/>Manager guide</button><div class="server-foot"><span class="status-dot" class:offline={disconnected}></span>{dashboard?.host?.available === false ? 'Docker unavailable' : signedIn ? 'Local Manager connected' : 'Local management'}<p>Protected session · {location.protocol === 'https:' ? 'HTTPS' : 'HTTP'}</p></div></div>
    </aside>
    <div class="page-area"><div class="contextbar"><span>Manager</span><Icon name="chevron"/><strong>{!signedIn ? 'Local administrator' : labels[screen]}</strong><div class="context-actions">{#if signedIn}<button class="button quiet icon-button" disabled={busy} onclick={() => run(async () => { await refresh(); await go(screen); })} aria-label="Refresh Manager"><Icon name="update"/></button>{/if}</div></div>
      <div class="page-scroll" bind:this={page}><main id="main" class="page" aria-busy={busy}>
        {@render body()}
      </main></div>
    </div>
    <aside class="inspector" aria-label="Context and installation details">
      {#if screen === 'import' && source}<section class="inspector-section"><h2>Import summary</h2><dl class="definition"><div><dt>Source</dt><dd>{source.project ?? 'Selected installation'}</dd></div><div><dt>Version</dt><dd>{source.product} {source.version}</dd></div><div><dt>Photos & videos</dt><dd>{source.summary.assets.toLocaleString()}</dd></div><div><dt>Users</dt><dd>{source.summary.users}</dd></div><div><dt>Albums</dt><dd>{source.summary.albums}</dd></div></dl></section><section class="inspector-section"><h3>What stays in place</h3><p>Your media and external libraries keep the same paths and access modes. The original database is retained separately.</p></section>
      {:else if installation}<section class="inspector-section"><h2>Your library</h2><dl class="definition"><div><dt>Frameleaf</dt><dd>{installation.release}</dd></div><div><dt>Status</dt><dd class:green={running}>{running ? 'Running' : 'Stopped'}</dd></div><div><dt>Project</dt><dd>{installation.project}</dd></div><div><dt>Owner</dt><dd>Manager</dd></div></dl></section><section class="inspector-section"><h3>Database recovery</h3><p>Database backups exclude media. Required files must already exist to restore file access.</p><ul class="checklist"><li><Icon name="check"/>Encrypted database checkpoints</li><li><Icon name="check"/>Existing media reused</li></ul></section>
      {:else}<section class="inspector-section"><div class="spread"><h2>This server</h2><Icon name="server"/></div><dl class="definition"><div><dt>Host</dt><dd>{dashboard?.host?.name ?? location.hostname}</dd></div><div><dt>Platform</dt><dd>{dashboard?.host?.platform ?? 'Waiting for sign-in'}</dd></div><div><dt>Docker</dt><dd>{dashboard?.host?.version ?? 'Not checked'}</dd></div><div><dt>Memory</dt><dd>{formatBytes(dashboard?.host?.memory)}</dd></div><div><dt>Processor</dt><dd>{dashboard?.host?.processors ? dashboard.host.processors + ' cores' : 'Unavailable'}</dd></div></dl></section>{/if}
      <section class="inspector-section"><h3>Manager is independent</h3><p>Your photo library keeps running if Manager stops. Maintenance and recovery stay available when the photo application is offline.</p></section><section class="inspector-section"><h3>Made for your server</h3><ul class="checklist"><li><Icon name="check"/>Your media stays on your server</li><li><Icon name="check"/>No Cloud account required</li><li><Icon name="check"/>You choose when to update</li></ul></section><div class="inspector-note"><Icon name="lock"/><p>Manager has its own local administrator account.</p></div>
    </aside>
  </div>
</div>

{/if}

{#snippet body()}
        {#if error}<div class="notice warning error-notice" role="alert"><Icon name="warning"/><div><strong>Action needed</strong><p>{error}</p></div></div>{/if}
        {#if disconnected}{@render notice('Connection interrupted', 'Manager could not refresh the server state. Reconnect and refresh before taking another action.', 'warning', 'network')}{/if}
        {#if loading}<div class="loading-state"><Icon name="loader" class="spin"/><p>Connecting to your Manager…</p></div>
        {:else if claimProofRequired}
          {@render heading('Finish setup in Frameleaf Desktop', 'Open Frameleaf Desktop to create the local administrator account for this Manager.')}
        {:else if !signedIn}
          {@render heading(claimed ? 'Welcome back.' : 'Secure your Manager', claimed ? 'Sign in to manage this Frameleaf installation.' : 'Create the local administrator account used to manage this server.')}
          <form class="card" onsubmit={(event) => { event.preventDefault(); void run(signIn); }}><div class="card-header"><h2>Local administrator</h2></div><div class="card-body stack">
            {#if !claimed}<label class="field"><span>Administrator name</span><input bind:value={name} required maxlength="120" autocomplete="name"/></label>{/if}
            <label class="field"><span>Password</span><input type="password" bind:value={password} required minlength={claimed ? 1 : 14} maxlength="256" autocomplete={claimed ? 'current-password' : 'new-password'}/><small>{claimed ? 'Your Manager account is independent of your photo account.' : 'Use at least 14 characters. No Frameleaf Cloud account is required.'}</small></label>
            {@render notice('Local management and a separate account', 'Manager stays available when the photo application is stopped.', 'good', 'lock')}
            {#if location.protocol === 'http:'}{@render notice('Unencrypted connection', 'HTTP sends your password and management traffic without encryption. Sign in only on a network you trust.', 'warning', 'warning')}{/if}
          </div><div class="card-footer"><span class="safety-note"><Icon name="shield"/>Protected local session</span><button class="button primary" disabled={busy}>{claimed ? 'Sign in' : 'Create administrator'}</button></div></form>
        {:else if activeOperation && !['progress', 'activity', 'photo-app'].includes(screen)}
          <div class="notice warning operation-banner"><Icon name="clock"/><div class="grow"><strong>{operationNames[activeOperation.kind]}</strong><p>{activeOperation.state === 'running' ? 'Running in the background' : 'A saved operation needs attention before another operation can begin.'}</p></div><button class="button quiet" onclick={() => { selectedOperation = activeOperation.id; void run(() => go('progress')); }}>View operation</button></div>
        {/if}

        {#if !loading && signedIn}
        {#if screen === 'welcome'}
          {@render heading('Choose how to begin', 'Set up and look after Frameleaf from one place.')}
          {#if installation}{@render notice('Frameleaf is already installed', 'Manage this installation from Overview, or review a database recovery point in Backups.')}
            <div class="actions mt16"><button class="button primary" onclick={() => run(() => go('overview'))}>Open overview</button><button class="button quiet" onclick={() => run(() => go('backups'))}>View backups</button></div>
          {:else}
            {#if sources.length}<section class="card detected-card"><div class="card-body"><div class="detected-label"><Icon name="check"/>FOUND ON THIS SERVER</div><div class="feature-row"><div class="import-art" aria-hidden="true"><span class="import-art-node"><Icon name="database"/></span><span class="import-art-flow"><i></i><i></i><i></i></span><span class="import-art-node target"><img src="/assets/frameleaf-symbol.svg" alt=""/></span></div><div class="feature-copy"><h2>Bring your photo library</h2><p>Import your accounts, albums, and settings. Keep your photos and external libraries exactly where they are.</p></div><span class="badge">{sources.length === 1 ? sources[0].product + ' ' + sources[0].version : sources.length + ' installations'}</span></div>{#if sources.length === 1}<div class="mini-stats"><div><strong>{sources[0].summary.assets.toLocaleString()}</strong><small>Photos & videos</small></div><div><strong>{sources[0].summary.users}</strong><small>{sources[0].summary.users === 1 ? 'Account' : 'Accounts'}</small></div><div><strong>{sources[0].summary.albums}</strong><small>Albums</small></div><div><strong>{sources[0].mounts.filter((item: any) => item.readOnly).length}</strong><small>Read-only mappings</small></div></div>{/if}</div><div class="card-footer"><span class="safety-note"><Icon name="folder"/>Existing media locations preserved</span><button class="button primary" disabled={busy || !!activeOperation} onclick={() => run(() => choose('import'))}>Review import</button></div></section>
            {:else if !photoApps.length}<section class="card"><div class="card-body"><div class="row mb16"><Icon name="import"/><h2>{discoveryLoaded ? 'No supported photo installation found' : 'Find your existing library'}</h2></div><p class="muted">Manager detects installations through the host Docker engine. Review discovered sources before making any change.</p><button class="button quiet mt16" disabled={busy} onclick={() => run(loadSources)}>Find installations</button></div></section>{/if}
            {#if refused.length}<div class="notice warning mt16"><Icon name="warning"/><div><strong>Some installations need attention</strong>{#each refused as item}<p>{readable(item.code)}</p>{/each}</div></div>{/if}
            {@render photoAppPicker()}
            <p class="section-label">Or start another way</p><div class="two-cols"><section class="card option-card"><div class="card-body"><div class="icon-tile"><Icon name="plus"/></div><h2>Set up a new library</h2><p>Choose your storage and let Manager prepare a fresh Frameleaf installation.</p><button class="text-button" disabled={busy || !!activeOperation} onclick={() => run(() => choose('install'))}>Set up Frameleaf</button></div></section><section class="card option-card"><div class="card-body"><div class="icon-tile"><Icon name="restore"/></div><h2>Restore a backup</h2><p>Restore your database and reconnect media that already exists on your server.</p><button class="text-button" disabled={busy || !!activeOperation} onclick={() => run(() => startRestore())}>Choose a backup</button></div></section></div>
            <p class="quiet-note"><Icon name="info"/>You can review every change before setup or import begins.</p>
          {/if}
        {:else if screen === 'import'}
          {@render steps(importSteps, step)}
          {#if review?.commonImport}
            {@render commonImportReview(() => { review = null; step = 0; importAdminPassword = ''; })}
          {:else if step === 0}
            {@render heading(sources.length > 1 ? 'Choose a photo installation' : `Review your ${source?.product ?? 'photo'} installation`, 'Your existing database will be kept for recovery.')}
            {#if !sources.length}{@render notice('No supported source available', 'Find and resolve the source installation before starting an import.', 'warning')}<button class="button quiet mt16" onclick={() => run(loadSources)}>Find installations</button>{/if}
            <div class="stack">{#each sources as item}<label class="radio-card"><input type="radio" bind:group={sourceId} value={item.id}/><div><div class="spread"><strong>{item.project ?? item.id.slice(0, 12)}</strong><span class="badge">{item.product} {item.version}</span></div><p>{item.summary.assets.toLocaleString()} items · {item.summary.users} users · {item.summary.albums} albums</p><p>{formatBytes(item.summary.databaseBytes)} database · {item.mounts.length} media mappings</p></div></label>{/each}</div>
            {#if source}<section class="card mt16"><div class="card-header"><h2>Resolved source configuration</h2><span class="badge">Source</span></div>{#each source.configuration as item}<div class="list-row"><Icon name={item.icon}/><div><strong>{item.title}</strong><p>{item.detail}</p></div>{#if item.status}<span class="badge">{item.status}</span>{/if}</div>{/each}<details class="card-body"><summary>Settings and environment names</summary><p class="meta mt16">{[...source.settings, ...source.environment].join(', ') || 'No additional settings'}</p></details></section>{/if}
            <div class="wizard-footer"><button class="button quiet" onclick={() => run(() => go('welcome'))}><Icon name="back"/>Back</button><button class="button primary" disabled={busy || !sourceId} onclick={() => run(inspectSource)}>Review library & settings</button></div>
          {:else if step === 1}
            {@render heading('Your library, in the same place', 'These exact mappings will be used by Frameleaf so existing photo paths keep working.')}
            <section class="card"><div class="card-header"><h2>Preserved media mappings</h2><span class="badge good">{source.mounts.length} mappings preserved</span></div>{@render mappings(source.mounts)}</section>
            <section class="card mt16"><div class="card-header"><h2>Settings compatibility</h2></div><div class="settings-row"><span>Users, albums & permissions</span><span>Imported from database</span><span class="badge good">Preserved</span></div><div class="settings-row"><span>Compatible settings</span><span>{source.settingsAuthority === 'file' ? 'Configuration file' : 'Database'}</span><span class="badge good">{source.settings.length} settings</span></div><div class="settings-row"><span>Database connection</span><span>New credentials generated</span><span class="badge">Recreated</span></div>{#if source.unsupportedSettings.length}<div class="card-body">{@render notice('Settings require review', `Frameleaf doesn’t recognise: ${source.unsupportedSettings.join(', ')}. Remove or rename them in Advanced settings below to continue.`, 'warning')}</div>{/if}<details class="disclosure" bind:open={advancedOpen} ontoggle={(event) => event.currentTarget.open && run(loadSourceSettings)}><summary>Advanced settings{source.settingsEdited ? ' · edited' : ''}</summary><p>The settings Frameleaf will start with, as JSON. Changes apply to this import only; your original installation is not changed. Passwords and secrets show as <code>[unchanged]</code> and keep their current value.</p><label class="field mt16"><span class="sr-only">Settings JSON</span><textarea class="settings-editor" spellcheck="false" bind:value={advancedSettings}></textarea></label><div class="actions mt16"><button class="button primary" disabled={busy} onclick={() => run(() => saveSourceSettings())}>Save settings</button>{#if source.settingsEdited}<button class="button quiet" disabled={busy} onclick={() => run(() => saveSourceSettings(true))}>Use original settings</button>{/if}</div></details><div class="card-body"><p class="meta">External sign-in callbacks and host-specific URLs may need updating for the new Frameleaf address. Compatible settings and credentials are preserved privately.</p></div></section>
            <section class="card mt16"><div class="card-header"><h2>Source database backup</h2></div><div class="list-row"><Icon name="database"/><div><strong>{sourceReview.backup.action === 'reuse' ? 'Recent verified database backup found' : 'A new database backup is needed'}</strong><p>{sourceReview.backup.action === 'reuse' ? new Date(sourceReview.backup.takenAt).toLocaleString() + ' · Same installation · Readable dump verified' : 'No verified dump from the last 24 hours qualifies.'}</p></div><span class="badge" class:good={sourceReview.backup.action === 'reuse'}>{sourceReview.backup.action === 'reuse' ? 'Backup skipped' : 'Backup needed'}</span></div></section>
            {#if source.product === 'Noodle Gallery'}<div class="mt16">{@render notice('Some Noodle Gallery features stay behind', 'Spaces, people named in Spaces, people shared between accounts, pets, user groups, favourites other people set and Gallery-only edits aren’t imported. Your photos, albums, people and each owner’s favourites come across, and Manager keeps your Noodle Gallery database for recovery.', 'warning', 'warning')}</div>{/if}
            <label class="check-row mt24"><input type="checkbox" bind:checked={mappingsAccepted}/><span>I’ve reviewed the mappings and settings that need attention.</span></label>
            <div class="mt24">{@render configuration()}</div>
            <div class="wizard-footer"><button class="button quiet" onclick={() => step = 0}><Icon name="back"/>Back</button>{#if checking}<p class="muted checking-note" role="status">Checking the server. This can take up to a minute.</p>{/if}<button class="button primary" disabled={busy || !mappingsAccepted || source.unsupportedSettings.length > 0 || !lifecycle || !tag} onclick={() => lastImportStep === 3 ? run(recheckInstall) : configurationReady() && (step = 2)}>{lastImportStep === 3 ? 'Check this server' : 'Review database backup'}</button></div>
          {:else if step === 2 && lastImportStep === 4}
            {@render heading('Back up the source database', 'Only the database will be backed up. Your photos stay in place.')}
            <section class="card"><div class="card-header"><h2>Database backup only</h2><span class="badge">Media excluded</span></div><div class="card-body"><label class="field"><span>Mounted encrypted backup destination</span><input value={dashboard.backupRoot} readonly/><small>Manager uses its mounted backup folder. Photos, videos, thumbnails and external libraries are excluded.</small></label><div class="breakdown mt16"><div><strong>{formatBytes(source.summary.databaseBytes)}</strong><small>Source database</small></div><div><strong>{formatBytes(source.summary.databaseBytes * 3)}</strong><small>Preparation space</small></div></div></div></section>
            <div class="mt16">{@render notice('Your photos stay in place', 'Manager will stop the original app and verify the copied database before starting Frameleaf.')}</div><div class="wizard-footer"><button class="button quiet" onclick={() => step = 1}><Icon name="back"/>Back</button><button class="button primary" disabled={busy} onclick={() => run(recheckInstall)}>Check this server</button></div>
          {:else if step === lastImportStep - 1}
            {@render checksStep(reviewRows, checkOrder('import', containerRows.length > 0), () => { review = null; step = lastImportStep - 2; }, () => step = lastImportStep, 'Review the switch', recheckInstall)}
          {:else}
            {@render heading('Ready to switch to Frameleaf', 'Your library will be unavailable while Manager imports the current stopped database.')}
            {#if review?.ready}
              {#if review.backup.action === 'reuse'}{@render notice('Existing source backup reused · Backup step skipped', 'Manager rechecks the backup’s age and usability at cutover.')}{/if}
              <section class="card mt16"><div class="card-header"><h2>The cutover plan</h2><span class="badge good">Preflight passed</span></div><div class="card-body"><ol class="timeline">{#each ['Recheck this installation and its backup', 'Stop the original app and disable automatic restart', ...(review.backup.action === 'create' ? ['Create and verify a database backup'] : []), 'Copy the current database into separate Frameleaf PostgreSQL storage', 'Import, start Frameleaf and verify the library'] as item, index}<li><span class="stage-icon">{index + 1}</span><div><strong>{item}</strong></div></li>{/each}</ol><p class="meta mt16">PostgreSQL root: <code>{review.databaseStorage.root}</code></p></div></section>{@render containerReview()}
              <div class="mt16">{@render notice('Only Frameleaf will write to these media locations', review.recovery, 'warning', 'lock')}</div><label class="check-row mt24"><input type="checkbox" bind:checked={cutoverAccepted}/><span>I understand the original app will stay stopped and this backup covers only the database.</span></label><button class="button primary mt16" disabled={busy || !cutoverAccepted || !!activeOperation} onclick={() => run(() => start('install', { reviewId: review.id }))}>Start import</button>
            {/if}
            <div class="wizard-footer"><button class="button quiet" onclick={() => { cutoverAccepted = false; step = lastImportStep - 1; }}><Icon name="back"/>Back</button></div>
          {/if}
        {:else if screen === 'photo-app'}
          {@render steps(photoAppSteps, step)}
          {#if review?.commonImport}
            {@render commonImportReview(() => { review = null; step = 1; cutoverAccepted = false; importAdminPassword = ''; }, () => showModal('photo-app-cancel', photoAppOperation))}
          {:else if !photoAppInspection}
            {@render heading('Nothing to review yet', 'Choose an app to import from on the first page of setup.')}
            <div class="wizard-footer"><button class="button quiet" onclick={() => run(() => go('welcome'))}><Icon name="back"/>Back</button></div>
          {:else}
            {@render photoAppReview()}
          {/if}
        {:else if screen === 'fresh'}
          {@render steps(['Storage', 'Checks', 'Install'], step)}
          {#if step === 0}{@render heading('Give your library a home', 'Choose the server locations and connection settings for this installation.')}{@render configuration()}<div class="wizard-footer"><button class="button quiet" onclick={() => run(() => go('welcome'))}><Icon name="back"/>Back</button>{#if checking}<p class="muted checking-note" role="status">Checking the server. This can take up to a minute.</p>{/if}<button class="button primary" disabled={busy || !mediaPath || !tag || !lifecycle} onclick={() => run(recheckInstall)}>Check this server</button></div>
          {:else if step === 1}{@render checksStep(reviewRows, checkOrder('install', containerRows.length > 0), () => { step = 0; review = null; }, () => step = 2, 'Review installation', recheckInstall)}
          {:else}{@render heading('Ready to set up Frameleaf', 'Manager will prepare the services and take you into Frameleaf when your server is ready.')}<section class="card"><div class="card-header"><h2>New installation</h2><span class="badge good">{review.tag}</span></div>{#each [['folder', 'Photo library', mediaPath], ['database', 'New PostgreSQL database', databaseRoot], ['shield', 'Encrypted database backups', dashboard.backupRoot], ['network', 'Application port', String(port)], ['cpu', 'Processing', `${processorName(dashboard.host?.acceleration)} · Machine learning ${ml ? 'on' : 'off'}`]] as [icon, title, detail]}<div class="list-row"><Icon name={icon}/><div><strong>{title}</strong><p><code>{detail}</code></p></div></div>{/each}</section>{@render containerReview()}<div class="mt16">{@render notice('Managed independently', 'Your photo library keeps running when Manager is unavailable. Keep a protected configuration export for manual recovery.')}</div><div class="wizard-footer"><button class="button quiet" onclick={() => step = 1}><Icon name="back"/>Back</button><button class="button primary" disabled={busy || !!activeOperation} onclick={() => run(() => start('install', { reviewId: review.id }))}>Install Frameleaf</button></div>{/if}
        {:else if screen === 'progress'}
          {#if operation && timeline}{@render heading(operationNames[operation.kind] ?? 'Manager operation', isPhotoAppCapture(operation) && operation.state === 'awaiting-review' ? (isFolderImport(operation.photoApp?.kind) ? 'Manager has read your export folder. Review what comes across before anything is imported.' : 'Your app is stopped and Manager has read its library. Review what comes across before anything is imported.') : operation.state === 'running' ? 'You can close this page. Manager records every completed step.' : operation.state === 'complete' && !operation.error ? 'The recorded operation completed successfully.' : 'Review the saved step before continuing.')}
            <section class="card"><div class="card-body">{#if setupMode}<div class="progress-hero"><div class="progress-ring" class:done={timeline.successful} style="--p: {timeline.percent}" role="progressbar" aria-label="Operation progress" aria-valuenow={timeline.percent} aria-valuemin="0" aria-valuemax="100">{#if timeline.successful}<Icon name="check"/>{:else}<strong>{timeline.percent}%</strong>{/if}</div><div><strong>{timeline.successful ? 'All done' : readable(operation.step ?? operation.state)}</strong><p class="meta">{operation.state === 'running' ? 'This usually takes a few minutes.' : readable(operation.state)}</p></div></div>{:else}<div class="spread progress-label"><span>{readable(operation.step ?? operation.state)}</span><strong>{timeline.percent}%</strong></div><progress class="progress" aria-label="Operation progress" value={timeline.percent} max="100"></progress>{/if}<ol class="timeline mt16">{#each timeline.steps as item, index}<li class:done={item.state === 'complete'} class:running={item.state === 'running'}><span class="stage-icon">{#if item.state === 'complete'}<Icon name="check"/>{:else if item.state === 'running'}<Icon name="loader" class="spin"/>{:else}{index + 1}{/if}</span><div><strong>{item.label}</strong></div><span class="stage-time">{readable(item.state)}</span></li>{/each}</ol>{#if operation.error}<div class="notice warning mt16" role="alert"><Icon name="warning"/><div><strong>{readable(operation.error, operation.detail)}</strong><p>Completed journal steps are retained. Resume runs the next safe step.</p></div></div>{/if}</div><div class="card-footer"><span class="safety-note"><Icon name="shield"/>Completed steps are recorded</span><span class="badge" class:good={timeline.successful}>{readable(operation.state)}</span></div></section>
            {#if operation.error === 'import_bootstrap_credentials_required'}
              {#if location.protocol === 'https:'}
                <form class="card mt16" onsubmit={(event) => { event.preventDefault(); void run(() => resumeCommonImport(operation.id)); }}>
                  <div class="card-header"><h2>Re-enter destination administrator details</h2></div>
                  <div class="card-body">{@render importAdministratorFields()}</div>
                  <div class="card-footer"><button class="button primary" disabled={busy}>Resume safely</button></div>
                </form>
              {:else}
                <div class="mt16">{@render notice('Secure connection required', 'Open Manager over HTTPS to re-enter the destination administrator password.', 'warning')}</div>
              {/if}
            {/if}
            <div class="wizard-footer"><button class="button quiet" onclick={() => run(() => go('activity'))}>Operation history</button><div class="actions">{#if isPhotoAppCapture(operation)}<button class="button quiet" disabled={busy} onclick={() => showModal('photo-app-cancel', operation.id)}>Cancel import</button>{#if operation.state === 'awaiting-review'}<button class="button primary" disabled={busy} onclick={() => run(() => inspectPhotoApp(operation.id))}>Review what comes across</button>{/if}{/if}{#if operation.kind === 'move-library' && operation.state === 'running'}<button class="button quiet" disabled={busy || !operation.canStop} onclick={() => run(async () => { await api('stop-move', { id: operation.id }); await refresh(); })}>Stop safely</button>{/if}{#if ['failed', 'interrupted'].includes(operation.state)}{#if operation.error !== 'import_bootstrap_credentials_required'}<button class="button primary" disabled={busy} onclick={() => run(async () => { await api('resume', { id: operation.id }); await refresh(); })}>Resume safely</button>{/if}{#if !isPhotoAppCapture(operation) && (operation.canCancel ?? canCancel(operation, installation))}<button class="button danger" disabled={busy} onclick={() => showModal('recover')}>{operation.kind === 'move-library' ? 'Cancel safely' : operation.kind === 'backup' ? 'Cancel backup' : operation.kind === 'update' ? 'Cancel update and restart' : 'Recover the stopped source'}</button>{/if}{:else if timeline.successful}<button class="button primary" onclick={() => run(() => go(['install', 'import', 'restore'].includes(operation.kind) && !dashboard.onboardingFinished ? 'success' : 'overview'))}>Continue</button>{/if}</div></div>
          {:else}{@render heading('No recorded operation', 'Start setup or choose a maintenance operation.')}<button class="button primary" onclick={() => run(() => go(installation ? 'overview' : 'welcome'))}>Continue</button>{/if}
        {:else if screen === 'success'}
          {@render steps(onboardingSteps, 0)}<div class="success-icon"><Icon name="check"/></div>{@render heading(installation?.origin === 'new_import' ? 'Your import is in Frameleaf' : 'Your server is ready', 'Now make it yours and connect your phone. Library preparation continues in the background.')}{@render notice('Services are ready', installation?.origin === 'new_import' ? 'Your users, albums and settings are imported. The original app remains stopped, and your media stays in place.' : 'Continue with your local photo account and mobile app.')}{@render regeneration()}<div class="wizard-footer"><span class="meta">Library preparation continues</span><button class="button primary" onclick={() => run(() => go('profile'))}>Continue to your details <Icon name="arrow"/></button></div>
        {:else if screen === 'profile'}
          {@render steps(onboardingSteps, 1)}{@render heading('Make yourself at home', 'Confirm your details, then decide whether to add a Frameleaf account.')}
          <form onsubmit={(event) => { event.preventDefault(); void run(saveProfile); }}><section class="card"><div class="card-body"><div class="profile-intro"><span class="profile-avatar"><Icon name="user"/></span><div><h2>Your photo profile</h2><p class="meta">Your local photo account belongs to this server. Existing library permissions are preserved.</p></div></div><div class="form-grid mt24"><label class="field"><span>First name</span><input bind:value={firstName} required maxlength="80" autocomplete="given-name"/></label><label class="field"><span>Last name</span><input bind:value={lastName} maxlength="80" autocomplete="family-name"/></label><label class="field full"><span>Email address</span><input type="email" bind:value={email} required autocomplete="email"/><small>Saved privately with Manager setup. Photo account changes happen in Frameleaf.</small></label></div></div></section><section class="card mt24"><div class="card-header"><h2>A Frameleaf account is optional</h2><span class="badge">Optional</span></div><div class="card-body"><p class="muted account-description">One sign-in for Frameleaf services. You can choose Cloud features later; no subscription starts here.</p><div class="stack mt16">{#each [['local', 'Continue with my local account', 'Use Frameleaf on your own server. You can add an account later.'], ['create', 'Create a Frameleaf account', 'Continue in Frameleaf’s secure account flow.'], ['existing', 'I already have a Frameleaf account', 'Sign in and link your existing account in Frameleaf.']] as [value, title, detail]}<label class="radio-card"><input type="radio" bind:group={account} value={value}/><div><strong>{title}</strong><p>{detail}</p></div></label>{/each}</div></div></section><div class="wizard-footer"><button type="button" class="button quiet" onclick={() => run(() => go('success'))}><Icon name="back"/>Back</button><button class="button primary" disabled={busy}>{account === 'local' ? 'Continue without a Cloud account' : 'Continue to secure account setup'}</button></div></form>
        {:else if screen === 'downloads'}
          {@render steps(onboardingSteps, 2)}{@render heading('Your whole library. In your pocket.', 'Get Frameleaf on your phone, then link this server.')}
          {#if account !== 'local'}<section class="card mb16"><div class="card-body"><h2>{account === 'create' ? 'Create your Frameleaf account' : 'Link your Frameleaf account'}</h2><p class="meta mt16">Complete authentication and email verification in Frameleaf. Manager does not collect your Cloud password or verification code.</p><a class="button primary mt16" href={dashboard.appUrl + '/auth/onboarding#frs-tool-frameleaf'} target="_blank" rel="noreferrer">Open secure Frameleaf setup <Icon name="arrow"/></a></div></section>{/if}
          <div class="two-cols download-grid">{#each apps as app}<section class="card download-card"><div class="card-header"><h2>{app.name}</h2><span class="badge">{app.label}</span></div><div class="download-art"><img class="official-app-shot" src={app.image} alt={`Official Frameleaf ${app.name} library screenshot`} width="120" height="260"/><div class="qr-column"><a href={app.href} target="_blank" rel="noreferrer" aria-label={`Open official ${app.name} app page`}>{@html qrSvg(app.href)}</a><span class="meta">Scan with your phone</span></div></div><div class="card-body"><p class="availability">Check the official page for current app availability.</p><a class="button quiet app-page-link" href={app.href} target="_blank" rel="noreferrer">Open {app.label} app page <Icon name="arrow"/></a></div></section>{/each}</div>
          <section class="card mt24"><div class="card-header"><h2>Connect your server</h2></div><div class="card-body"><ol class="connection-steps"><li><span>1</span><div>Open Frameleaf and choose your own server.</div></li><li><span>2</span><div>Enter the server address below.</div></li><li><span>3</span><div>Sign in with your local or imported photo account.</div></li></ol><div class="server-address"><div><small>Your server</small><code>{dashboard.appUrl}</code></div><button class="button quiet" onclick={copyAddress}>Copy address</button></div><a class="button quiet mt16" href={dashboard.appUrl + '/auth/onboarding'} target="_blank" rel="noreferrer">Open local photo account setup <Icon name="arrow"/></a></div></section><div class="wizard-footer"><button class="button quiet" onclick={() => run(() => go('profile'))}><Icon name="back"/>Back</button><button class="button primary" onclick={() => run(() => go('phone'))}>Continue to library preparation</button></div>
        {:else if screen === 'phone' || screen === 'setup-complete'}
          {@render steps(onboardingSteps, 3)}{@render heading(dashboard.onboardingFinished ? 'Your library is ready' : 'Preparing your library, together', 'Your phone syncs the catalog and browsing previews while the server prepares the library.')}
          <div class="setup-layout"><div class="server-preparation"><section class="card"><div class="card-header"><h2>{phases[dashboard.librarySetup?.phase] ?? 'Waiting for library status'}</h2><span class="badge" class:good={dashboard.librarySetup?.rescanComplete}>{dashboard.librarySetup?.rescanComplete ? 'Complete' : 'Preparing'}</span></div><div class="card-body setup-state"><div class="list-row"><Icon name={dashboard.librarySetup?.rescanComplete ? 'check' : 'update'}/><div><strong>Library rescan</strong><p>Reconcile existing media and complete required processing.</p></div></div><div class="list-row"><Icon name={dashboard.librarySetup?.verificationPassed ? 'check' : 'shield'}/><div><strong>Library verification</strong><p>Verify the final catalog and review findings.</p></div></div>{#if dashboard.librarySetup?.phase === 'awaiting-account'}<a class="button primary" href={dashboard.appUrl + '/auth/onboarding'} target="_blank" rel="noreferrer">Finish your photo account setup</a>{/if}{#if dashboard.librarySetup?.phase === 'needs-attention'}<a href={dashboard.appUrl + '/utilities'} target="_blank" rel="noreferrer">Review Library Care findings ↗</a><button class="button quiet" disabled={busy} onclick={() => run(async () => { await api('retry-setup', {}); await refresh(); })}>Verify the library again</button>{/if}</div></section>{@render regeneration()}<p class="quiet-note"><Icon name="info"/>Keep the app open. If the phone pauses background work, reopen it to resume. Original media is not downloaded by catalog setup.</p></div><section class="card"><div class="card-header"><h2>Your phone</h2><span class="badge" class:good={dashboard.librarySetup?.canFinish}>{dashboard.librarySetup?.canFinish ? 'Ready' : 'Waiting'}</span></div><div class="phone-state"><div class="phone-icon"><Icon name="image"/></div><h3>{dashboard.librarySetup?.canFinish ? 'Library caught up' : 'Finish preparing your phone'}</h3><p class="muted">{dashboard.librarySetup?.canFinish ? 'The server reports a phone has completed its final catalog and browsing previews.' : 'Open Frameleaf on your phone and connect to this server. Keep the app open until its final catalog and browsing previews are ready.'}</p><div class="server-address"><code>{dashboard.appUrl}</code></div><ul class="checklist"><li><Icon name={dashboard.librarySetup?.canFinish ? 'check' : 'clock'}/>Final catalog acknowledged</li><li><Icon name={dashboard.librarySetup?.canFinish ? 'check' : 'clock'}/>Browsing previews ready</li></ul></div></section></div>
          <div class="wizard-footer"><button class="button quiet" onclick={() => run(() => go('downloads'))}>Back to app setup</button>{#if dashboard.onboardingFinished}<button class="button primary" onclick={() => run(() => go('overview'))}>Open overview</button>{:else}<div class="actions"><button class="button quiet" disabled={busy} onclick={() => showModal('skip-setup')}>Skip and let the server run</button><button class="button primary" disabled={busy || !dashboard.librarySetup?.canFinish} onclick={() => run(async () => { await api('finish-setup', {}); await refresh(); screen = 'setup-complete'; })}>Finish setup</button></div>{/if}</div>
        {:else if ['overview', 'services', 'storage', 'backups', 'updates'].includes(screen) && !installation && screen !== 'backups'}
          {@render heading(labels[screen], 'Set up Frameleaf to use this part of Manager.')}<section class="card empty-state"><Icon name="server"/><h2>No installation yet</h2><p>Import an existing library, set up a new one, or restore a database backup.</p><button class="button primary" onclick={() => run(() => go('welcome'))}>Set up Frameleaf</button></section>
        {:else if screen === 'overview'}
          {@render heading(installation.name ?? 'Your library', 'Your photos, services, and recovery points at a glance.')}<div class="actions mb16"><a class="button primary" href={dashboard.appUrl} target="_blank" rel="noreferrer">Open Frameleaf <Icon name="arrow"/></a>{#if !dashboard.onboardingFinished}<button class="button quiet" onclick={() => run(() => go(dashboard.profile ? 'downloads' : 'profile'))}>Continue setup</button>{/if}{#if dashboard.librarySetup?.dismissed}<button class="button quiet" disabled={busy} onclick={() => run(async () => { await api('retry-setup', {}); await refresh(); notify('Library setup is back. Frameleaf shows its progress until it finishes.'); })}>Check the library again</button>{/if}</div>
          {@render notice(running ? 'Your server is running' : 'Your library is stopped', running ? healthy ? 'Managed services are running. Review library preparation before finishing setup.' : 'Some services are starting or need attention.' : 'Start your services to make Frameleaf available.', running && healthy ? 'good' : 'warning', running ? 'check' : 'stop')}
          <div class="metric-grid mt16"><section class="card metric"><span class="label"><Icon name="image"/>Photos & videos</span><strong>{dashboard.summary?.assets?.toLocaleString() ?? 'Unavailable'}</strong><small>{dashboard.summary ? plural(dashboard.summary.albums, 'album') + ' · ' + plural(dashboard.summary.users, 'account') : 'Library counts require the database'}</small></section><section class="card metric"><span class="label"><Icon name="drive"/>Storage available</span><strong>{formatBytes(storage.find(item => item.availableBytes != null)?.availableBytes)}</strong><small>Mounted library storage</small></section><section class="card metric"><span class="label"><Icon name="shield"/>Latest backup</span><strong>{latestBackup ? new Date(latestBackup.time).toLocaleDateString() : 'None'}</strong><small>{latestBackup ? 'Encrypted database recovery point' : 'Create a database backup'}</small></section></div>
          <section class="card mt24"><div class="card-header"><h2>Services</h2><button class="button quiet" onclick={() => run(() => go('services'))}>Manage</button></div>{@render services()}</section><div class="two-cols mt16"><section class="card"><div class="card-body"><div class="row mb16"><Icon name="shield"/><h2>Database recovery points</h2></div><p class="muted">Encrypted database dumps. Media is excluded.</p><div class="spread mt16"><span class="meta">{snapshots.length} snapshots</span><button class="text-button" onclick={() => run(() => go('backups'))}>View backups</button></div></div></section><section class="card"><div class="card-body"><div class="row mb16"><Icon name="update"/><h2>{releasesLoaded ? availableUpdates.length ? 'Updates available' : 'Up to date' : 'Choose when to update'}</h2></div><p class="muted">Running {installation.release}. Review eligibility and recovery before applying a release.</p><button class="text-button mt16" onclick={() => run(() => go('updates'))}>Review updates</button></div></section></div>{@render regeneration()}
        {:else if screen === 'services'}
          {@render heading('Services', 'Manager owns this stack. Your library runs independently of the Manager container.')}<div class="actions mb16"><button class="button" class:primary={!running} disabled={busy || !!activeOperation} onclick={() => running ? showModal('control', 'stop') : run(() => control('start'))}><Icon name={running ? 'stop' : 'play'}/>{running ? 'Stop stack' : 'Start stack'}</button><button class="button quiet" disabled={busy || !!activeOperation} onclick={() => showModal('control', 'restart')}><Icon name="update"/>Restart stack</button></div><section class="card"><div class="card-header"><h2>Frameleaf · {installation.project}</h2></div>{@render services()}</section>{@render externalFolderSection()}{@render advancedContainers()}
          <section class="card mt16"><div class="card-header"><h2>Recent server logs</h2><div class="actions"><button class="button quiet" disabled={busy || !logService} onclick={() => run(() => showLogs(logService))}>Refresh logs</button><button class="button quiet" disabled={!logs} onclick={downloadLogs}><Icon name="document"/>Download logs</button></div></div><div class="card-body">{#if logs}<pre class="log" {@attach (node) => { void logs; node.scrollTop = node.scrollHeight; }}>{logs}</pre>{:else}<p class="muted">Choose Logs on a managed service to load its sanitized output.</p>{/if}</div></section><p class="quiet-note"><Icon name="lock"/>Logs are sanitized before they reach this browser.</p>
          <section class="card mt16"><div class="card-header"><h2>Troubleshooting</h2><div class="actions"><button class="button quiet" disabled={busy} onclick={() => run(async () => { diagnosing = 'checks'; try { checks = (await api('diagnostics', {})).checks; } finally { diagnosing = ''; } })}><Icon name="activity"/>{diagnosing === 'checks' ? 'Checking…' : checks ? 'Check again' : 'Check connections'}</button><button class="button quiet" disabled={busy} onclick={() => run(async () => { diagnosing = 'report'; try { await download('diagnostics-report', `frameleaf-troubleshooting-${new Date().toISOString().slice(0, 10)}.txt`, {}, 'Report downloaded. Read it, then attach it to a post in Community › Bug reports.'); } finally { diagnosing = ''; } })}><Icon name="document"/>{diagnosing === 'report' ? 'Preparing report…' : 'Download report'}</button><a class="button quiet" href="https://frameleaf.app/help/community/c/bug-reports/9" target="_blank" rel="noreferrer">Post on the community ↗</a></div></div>{#if checks}{#each checks as check}<div class="list-row"><Icon name={check.ok === false ? 'warning' : check.ok ? 'check' : 'info'}/><div><strong>{check.name}</strong><p>{check.detail}</p></div><span class="badge" class:good={check.ok === true} class:warning={check.ok === false}>{check.ok === true ? 'OK' : check.ok === false ? 'Problem' : 'Note'}</span></div>{/each}{:else}<div class="card-body"><p class="muted">Check that Docker, the database, machine learning, network discovery, the internet and your drives all answer. The report adds the last day of logs from every service and points out known problems, ready to attach to a post in <a href="https://frameleaf.app/help/community/c/bug-reports/9" target="_blank" rel="noreferrer">Community › Bug reports ↗</a>.</p></div>{/if}</section><p class="quiet-note"><Icon name="lock"/>Manager tries to remove passwords, keys, folder paths, file names and e-mail addresses. It can miss some, so read the report and delete anything private before you post it.</p>
        {:else if screen === 'storage'}
          {@render heading('Storage', 'The exact paths your library uses, and available space on mounted storage.')}<div class="stack">{#each storage as disk}<section class="card"><div class="card-header"><h2><code>{disk.path}</code></h2><span class="badge" class:warning={(disk.availableBytes == null && disk.measurable !== false) || disk.lowOnSpace}>{disk.measurable === false ? 'Can’t check free space' : disk.availableBytes == null ? 'Unavailable' : disk.lowOnSpace ? 'Nearly full' : 'Mounted'}</span></div><div class="card-body">{#if disk.totalBytes != null}<div class="spread"><strong>{formatBytes(disk.totalBytes - disk.freeBytes)} used of {formatBytes(disk.totalBytes)}</strong><span class="muted">{formatBytes(disk.availableBytes)} available</span></div><progress class="meter mt16" aria-label={disk.path + ' storage used'} value={disk.totalBytes - disk.freeBytes} max={disk.totalBytes}></progress>{:else}<p class="muted">{disk.measurable === false ? 'Manager can’t check free space on this folder from here. Frameleaf still uses it as normal.' : 'Manager cannot read capacity for this mounted location.'}</p>{/if}</div></section>{/each}</div><section class="card mt16"><div class="card-header"><h2>Media mappings</h2><span class="badge">Exact access modes</span></div>{@render mappings(installation.mounts)}</section><section class="card mt16"><div class="card-header"><h2>Separate Frameleaf database</h2></div><div class="card-body"><code>{installation.databasePath}</code><p class="meta mt16">PostgreSQL uses a dedicated folder on the host disk. The source database and earlier recovery folders are retained.</p></div></section>
          <MoveLibrary browse={!!dashboard?.folderSetup} roots={dashboard?.storageRoots ?? []} disabled={busy || !!activeOperation} {api} started={(id) => { selectedOperation = id; void run(() => go('progress')); }}/>
          {#each dashboard?.retainedMedia ?? [] as copy}<section class="card mt16"><div class="card-header"><h2>Retained original copy</h2></div><div class="card-body"><code>{copy.source}</code><p class="meta mt16">Kept after switching to {copy.destination}. New writes go to the current folder. Do not switch back to this old copy without another verified move or complete restore.</p></div></section>{/each}
        {:else if screen === 'backups'}
          {@render heading('Database backups', 'Back up the database only. Photos, videos and external libraries stay in their existing locations.')}
          {#if installation}<button class="button primary mb16" disabled={busy || !!activeOperation} onclick={() => run(() => control('backup'))}><Icon name="database"/>Back up database</button>{/if}
          <section class="card"><div class="card-header"><h2>Backup drive</h2></div><div class="list-row"><Icon name="drive"/><div><strong><code>{dashboard.backupRoot}</code></strong><p>Encrypted database dumps · Mounted backup destination</p></div></div><div class="list-row"><Icon name="clock"/><div><strong>On demand</strong><p>You control when Manager creates a database backup.</p></div></div><div class="list-row"><Icon name="key"/><div><strong>Recovery key</strong><p>Store it separately from the server.</p></div><button class="button quiet" disabled={!backupStatus.keyAvailable} onclick={() => showModal('backup-key')}>Export recovery key</button></div></section>
          <section class="card mt24"><div class="card-header"><h2>Database recovery points</h2><button class="button quiet" disabled={busy} onclick={() => run(loadBackups)}>Refresh</button></div>{#if snapshots.length}<div class="table-wrap"><table><thead><tr><th>Database backup</th><th>Scope</th><th>Status</th><th></th></tr></thead><tbody>{#each snapshots as item}<tr><td><strong>{new Date(item.time).toLocaleString()}</strong><small>Snapshot {item.id.slice(0, 12)}</small></td><td>Database & configuration<small>Media excluded</small></td><td><span class="badge">Encrypted</span></td><td><button class="button quiet" disabled={busy || !!activeOperation} onclick={() => run(() => startRestore(item.id))}>Restore</button></td></tr>{/each}</tbody></table></div>{:else}<div class="card-body"><p class="muted">No canonical database recovery points are available.</p>{#if !backupStatus.unlocked}<button class="button quiet mt16" disabled={busy || !!activeOperation} onclick={() => run(() => startRestore())}>Unlock a backup repository</button>{/if}</div>{/if}</section><div class="mt16">{@render notice('Media is not part of these backups', 'Restoring a database reconnects references to media that already exists. It does not restore missing or changed files.', '', 'info')}</div>{#if installation?.origin === 'new_import'}<button class="button quiet mt16" onclick={() => showModal('source-recovery')}>Original library recovery notes</button>{/if}
        {:else if screen === 'restore'}
          {@render steps(['Database backup', 'Recovery point', 'Checks', 'Restore'], step)}
          {#if step === 0}{@render heading('Restore your database', 'Connect an encrypted database backup and keep the existing media locations available.')}<section class="card"><div class="card-header"><h2>Database backup repository</h2></div><div class="card-body stack"><label class="field"><span>Mounted backup destination</span><input value={dashboard.backupRoot} readonly/></label>{#if !backupStatus.unlocked}<form class="stack" onsubmit={(event) => { event.preventDefault(); void run(unlockBackups); }}><label class="field"><span>Recovery key</span><input type="password" bind:value={recoveryKey} required autocomplete="off"/></label><button class="button primary" disabled={busy}>Unlock backups</button></form>{:else}<p class="meta">The existing recovery key unlocks {snapshots.length} canonical database snapshots.</p><button class="button primary" disabled={!snapshots.length} onclick={() => step = 1}>Choose a recovery point</button>{#if !snapshots.length}<p class="meta">This repository has no canonical Frameleaf recovery points. Create a database backup before using ordinary restore. Source application checkpoints are kept for separate source recovery.</p>{/if}{/if}</div></section><div class="mt16">{@render notice('Your media must already be available', 'Manager restores into a new empty PostgreSQL folder. Photos, videos and external-library files are not included.', '', 'database')}</div><div class="wizard-footer"><button class="button quiet" onclick={() => run(() => go(installation ? 'backups' : 'welcome'))}><Icon name="back"/>Back</button></div>
          {:else if step === 1}{@render heading('Choose a database recovery point', 'Database records return to the selected time. Media files are not restored.')}<form onsubmit={(event) => { event.preventDefault(); void run(recheckRestore); }}><div class="stack">{#each snapshots as item}<label class="radio-card"><input type="radio" bind:group={snapshot} value={item.id} required/><div><div class="spread"><strong>{new Date(item.time).toLocaleString()}</strong><span class="badge">Database only</span></div><p>{item.id.slice(0, 12)} · Encrypted recovery point</p></div></label>{/each}<label class="field"><span>PostgreSQL appdata location</span><input bind:value={databaseRoot} list="database-roots" required/><small>A separate empty database folder is allocated here. Existing files are retained.</small></label></div><div class="wizard-footer"><button type="button" class="button quiet" onclick={() => step = 0}><Icon name="back"/>Back</button><button class="button primary" disabled={busy || !snapshot}>Check this server</button></div></form>
          {:else if step === 2}{@render checksStep(restoreRows, checkOrder('restore'), () => { restoreReview = null; step = 1; }, () => step = 3, 'Review restore', recheckRestore)}
          {:else}{@render heading('Review your database restore', 'Verify the database recovery point and reconnect existing library files.')}<section class="card"><div class="card-header"><h2>Recovery destination</h2><span class="badge good">Verified review</span></div><div class="list-row"><Icon name="database"/><div><strong>New, empty PostgreSQL database</strong><p><code>{restoreReview.databaseStorage.root}</code></p></div></div><div class="list-row"><Icon name="update"/><div><strong>Matching release</strong><p>{restoreReview.release}</p></div></div>{@render mappings(restoreReview.mounts)}</section>{#if restoreReview.thumbnailFallback}<div class="mt16">{@render notice('Thumbnails go back in the photos folder', `${restoreReview.thumbnailFallback.missing} is not there, so thumbnails will be kept in ${restoreReview.thumbnailFallback.folder}. Thumbnails that are missing can be made again; your photos are untouched.`, 'warning', 'warning')}</div>{/if}<div class="mt16">{@render notice('This restore does not recover media files', 'Required files must already exist at these mappings. The current stack will be stopped and retained separately before restoring.', 'warning', 'warning')}</div><label class="check-row mt24"><input type="checkbox" bind:checked={restoreAccepted}/><span>I understand this restores database records and stops the current installation. Media is not restored.</span></label><div class="wizard-footer"><button class="button quiet" onclick={() => { restoreAccepted = false; step = 2; }}><Icon name="back"/>Back</button><button class="button primary" disabled={busy || !restoreAccepted || !!activeOperation} onclick={() => run(() => start('restore', { id: restoreReview.id }))}>Restore database</button></div>{/if}
        {:else if screen === 'updates'}
          {@render heading('Updates', 'Choose when to update. Manager prepares your database recovery point first.')}
          <section class="card mb16"><div class="list-row"><Icon name="update"/><div><strong>Automatic updates</strong><p>Manager checks every few hours and installs new releases one at a time, with a database recovery point first.</p>{#if dashboard.autoUpdateFailure}<p class="meta" role="status">The last check ({new Date(dashboard.autoUpdateFailure.at).toLocaleString()}) did not start an update: {readable(dashboard.autoUpdateFailure.code)}</p>{/if}</div><label class="toggle"><input type="checkbox" checked={dashboard.autoUpdate} disabled={busy} onchange={(event) => { const input = event.currentTarget, enabled = input.checked; void run(async () => { try { await api('auto-update', { enabled }); dashboard.autoUpdate = enabled; } finally { input.checked = dashboard.autoUpdate; } }); }}/><span class="toggle-track"></span><span>Enable</span></label></div></section>
          <button class="button quiet mb16" disabled={busy} onclick={() => run(loadReleases)}><Icon name="update"/>Check for updates</button>
          {#if !availableUpdates.length}<section class="card empty-state"><Icon name="update"/><h2>Up to date</h2><p>Your current release is {installation.release}. Withdrawn and staged releases that are not eligible for this server are excluded.</p></section>{:else}<section class="card"><div class="card-header"><h2>Available releases</h2><span class="badge">Stable channel</span></div><div class="card-body"><form class="stack" onsubmit={(event) => { event.preventDefault(); void run(async () => { updateReview = await api('review-update', { tag }); }); }}><label class="field"><span>Eligible release</span><select bind:value={tag} required onchange={() => updateReview = null}><option value="">Select a release</option>{#each availableUpdates as release}<option value={release.tag}>{release.tag} · {new Date(release.publishedAt).toLocaleDateString()}</option>{/each}</select></label>{#if releases.find(item => item.tag === tag)?.notes}<pre class="log">{releaseNotesText(releases.find(item => item.tag === tag).notes)}</pre>{/if}<button class="button primary" disabled={busy || !tag || !!activeOperation}>Verify and review update</button></form></div></section>{/if}
          {#if updateReview}<section class="card mt16"><div class="card-header"><h2>{updateReview.from} → {updateReview.to}</h2><span class="badge good">Verified</span></div><div class="card-body"><ul class="checklist"><li><Icon name="check"/>Signature, architecture and eligibility checked</li><li><Icon name="check"/>Complete compatible image set reviewed</li><li><Icon name="database"/>Database checkpoint required before applying the release</li>{#if updateReview.databaseMove}<li><Icon name="database"/>New database engine ({updateReview.databaseMove.from} → {updateReview.databaseMove.to}): the database is copied into a new folder, needing about {formatBytes(updateReview.databaseMove.bytes)} free</li>{/if}</ul><p class="meta mt16">{updateReview.recovery}</p></div><div class="card-footer"><span class="safety-note"><Icon name="clock"/>Photo access pauses during the update</span><button class="button primary" disabled={busy || !!activeOperation} onclick={() => showModal('update')}>Update Frameleaf</button></div></section>{/if}
        {:else if screen === 'activity'}
          {@render heading('Activity', 'Recorded setup, maintenance, and recovery operations on this server.')}<section class="card"><div class="card-header"><h2>Operation history</h2></div>{#each dashboard.operations as item}<div class="list-row"><Icon name={item.state === 'complete' && !item.error ? 'check' : item.state === 'running' ? 'clock' : 'warning'}/><div><strong>{operationNames[item.kind] ?? readable(item.kind)}</strong><p>{new Date(item.createdAt).toLocaleString()} · {readable(item.step ?? item.state)}</p>{#if item.error}<p class="amber">{readable(item.error, item.detail)}</p>{/if}</div><span class="badge" class:good={item.state === 'complete' && !item.error}>{readable(item.state)}</span><button class="button quiet" onclick={() => { selectedOperation = item.id; void run(() => go('progress')); }}>Details</button></div>{:else}<div class="card-body"><p class="muted">No operations have been recorded yet.</p></div>{/each}</section>
        {:else if screen === 'settings'}
          {@render heading('Manager settings', 'Local administration and recovery for this server.')}<section class="card"><div class="card-header"><h2>Access</h2></div><div class="list-row"><Icon name="user"/><div><strong>Local administrator</strong><p>{dashboard.administrator?.name} · Independent of photo accounts</p></div><button class="button quiet" onclick={() => showModal('administrator')}>Edit account</button></div><div class="list-row"><Icon name="lock"/><div><strong>{location.protocol === 'https:' ? 'HTTPS connection' : 'HTTP connection'}</strong><p>{dashboard.managerOrigin ?? location.origin}</p></div><span class="badge good">Enabled</span></div><div class="list-row"><Icon name="shield"/><div><strong>Protected session</strong><p>{location.protocol === 'https:' ? 'Secure cookies, CSRF protection and sign-in rate limits' : 'HTTP is unencrypted. Your session stays in this page; reload requires sign-in. CSRF protection and sign-in rate limits remain enabled.'}</p></div><button class="button quiet" disabled={busy} onclick={() => run(signOut)}>Sign out</button></div></section><section class="card mt16"><div class="card-header"><h2>Appearance</h2></div><div class="list-row"><Icon name="sun"/><div><strong>Theme</strong><p>Frameleaf’s approved light and dark palettes</p></div><div class="segmented">{#each ['dark', 'light'] as item}<button aria-pressed={theme === item} onclick={() => theme = item}>{item === 'dark' ? 'Dark' : 'Light'}</button>{/each}</div></div></section><section class="card mt16"><div class="card-header"><h2>Recovery & configuration</h2></div><div class="list-row"><Icon name="document"/><div><strong>Configuration export</strong><p>Export the managed project and secrets for manual recovery.</p></div><button class="button quiet" disabled={!installation} onclick={() => showModal('export')}>Export</button></div><div class="list-row"><Icon name="restore"/><div><strong>Recover Manager</strong><p>Replace only the Manager container and reconnect its persisted state.</p></div><button class="button quiet" onclick={() => showModal('recovery')}>View procedure</button></div></section>
        {/if}
        {/if}
{/snippet}
{#snippet commonImportReview(back: () => void, cancel?: () => void)}
            {@render heading('Review library import', review.downtime)}
            <form class="card" onsubmit={(event) => { event.preventDefault(); void run(startCommonImport); }}>
              <div class="card-header"><h2>Reviewed library</h2><span class="badge">{photoAppName(review.commonImport.source, review.commonImport.source)} {sourceVersion(review.commonImport.source, review.commonImport.version)}</span></div>
              <div class="card-body">
                <p>{review.commonImport.summary.assets} photos and videos · {review.commonImport.summary.albums} albums · {review.commonImport.summary.owners} accounts</p>
                <p class="meta mt16">Media space required: {formatBytes(review.commonImport.requiredMediaBytes)}</p>
                {#if review.commonImport.summary.preservationDifferences}
                  <p class="meta mt16">Preservation differences recorded: {review.commonImport.summary.preservationDifferences}</p>
                {/if}
                <p class="meta mt16">{review.recovery}</p>
                {#if review.commonImport.requiresBootstrap}
                  {#if location.protocol !== 'https:'}
                    <div class="mt16">{@render notice('Secure connection required', 'Open Manager over HTTPS to set the destination administrator password.', 'warning')}</div>
                  {:else}
                    <h3 class="mt16">Destination administrator</h3>
                    {@render importAdministratorFields()}
                  {/if}
                {/if}
                <label class="check-row mt24"><input type="checkbox" bind:checked={cutoverAccepted}/><span>I’ve reviewed the transfer and recovery information.</span></label>
              </div>
              <div class="card-footer">
                <div class="actions"><button type="button" class="button quiet" onclick={back}><Icon name="back"/>Back</button>{#if cancel}<button type="button" class="button quiet" disabled={busy} onclick={cancel}>Cancel import</button>{/if}</div>
                <button class="button primary" disabled={busy || !cutoverAccepted || (!!activeOperation && (activeOperation.id !== review.id || activeOperation.state !== 'awaiting-review')) || (review.commonImport.requiresBootstrap && location.protocol !== 'https:')}>Start import</button>
              </div>
            </form>
{/snippet}
{#snippet photoAppPicker()}
  <section class="card photo-apps mt24" aria-labelledby="photo-apps-title">
    <div class="card-header"><h2 id="photo-apps-title">Import from another photo app</h2><span class="badge warning">Beta</span></div>
    <div class="card-body">
      <p class="muted">Imports from other apps are new. Manager reads your library and leaves the original app’s photos and data untouched.</p>
      <div class="photo-app-list" role="radiogroup" aria-label="Photo apps you can import">
        {#each photoApps as app (app.container)}
          <label class="radio-card" class:unavailable={!app.importable}>
            <input type="radio" name="photo-app" bind:group={photoAppChoice} value={app.container} disabled={!app.importable}/>
            <div>
              <div class="spread"><strong>{photoAppName(app.kind, app.name ?? app.kind)}</strong><span class="badge">{photoAppDetail(app)}</span></div>
              {#if app.name && app.name.toLowerCase() !== photoAppName(app.kind, '').toLowerCase()}<p>{app.name}</p>{/if}
              {#if !app.importable}<p class="photo-app-reason">{photoAppReason(app)}</p>{/if}
            </div>
          </label>
        {/each}
        <label class="radio-card">
          <input type="radio" name="photo-app" bind:group={photoAppChoice} value={ENTE_CHOICE}/>
          <div>
            <div class="spread"><strong>Ente Photos</strong><span class="badge">Export folder</span></div>
            <p>Import a folder you export with Ente’s own command-line tool. Works with ente.io and self-hosted Ente.</p>
          </div>
        </label>
      </div>
      {#if enteChosen}{@render enteSteps()}{/if}
    </div>
    <div class="card-footer">
      <button class="text-button" disabled={busy} onclick={() => run(async () => { await Promise.all([loadSources(), loadPhotoApps()]); })}>Look again</button>
      {#if enteChosen}
        <button class="button primary" disabled={busy || !!activeOperation || !enteFolder.trim()} onclick={() => run(startEnteFolder)}>Continue</button>
      {:else}
        <button class="button primary" disabled={busy || !!activeOperation || !photoAppChosen} onclick={() => showModal('photo-app-capture')}>{photoAppChosen ? `Import from ${photoAppName(photoAppChosen.kind)}` : 'Import'}</button>
      {/if}
    </div>
  </section>
{/snippet}
{#snippet command(text: string)}
  <div class="command-row"><code>{text}</code><button type="button" class="button quiet" aria-label={`Copy: ${text}`} onclick={() => copyCommand(text)}>Copy</button></div>
{/snippet}

{#snippet enteSteps()}
  <div class="ente-steps" aria-labelledby="ente-steps-title">
    <h3 id="ente-steps-title">Three steps to bring Ente Photos across</h3>
    <p class="muted">Manager never asks for your Ente password. You export your library with Ente’s own tool, then Manager reads the folder.</p>
    <ol class="ente-step-list">
      <li>
        <span class="ente-step-number" aria-hidden="true">1</span>
        <div>
          <strong>Export your library</strong>
          <p>On a computer where Ente’s command-line tool is signed in to your account, run:</p>
          {@render command('ente photos export ente-export')}
        </div>
      </li>
      <li>
        <span class="ente-step-number" aria-hidden="true">2</span>
        <div>
          <strong>Save the list of your files</strong>
          <p>This tells Manager which photos are yours. Run it in the same place:</p>
          {@render command('ente photos file list --all --json > ente-export/ente-files.json')}
        </div>
      </li>
      <li>
        <span class="ente-step-number" aria-hidden="true">3</span>
        <div>
          <strong>Tell Manager where the export is</strong>
          <p>Put the ente-export folder somewhere Manager can reach{#if dashboard?.storageRoots?.length}, inside {dashboard.storageRoots.join(' or ')}{/if}, then enter its full path.</p>
          <label class="field ente-folder"><span>Folder path</span><input bind:value={enteFolder} placeholder="/mnt/user/photos/ente-export" autocomplete="off" spellcheck="false"/><small>Manager only reads this folder and never changes it.</small></label>
        </div>
      </li>
    </ol>
    <p class="muted">Only photos and videos you own come across. Anything other people shared with you stays in their library.</p>
  </div>
{/snippet}

{#snippet photoAppReview()}
  {@const inspection = photoAppInspection}
  {@render heading(`Review your ${photoAppLabel} library`, 'Nothing has been imported yet. Check what comes across, then choose where your library goes.')}
  <div class="photo-app-review">
    {@render notice('Beta: imports from other apps are new', photoAppFolder ? 'Manager only reads your export folder and never changes it. Your Ente account isn’t touched.' : `Manager leaves ${photoAppLabel}’s photos and data untouched. ${photoAppLabel} stays stopped until the import finishes, or starts again if you cancel.`, 'warning', 'info')}
    {#if !inspection.tested}
      <section class="card untested-notice" aria-labelledby="untested-title">
        <div class="card-body">
          <div class="row"><Icon name="warning"/><h2 id="untested-title">This version hasn’t been tested</h2></div>
          <p>{untestedNotice(photoAppKind, inspection.source?.version, inspection.testedVersion)}</p>
          {#if !photoAppUntestedAccepted}
            <div class="actions"><button class="button primary" onclick={() => (photoAppUntestedAccepted = true)}>Continue anyway</button><button class="button quiet" disabled={busy} onclick={() => showModal('photo-app-cancel', photoAppOperation)}>Cancel import</button></div>
          {/if}
        </div>
      </section>
    {/if}
    {#if photoAppUntestedAccepted}
      <section class="card" aria-labelledby="photo-app-summary">
        <div class="card-header"><h2 id="photo-app-summary">What Manager found</h2><span class="badge">{photoAppLabel}{sourceVersion(photoAppKind, inspection.source?.version) ? ' ' + sourceVersion(photoAppKind, inspection.source?.version) : ''}</span></div>
        <div class="card-body"><div class="mini-stats">
          <div><strong>{inspection.summary.assets.toLocaleString()}</strong><small>Photos & videos</small></div>
          <div><strong>{inspection.summary.albums.toLocaleString()}</strong><small>{inspection.summary.albums === 1 ? 'Album' : 'Albums'}</small></div>
          <div><strong>{inspection.summary.owners.toLocaleString()}</strong><small>{inspection.summary.owners === 1 ? 'Account' : 'Accounts'}</small></div>
          <div><strong>{formatBytes(Number(inspection.summary.bytes))}</strong><small>Size</small></div>
        </div></div>
      </section>
      <section class="card" aria-labelledby="photo-app-losses">
        <div class="card-header"><h2 id="photo-app-losses">What won’t come across</h2>{#if inspection.losses.length}<span class="badge warning">{plural(inspection.losses.length, 'item')}</span>{/if}</div>
        {#if inspection.losses.length}
          <ul class="loss-list">{#each inspection.losses as loss (loss.code)}<li><Icon name="info"/><span>{lossText(loss.code, photoAppKind)}</span>{#if loss.count > 1}<span class="badge">{loss.count.toLocaleString()} affected</span>{/if}</li>{/each}</ul>
          <div class="card-body"><label class="check-row"><input type="checkbox" bind:checked={photoAppLossesAccepted}/><span>I understand these details won’t come across to Frameleaf.</span></label></div>
        {:else}<div class="card-body"><p class="muted">Everything Manager found comes across.</p></div>{/if}
      </section>
      <section class="card" aria-labelledby="photo-app-accounts">
        <div class="card-header"><div><h2 id="photo-app-accounts">Accounts</h2><p class="meta">Each account becomes a Frameleaf account. People sign in with the email address you give it here.</p></div><span class="badge">{plural(photoAppOwners.length, 'account')}</span></div>
        <div class="table-wrap"><table class="account-table">
          <thead><tr><th>{photoAppLabel} account</th><th>Photos & videos</th><th>Frameleaf email</th></tr></thead>
          <tbody>{#each photoAppOwners as owner (owner.sourceId)}
            {@const problem = photoAppProblems[owner.sourceId]}
            <tr>
              <td><strong>{owner.name}</strong>{#each owner.restrictions as restriction}<small class="amber">{restrictionText(restriction, photoAppKind)}</small>{/each}
                {#if owner.restrictions.length}<label class="check-row mt16"><input type="checkbox" bind:checked={owner.acknowledged}/><span>Import {owner.name}’s account anyway</span></label>{/if}</td>
              <td>{owner.assets.toLocaleString()}</td>
              <td><label class="field"><input type="email" aria-label={`Email for ${owner.name}`} bind:value={owner.email} required maxlength="254" autocomplete="off" spellcheck="false" aria-invalid={!!problem}/>{#if problem}<small class="field-error">{problem}</small>{/if}</label></td>
            </tr>
          {/each}</tbody>
        </table></div>
      </section>
      <div>{@render configuration()}</div>
      {#if checking}<p class="muted checking-note" role="status">Checking your library and this server. This can take a few minutes.</p>{/if}
    {/if}
  </div>
  <div class="wizard-footer"><button class="button quiet" disabled={busy} onclick={() => showModal('photo-app-cancel', photoAppOperation)}>Cancel import</button>{#if photoAppUntestedAccepted}<button class="button primary" disabled={busy || !photoAppReady || !mediaPath || !tag || !lifecycle} aria-busy={checking} onclick={() => run(preparePhotoApp)}>{#if checking}<span class="spinner" aria-hidden="true"></span>Checking…{:else}Check and review import{/if}</button>{/if}</div>
{/snippet}
{#snippet folderField(label: string, help: string, value: string, set: (value: string) => void, key: 'media' | 'database' | 'backups')}
  <div class="field full"><span>{label}</span><div class="folder-field"><input aria-label={label} {value} oninput={(event) => set(event.currentTarget.value)} required autocomplete="off" spellcheck="false"/><button type="button" class="button quiet" onclick={() => (browsing = key)}>Browse…</button></div><small>{help}</small></div>
{/snippet}
{#snippet externalFolderSection()}
  {#if dashboard?.folderSetup}<ExternalFolders bind:mounts={containers['frameleaf-server'].mounts} occupied={installation ? [dashboard.folderSetup.media, dashboard.folderSetup.database, dashboard.folderSetup.backups, dashboard.folderSetup.manager] : [mediaPath, databaseRoot, backupPath, dashboard.folderSetup.manager]} {api} saving={installation ? { dirty: containers['frameleaf-server'].mounts !== containerText(containersSaved)['frameleaf-server'].mounts, disabled: busy || !!activeOperation, save: () => run(saveContainerSettings), discard: () => run(loadContainerSettings) } : null}/>{/if}
{/snippet}
{#snippet advancedContainers()}
  <details class="card mt16 containers" bind:open={containersOpen}>
    <summary class="card-header"><div><h2>Advanced container settings</h2><p class="meta">{containerRows.length ? containerRows.map((row) => `${row.label}: ${row.summary || 'needs attention'}`).join(' · ') : 'Environment variables, extra folders and limits for each container. Optional.'}</p></div><Icon name="chevron"/></summary>
    {#each CONTAINERS.filter((container) => containersMl || container.id !== 'frameleaf-machine-learning') as container (container.id)}
      {@const parsed = parseContainerSettings(containers[container.id])}
      <section class="card-body container" aria-labelledby={`container-${container.id}`}>
        <h3 id={`container-${container.id}`}>{container.label} <code>{container.id}</code></h3><p class="meta">{container.about}</p>
        <div class="form-grid mt16">
          <label class="field"><span>Environment variables</span><textarea class="settings-editor short" rows="3" spellcheck="false" placeholder={'TZ=America/Toronto\nIMMICH_LOG_LEVEL=verbose'} bind:value={containers[container.id].environment}></textarea></label>
          <label class="field"><span>Extra folders</span><textarea class="settings-editor short" rows="3" spellcheck="false" placeholder="/mnt/user/archive:/archive:ro" bind:value={containers[container.id].mounts}></textarea></label>
          <label class="field"><span>Memory limit</span><input placeholder="No limit · e.g. 4g" bind:value={containers[container.id].memory}/></label>
          <label class="field"><span>CPU limit</span><input inputmode="decimal" placeholder="No limit · e.g. 2" bind:value={containers[container.id].cpus}/></label>
        </div>
        {#if parsed.errors.length}<ul class="field-error container-errors" role="alert">{#each parsed.errors as message}<li>{message}</li>{/each}</ul>{/if}
      </section>
    {/each}
    <div class="disclosure"><p>One entry per line. Manager keeps these settings when it updates Frameleaf. The database connection, ports and library folders come from {installation ? 'the installation' : 'this setup'}; passwords and tokens never go here.</p>{#if installation}<p>Saving rewrites the stack and restarts the containers whose settings changed. Photo access pauses for about a minute; Manager records each step.</p><div class="actions mt16"><button class="button primary" disabled={busy || !!activeOperation} onclick={() => run(saveContainerSettings)}>Save and restart Frameleaf</button><button class="button quiet" disabled={busy} onclick={() => run(loadContainerSettings)}>Discard changes</button></div>{/if}</div>
  </details>
{/snippet}
{#snippet containerReview()}
  {#if containerRows.length}<section class="card mt16"><div class="card-header"><h2>Advanced container settings</h2></div>{#each containerRows as row (row.id)}<div class="list-row"><Icon name="settings"/><div><strong>{row.label}</strong><p>{row.summary}</p></div></div>{/each}</section>{/if}
{/snippet}
{#snippet configuration()}
  <form id="configuration-form" onsubmit={(event) => { event.preventDefault(); if (screen === 'photo-app') void run(preparePhotoApp); else if (screen === 'fresh') void run(recheckInstall); }}>
  <section class="card"><div class="card-header"><h2>Storage & access</h2></div><div class="card-body"><div class="form-grid">
    <label class="field full"><span>Library name</span><input bind:value={libraryName} required maxlength="120"/></label>
    {#if kind === 'install' || screen === 'photo-app'}{#if dashboard.folderSetup}{@render folderField('Photos and videos', 'Your uploads and library. Manager creates this folder if it isn’t there.', mediaPath, (value) => (mediaPath = value), 'media')}{:else}<label class="field full"><span>Media location</span><select bind:value={mediaPath} required><option value="">Choose a mounted folder</option>{#each dashboard.storageRoots as root}<option value={root}>{root}</option>{/each}</select><small>{screen === 'photo-app' ? `Frameleaf keeps your imported library and new uploads here. ${photoAppLabel}'s own folders aren’t changed.` : 'Originals and generated media remain in this mounted location.'}</small></label>{/if}{/if}
    {#if dashboard.folderSetup}{@render folderField('Database', 'Best on a fast drive. Manager creates this folder if it isn’t there.', databaseRoot, (value) => (databaseRoot = value), 'database')}{@render folderField('Backups', 'Encrypted database backups. Photos and videos aren’t included.', backupPath, (value) => (backupPath = value), 'backups')}{:else}<label class="field"><span>PostgreSQL appdata location</span><input bind:value={databaseRoot} list="database-roots" required autocomplete="off" spellcheck="false"/><small>New dedicated host-disk storage, outside Docker’s virtual disk.</small></label>{/if}<label class="field"><span>Frameleaf port</span><input type="number" bind:value={port} min="1024" max="65535" required/><small>{kind === 'import' ? 'You can keep the original app’s port; it is stopped before Frameleaf starts. ' : ''}{#each otherInstallations.filter((i: any) => i.appPort) as other}{other.name} uses port {other.appPort}.{' '}{/each}Manager remains on its own port.</small></label>
    <label class="field"><span>Frameleaf release</span><select bind:value={tag} required><option value="">Select a verified release</option>{#each releases as release}<option value={release.tag}>{release.tag}</option>{/each}</select>{#if !releases.length}<small>No eligible signed release was offered. Refresh releases or check distribution availability.</small>{/if}</label>{#if !dashboard.folderSetup}<label class="field"><span>Database backup destination</span><input value={dashboard.backupRoot} readonly/><small>Mounted encrypted database backups only.</small></label>{/if}
    {#if dashboard.databaseStorage.detectedPath && !dashboard.folderSetup}<p class="meta full">Detected Unraid appdata: <code>{dashboard.databaseStorage.detectedPath}</code>. To use another disk, map its folder into Manager and add it to the database roots.</p>{/if}
  </div></div></section><section class="card mt16"><div class="card-header"><h2>Processing</h2></div><div class="list-row"><Icon name="cpu"/><div><strong>{processorName(dashboard.host?.acceleration)}</strong><p>{hasGpu(dashboard.host?.acceleration) ? 'Detected on this server. Machine learning will use it.' : 'No supported graphics card detected. Machine learning runs on the CPU.'}</p></div><span class="badge" class:good={hasGpu(dashboard.host?.acceleration)}>{hasGpu(dashboard.host?.acceleration) ? 'Detected' : 'Default'}</span></div><div class="list-row"><Icon name="image"/><div><strong>Machine learning</strong><p>Face recognition and smart search</p></div><label class="toggle"><input type="checkbox" bind:checked={ml}/><span class="toggle-track"></span><span>Enable</span></label></div></section>{@render externalFolderSection()}{@render advancedContainers()}<label class="check-row mt24"><input type="checkbox" bind:checked={lifecycle}/><span>Docker or Unraid manages startup. I have disabled any additional scheduler or service that recreates these containers.</span></label>
  </form>
{/snippet}
<datalist id="database-roots">{#each dashboard?.databaseStorage?.roots ?? [] as root}<option value={root}></option>{/each}</datalist>
{#if browsing}<FolderPicker title={{ media: 'Choose where photos and videos go', database: 'Choose the database folder', backups: 'Choose the backups folder' }[browsing]} start={{ media: mediaPath, database: databaseRoot, backups: backupPath }[browsing] || '/mnt'} {api} use={(path) => { if (browsing === 'media') mediaPath = path; else if (browsing === 'database') databaseRoot = path; else backupPath = path; browsing = ''; const recheck = recheckAfterPick; recheckAfterPick = null; if (recheck) void run(recheck); }} close={() => { browsing = ''; recheckAfterPick = null; }}/>{/if}
<dialog bind:this={dialog} aria-labelledby="dialog-title" onclose={() => { password = ''; newPassword = ''; modal = ''; }}>
  <button class="button quiet icon-button modal-close" onclick={closeModal} aria-label="Close dialog"><Icon name="close"/></button>
  <div class="modal-body"><h2 id="dialog-title">{({ control: modalAction === 'stop' ? 'Stop your photo library' : 'Restart your photo library', update: 'Update Frameleaf', recover: 'Recover the saved operation', administrator: 'Secure your Manager', export: 'Export configuration', 'backup-key': 'Export recovery key', recovery: 'Recover Manager', 'skip-setup': 'Skip setup and let the server run?', 'source-recovery': 'Returning to your original app', 'add-installation': 'Add another installation', help: 'Frameleaf Manager guide', 'photo-app-capture': `Stop ${photoAppName(photoAppChosen?.kind)} for the import?`, 'photo-app-cancel': 'Cancel this import?' } as Record<string, string>)[modal]}</h2>
    {#if error}<p class="amber mt16" role="alert">{error}</p>{/if}
    {#if modal === 'control'}<p class="mt16">Photo access and background processing will pause. Manager stays available to manage the recorded operation.</p>
    {:else if modal === 'update'}<p class="mt16">Manager rechecks eligibility, downloads compatible images and creates a database recovery point before applying this release.</p><p class="meta mt16">{updateReview?.recovery}</p>
    {:else if modal === 'skip-setup'}<p class="mt16">Frameleaf starts the work setup was holding and stops asking you to finish. Your library keeps preparing in the background, and anything that needs a look stays in Library Care. You can connect your phone at any time.</p>
    {:else if modal === 'recover'}<p class="mt16">Manager will reconcile the saved step and retain recovery files. A database backup does not reverse media changes.</p>
    {:else if ['administrator', 'export', 'backup-key'].includes(modal)}<form id="credential-form" onsubmit={(event) => { event.preventDefault(); void run(credentialAction); }}>
      {#if modal === 'administrator'}<label class="field"><span>Administrator name</span><input bind:value={name} required maxlength="120" autocomplete="name"/></label>{:else}<p class="mt16">This download contains recovery secrets. Store it privately, separately from the server.</p>{/if}<label class="field"><span>Current Manager password</span><input type="password" bind:value={password} required maxlength="256" autocomplete="current-password"/></label>{#if modal === 'administrator'}<label class="field"><span>New password (optional)</span><input type="password" bind:value={newPassword} minlength="14" maxlength="256" autocomplete="new-password"/><small>Leave empty to keep your password. Previous sessions are signed out after saving.</small></label>{/if}
    </form>
    {:else if modal === 'recovery'}<ol class="timeline mt16">{#each [['Keep the existing state folder', 'Preserve the Manager journal, configuration and recovery keys.'], ['Stop and replace only Manager', 'Use a verified image with the same exact bind mappings, Manager origin and Docker socket.'], ['Sign in and review the journal', 'An unfinished operation appears as interrupted. Resume only after reviewing its saved step.'], ['Use the protected configuration export if necessary', 'Recover the photo stack with its recorded Compose project. Keep secrets private; media recovery is separate.']] as [title, detail], index}<li><span class="stage-icon">{index + 1}</span><div><strong>{title}</strong><p>{detail}</p></div></li>{/each}</ol>
    {:else if modal === 'source-recovery'}<p class="mt16">Your original database is retained. After Frameleaf writes to shared media, restarting the original app requires a separate recovery review.</p><div class="mt16">{@render notice('Database recovery does not restore media', 'Keep both applications stopped while checking the matching database and media. Manager does not automatically restore files or restart the original source.', 'warning', 'warning')}</div>
    {:else if modal === 'add-installation'}<p class="mt16">Each Frameleaf installation on this server has its own Manager, photo library and database backups. They don’t share accounts or photos.</p><ol class="timeline mt16">{#each [['Install Frameleaf Manager again', dashboard?.host?.platform === 'unraid' ? 'In Unraid Apps, install Frameleaf Manager again and give it a new name.' : 'Use the same installer as before, with a new container name.'], ['Choose a new Manager port', `For example ${nextManagerPort}. This Manager keeps its own port.`], ['Choose separate folders', 'Give it its own state, photo and backup folders. The appdata folder can be shared.'], ['Open the new Manager', 'Create its administrator, then set up or import its library.']] as [title, detail], index}<li><span class="stage-icon">{index + 1}</span><div><strong>{title}</strong><p>{detail}</p></div></li>{/each}</ol>
    {:else if modal === 'photo-app-capture'}<p class="mt16">{photoAppName(photoAppChosen?.kind)} stays stopped while Manager reads its library and, once you approve, imports it into Frameleaf. Stopping it means nothing changes part-way through.</p><p class="mt16">Your photos and {photoAppName(photoAppChosen?.kind)}’s own data are left as they are. Nothing is imported until you’ve reviewed it, and if you cancel before the import starts, Manager starts {photoAppName(photoAppChosen?.kind)} again.</p>
    {:else if modal === 'photo-app-cancel'}<p class="mt16">{#if photoAppFolder}Manager discards what it read. Nothing is imported, and your export folder stays as it is.{:else}Manager discards what it read and starts {photoAppLabel === 'your photo app' ? 'your photo app' : photoAppLabel} again. Nothing is imported, and its photos and data stay as they were.{/if}</p>
    {:else if modal === 'help'}<p class="mt16">Set up a new library, import a supported photo installation, or restore an encrypted database recovery point. Review every configuration before starting.</p><ul class="checklist"><li><Icon name="server"/>Services: lifecycle controls and sanitized logs</li><li><Icon name="drive"/>Storage: mounted capacity and exact media mappings</li><li><Icon name="shield"/>Backups: database recovery points and key export</li><li><Icon name="update"/>Updates: verified eligibility and recovery checkpoint</li><li><Icon name="activity"/>Activity: saved journal, retry and recovery</li></ul>{/if}
  </div>
  <div class="modal-footer"><button class="button quiet" onclick={closeModal}>{modal === 'photo-app-cancel' ? 'Keep import' : 'Cancel'}</button>{#if modal === 'photo-app-capture'}<button class="button primary" disabled={busy || !photoAppChosen} onclick={() => run(capturePhotoApp)}>Stop {photoAppName(photoAppChosen?.kind)} and continue</button>{:else if modal === 'photo-app-cancel'}<button class="button danger" disabled={busy} onclick={() => run(() => cancelPhotoApp(modalAction))}>Cancel import</button>{:else if modal === 'control'}<button class="button danger" disabled={busy} onclick={() => run(() => control(modalAction))}>{modalAction === 'stop' ? 'Stop services' : 'Restart services'}</button>{:else if modal === 'update'}<button class="button primary" disabled={busy} onclick={() => run(() => start('update', { id: updateReview.id }))}>Update Frameleaf</button>{:else if modal === 'recover'}<button class="button danger" disabled={busy} onclick={() => run(async () => { await api('recover', { id: operation.id }); await refresh(); closeModal(); })}>Confirm recovery</button>{:else if modal === 'skip-setup'}<button class="button primary" disabled={busy} onclick={() => run(async () => { const result = await api('skip-setup', {}); await refresh(); closeModal(); await go('overview'); if (result?.dismissed === false) notify('Setup is finished in Manager. This Frameleaf version keeps preparing your library in its own time; update Frameleaf to start held work at once.'); })}>Skip setup</button>{:else if ['administrator', 'export', 'backup-key'].includes(modal)}<button class="button primary" type="submit" form="credential-form" disabled={busy}>{modal === 'administrator' ? 'Save account' : 'Download'}</button>{:else}<button class="button primary" onclick={closeModal}>Done</button>{/if}</div>
</dialog>
<div id="toast" role="status" aria-live="polite" class:visible={!!toast}>{toast}<button class="button quiet icon-button" onclick={() => toast = ''} aria-label="Dismiss notification"><Icon name="close"/></button></div>
