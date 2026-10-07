<script lang="ts">
  import { onMount, tick } from 'svelte';
  import Icon from './Icon.svelte';
  import { encodeQr, qrPath } from './qr.mjs';
  import { regenerationPresentation } from './regeneration';
  import { operationNames, operationProgress, canCancel, serviceState, readable, formatBytes } from './presentation';

  let csrf = '',
    claimed = $state(false),
    signedIn = $state(false),
    loading = $state(true),
    busy = $state(false);
  let error = $state(''),
    disconnected = $state(false),
    toast = $state('');
  let password = $state(''),
    name = $state(''),
    proof = $state(''),
    newPassword = $state('');
  let screen = $state('welcome'),
    menu = $state(false),
    accountMenu = $state(false),
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
    tag = $state(''),
    review = $state<any>(null);
  let libraryName = $state('Home library');
  let kind = $state<'install' | 'import'>('install'),
    step = $state(0),
    mediaPath = $state(''),
    databaseRoot = $state(''),
    port = $state(2283),
    ml = $state(false);
  let lifecycle = $state(false),
    mappingsAccepted = $state(false),
    cutoverAccepted = $state(false),
    restoreAccepted = $state(false);
  let backupStatus = $state({ configured: false, unlocked: false, keyAvailable: false });
  let recoveryKey = $state(''),
    snapshot = $state(''),
    restoreReview = $state<any>(null),
    updateReview = $state<any>(null);
  let firstName = $state(''),
    lastName = $state(''),
    email = $state(''),
    account = $state('local');
  let logs = $state(''),
    logService = $state(''),
    theme = $state('dark');
  let page: HTMLElement,
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
    import: 'Immich import',
    fresh: 'New installation',
    restore: 'Restore backup',
    progress: 'Operation in progress',
    success: 'Server ready',
    profile: 'Your details',
    downloads: 'Get the app',
    phone: 'Library preparation',
    'setup-complete': 'Setup complete',
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
  const setupScreens = [
    'import',
    'fresh',
    'restore',
    'progress',
    'success',
    'profile',
    'downloads',
    'phone',
    'setup-complete',
  ];
  const installation = $derived(dashboard?.installation);
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
      ? ['Installation', 'Library & settings', 'Import']
      : ['Installation', 'Library & settings', 'Database backup', 'Import'],
  );
  const lastImportStep = $derived(importSteps.length - 1);
  const availableUpdates = $derived(releases.filter((item) => item.tag !== installation?.release));
  const latestBackup = $derived(snapshots[0]);

  function qrSvg(url: string) {
    const code = encodeQr(url);
    return `<svg class="download-qr" viewBox="0 0 ${code.size + 8} ${code.size + 8}" role="presentation"><rect width="100%" height="100%" fill="white"/><path d="${qrPath(code.modules)}" fill="#101416"/></svg>`;
  }
  function notify(message: string) {
    toast = message;
  }
  async function api(path: string, body?: unknown) {
    const response = await fetch(`/manager-api/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json();
    if (!response.ok) {
      if (response.status === 401 && value.code === 'sign_in_required') {
        signedIn = false;
        dashboard = null;
        csrf = '';
        password = '';
        recoveryKey = '';
        dialog?.close();
      }
      throw new Error(value.code ?? 'request_failed');
    }
    if (value.csrf) csrf = value.csrf;
    return value;
  }
  async function run(work: () => Promise<void>) {
    if (busy) return;
    busy = true;
    error = '';
    try {
      await work();
    } catch (e) {
      error = e instanceof Error ? readable(e.message) : 'Could not complete this request';
    } finally {
      busy = false;
    }
  }
  async function go(value: string) {
    screen = value;
    menu = false;
    accountMenu = false;
    error = '';
    await tick();
    page?.scrollTo({ top: 0 });
    document.querySelector<HTMLElement>('#main h1')?.focus();
    if (value === 'welcome' && !installation) await loadSources();
    if (value === 'backups') await loadBackups();
    if (value === 'updates') await loadReleases();
    if (['storage', 'overview', 'welcome'].includes(value)) {
      storage = await api('storage');
      if (installation && !backupsLoaded) await loadBackups();
    }
  }
  async function refresh() {
    const next = await api('dashboard');
    dashboard = next;
    disconnected = false;
    if (!bootstrapped) {
      databaseRoot = next.databaseStorage.suggestedPath;
      name = next.administrator?.name ?? '';
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
      if (screen === 'backups' || screen === 'overview') await loadBackups();
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
  async function loadReleases() {
    releases = await api('releases');
    releasesLoaded = true;
  }
  async function loadBackups() {
    const result = await api('backup-status');
    backupStatus = result;
    snapshots = result.snapshots;
    backupsLoaded = true;
  }
  async function signIn() {
    await api(claimed ? 'login' : 'claim', claimed ? { password } : { password, name, proof });
    password = '';
    proof = '';
    claimed = true;
    signedIn = true;
    await refresh();
    await go(activeOperation ? 'progress' : installation ? 'overview' : 'welcome');
  }
  async function signOut() {
    await api('logout', {});
    signedIn = false;
    dashboard = null;
    csrf = '';
    password = '';
    recoveryKey = '';
    logs = '';
    accountMenu = false;
    bootstrapped = false;
    requests.clear();
  }
  async function choose(value: 'install' | 'import') {
    kind = value;
    step = 0;
    review = null;
    sourceReview = null;
    mappingsAccepted = false;
    lifecycle = false;
    cutoverAccepted = false;
    await refresh();
    await loadReleases();
    tag = releases[0]?.tag ?? '';
    if (value === 'import') await loadSources();
    await go(value === 'install' ? 'fresh' : 'import');
  }
  async function inspectSource() {
    sourceReview = await api('source-review', { sourceId });
    sources = sources.map((item) => (item.id === sourceId ? sourceReview.source : item));
    step = 1;
  }
  async function prepare() {
    if (!document.querySelector<HTMLFormElement>('#configuration-form')?.reportValidity()) return;
    review = await api('review', {
      kind,
      tag,
      name: libraryName,
      ...(kind === 'import' ? { sourceId } : { mediaPath }),
      databaseRoot,
      port,
      ml,
      lifecycle: 'docker-only',
    });
    if (kind === 'install') step = 1;
    else step = lastImportStep;
  }
  async function start(path: string, body: Record<string, unknown>) {
    const identity = JSON.stringify([path, body]);
    let key = requests.get(identity);
    if (!key) {
      key = crypto.randomUUID();
      requests.set(identity, key);
    }
    const result = await api(path, { ...body, key });
    requests.delete(identity);
    selectedOperation = result.id;
    await refresh();
    await go('progress');
    dialog?.close();
  }
  async function control(action: string) {
    await start('control', { action });
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
    restoreReview = await api('review-restore', { snapshot, databaseRoot });
    step = 2;
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
  async function download(path: string, filename: string, body: unknown) {
    const response = await fetch(`/manager-api/${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error((await response.json()).code ?? 'download_failed');
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    closeModal();
    notify('Download complete. Keep recovery files private.');
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
      try {
        await refresh();
        signedIn = true;
        await go(activeOperation ? 'progress' : installation ? 'overview' : 'welcome');
      } catch (e) {
        if (!(e instanceof Error && e.message === 'sign_in_required')) throw e;
      }
    }).finally(() => (loading = false));
    const timer = setInterval(() => {
      if (signedIn && !document.hidden && !busy)
        void refresh().catch((e) => {
          disconnected = true;
          if (!signedIn) error = 'Your session expired. Sign in to continue.';
        });
    }, 10_000);
    return () => clearInterval(timer);
  });
  $effect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('frameleaf-manager-theme', theme);
    } catch {}
  });
</script>

{#snippet heading(title: string, subtitle: string)}
  <div class="page-heading"><div class="spread"><h1 tabindex="-1">{title}</h1></div><p>{subtitle}</p></div>
{/snippet}
{#snippet steps(items: string[], current: number)}
  <ol class="steps" aria-label="Setup progress">{#each items as item, index}<li class:active={index === current} class:complete={index < current} aria-current={index === current ? 'step' : undefined}><span class="step-number">{#if index < current}<Icon name="check" />{:else}{index + 1}{/if}</span><span>{item}</span></li>{/each}</ol>
{/snippet}
{#snippet notice(title: string, detail: string, type = 'good', icon = 'shield')}
  <div class="notice {type}"><Icon name={icon}/><div class="grow"><strong>{title}</strong><p>{detail}</p></div></div>
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

<svelte:head><title>Frameleaf Manager · {!signedIn ? 'Local administrator' : labels[screen]}</title><meta name="theme-color" content={theme === 'dark' ? '#101416' : '#f4f6f7'}/></svelte:head>
<a class="skip-link" href="#main">Skip to content</a>
<div class="shell" class:menu-open={menu} class:onboarding-layout={['profile', 'downloads', 'phone', 'setup-complete'].includes(screen)}>
  <header class="topbar"><button class="button quiet icon-button mobile-menu" onclick={() => menu = !menu} aria-label="Toggle navigation" aria-expanded={menu}><Icon name="menu"/></button>
    <button class="brand" onclick={() => signedIn && run(() => go(installation ? 'overview' : 'welcome'))} aria-label="Frameleaf Manager home"><img class="brand-dark" src="/assets/frameleaf-logo-white.svg" alt="Frameleaf"/><img class="brand-light" src="/assets/frameleaf-logo-light.svg" alt="Frameleaf"/><span class="brand-divider"></span><span class="brand-label">Manager</span></button>
    <span class="live-pill">Local management</span><div class="topbar-right"><button class="button quiet icon-button" onclick={() => theme = theme === 'dark' ? 'light' : 'dark'} aria-label="Toggle light or dark theme"><Icon name={theme === 'dark' ? 'sun' : 'moon'}/></button>
    {#if signedIn}<button class="row" onclick={() => accountMenu = !accountMenu} aria-label="Local administrator menu" aria-expanded={accountMenu}><span class="avatar"><Icon name="user"/></span><span class="local-account">{dashboard?.administrator?.name ?? 'Local admin'}</span></button>{/if}</div>
    {#if accountMenu}<div class="account-menu"><button onclick={() => run(() => go('settings'))}>Manager settings</button><button onclick={() => run(signOut)}>Sign out</button></div>{/if}
  </header>
  <div class="workspace"><button class="mobile-shade" onclick={() => menu = false} aria-label="Close navigation"></button>
    <aside class="sidebar"><div class="server-select"><Icon name="server"/><div><strong>{dashboard?.host?.name ?? 'This server'}</strong><small>{dashboard?.host?.platform ?? 'Local Docker'}</small></div></div>
      <nav aria-label="Manager">{#each navigation as group}<p class="nav-caption" class:separated={group.title !== 'Installation'}>{group.title}</p>{#each group.entries as [value, icon, label]}<button class="nav-item" class:active={screen === value || value === 'welcome' && setupScreens.includes(screen)} disabled={!signedIn || busy} aria-current={screen === value ? 'page' : undefined} onclick={() => run(() => go(value))}><Icon name={icon}/><span>{label}</span>{#if value === 'updates' && releasesLoaded && availableUpdates.length}<span class="nav-badge">{availableUpdates.length}</span>{/if}</button>{/each}{/each}</nav>
      <div class="sidebar-bottom"><button class="button quiet" onclick={() => showModal('help')}><Icon name="help"/>Manager guide</button><div class="server-foot"><span class="status-dot" class:offline={disconnected}></span>{dashboard?.host?.available === false ? 'Docker unavailable' : signedIn ? 'Local Manager connected' : 'Local management'}<p>Protected session · HTTPS</p></div></div>
    </aside>
    <div class="page-area"><div class="contextbar"><span>Manager</span><Icon name="chevron"/><strong>{!signedIn ? 'Local administrator' : labels[screen]}</strong><div class="context-actions">{#if signedIn}<button class="button quiet icon-button" disabled={busy} onclick={() => run(async () => { await refresh(); await go(screen); })} aria-label="Refresh Manager"><Icon name="update"/></button>{/if}</div></div>
      <div class="page-scroll" bind:this={page}><main id="main" class="page" aria-busy={busy}>
        {#if error}<div class="notice warning error-notice" role="alert"><Icon name="warning"/><div><strong>Action needed</strong><p>{error}</p></div></div>{/if}
        {#if disconnected}{@render notice('Connection interrupted', 'Manager could not refresh the server state. Reconnect and refresh before taking another action.', 'warning', 'network')}{/if}
        {#if loading}<div class="loading-state"><Icon name="loader" class="spin"/><p>Connecting to your Manager…</p></div>
        {:else if !signedIn}
          {@render heading(claimed ? 'Welcome back.' : 'Secure your Manager', claimed ? 'Sign in to manage this Frameleaf installation.' : 'Create the local administrator account used to manage this server.')}
          <form class="card" onsubmit={(event) => { event.preventDefault(); void run(signIn); }}><div class="card-header"><h2>Local administrator</h2></div><div class="card-body stack">
            {#if !claimed}<label class="field"><span>Administrator name</span><input bind:value={name} required maxlength="120" autocomplete="name"/></label><label class="field"><span>Claim key</span><input bind:value={proof} type="password" required autocomplete="off"/><small>Read the claim key from the private Manager state folder on your server.</small></label>{/if}
            <label class="field"><span>Password</span><input type="password" bind:value={password} required minlength={claimed ? 1 : 14} maxlength="256" autocomplete={claimed ? 'current-password' : 'new-password'}/><small>{claimed ? 'Your Manager account is independent of your photo account.' : 'Use at least 14 characters. No Frameleaf Cloud account is required.'}</small></label>
            {@render notice('Local HTTPS and a separate account', 'Manager stays available when the photo application is stopped.', 'good', 'lock')}
          </div><div class="card-footer"><span class="safety-note"><Icon name="shield"/>Protected local session</span><button class="button primary" disabled={busy}>{claimed ? 'Sign in' : 'Create administrator'}</button></div></form>
        {:else if activeOperation && !['progress', 'activity'].includes(screen)}
          <div class="notice warning operation-banner"><Icon name="clock"/><div class="grow"><strong>{operationNames[activeOperation.kind]}</strong><p>{activeOperation.state === 'running' ? 'Running in the background' : 'A saved operation needs attention before another operation can begin.'}</p></div><button class="button quiet" onclick={() => { selectedOperation = activeOperation.id; void run(() => go('progress')); }}>View operation</button></div>
        {/if}

        {#if !loading && signedIn}
        {#if screen === 'welcome'}
          {@render heading('Choose how to begin', 'Set up and look after Frameleaf from one place.')}
          {#if installation}{@render notice('Frameleaf is already installed', 'Manage this installation from Overview, or review a database recovery point in Backups.')}
            <div class="actions mt16"><button class="button primary" onclick={() => run(() => go('overview'))}>Open overview</button><button class="button quiet" onclick={() => run(() => go('backups'))}>View backups</button></div>
          {:else}
            {#if sources.length}<section class="card detected-card"><div class="card-body"><div class="detected-label"><Icon name="check"/>FOUND ON THIS SERVER</div><div class="feature-row"><div class="icon-tile green-tile"><Icon name="import"/></div><div class="feature-copy"><h2>Bring your Immich library</h2><p>Import your accounts, albums, and settings. Keep your photos and external libraries exactly where they are.</p></div><span class="badge">{sources.length === 1 ? 'Immich ' + sources[0].version : sources.length + ' installations'}</span></div>{#if sources.length === 1}<div class="mini-stats"><div><strong>{sources[0].summary.assets.toLocaleString()}</strong><small>Photos & videos</small></div><div><strong>{sources[0].summary.users}</strong><small>People</small></div><div><strong>{sources[0].summary.albums}</strong><small>Albums</small></div><div><strong>{sources[0].mounts.filter((item: any) => item.readOnly).length}</strong><small>Read-only mappings</small></div></div>{/if}</div><div class="card-footer"><span class="safety-note"><Icon name="folder"/>Existing media locations preserved</span><button class="button primary" disabled={busy || !!activeOperation} onclick={() => run(() => choose('import'))}>Review import</button></div></section>
            {:else}<section class="card"><div class="card-body"><div class="row mb16"><Icon name="import"/><h2>{discoveryLoaded ? 'No supported Immich installation found' : 'Find your existing library'}</h2></div><p class="muted">Manager detects installations through the host Docker engine. Review discovered sources before making any change.</p><button class="button quiet mt16" disabled={busy} onclick={() => run(loadSources)}>Find installations</button></div></section>{/if}
            {#if refused.length}<div class="notice warning mt16"><Icon name="warning"/><div><strong>Some installations need attention</strong>{#each refused as item}<p>{readable(item.code)}</p>{/each}</div></div>{/if}
            <p class="section-label">Or start another way</p><div class="two-cols"><section class="card option-card"><div class="card-body"><div class="icon-tile"><Icon name="plus"/></div><h2>Set up a new library</h2><p>Choose your storage and let Manager prepare a fresh Frameleaf installation.</p><button class="text-button" disabled={busy || !!activeOperation} onclick={() => run(() => choose('install'))}>Set up Frameleaf</button></div></section><section class="card option-card"><div class="card-body"><div class="icon-tile"><Icon name="restore"/></div><h2>Restore a backup</h2><p>Restore your database and reconnect media that already exists on your server.</p><button class="text-button" disabled={busy || !!activeOperation} onclick={() => run(() => startRestore())}>Choose a backup</button></div></section></div>
            <p class="quiet-note"><Icon name="info"/>You can review every change before setup or import begins.</p>
          {/if}
        {:else if screen === 'import'}
          {@render steps(importSteps, step)}
          {#if step === 0}
            {@render heading(sources.length > 1 ? 'Choose an Immich installation' : 'Review your Immich installation', 'Your existing database will be kept for recovery.')}
            {#if !sources.length}{@render notice('No supported source available', 'Find and resolve the source installation before starting an import.', 'warning')}<button class="button quiet mt16" onclick={() => run(loadSources)}>Find installations</button>{/if}
            <div class="stack">{#each sources as item}<label class="radio-card"><input type="radio" bind:group={sourceId} value={item.id}/><div><div class="spread"><strong>{item.project ?? item.id.slice(0, 12)}</strong><span class="badge">Immich {item.version}</span></div><p>{item.summary.assets.toLocaleString()} items · {item.summary.users} users · {item.summary.albums} albums</p><p>{formatBytes(item.summary.databaseBytes)} database · {item.mounts.length} media mappings</p></div></label>{/each}</div>
            {#if source}<section class="card mt16"><div class="card-header"><h2>Resolved source configuration</h2><span class="badge">Source</span></div><div class="list-row"><Icon name="database"/><div><strong>PostgreSQL {source.postgres.major}</strong><p>Database: {source.database.name} · {source.postgres.extensions.map((item: any) => item.name).join(', ')}</p></div><span class="badge">{source.database.credentials}</span></div><div class="list-row"><Icon name="network"/><div><strong>Database connection resolved</strong><p>{source.database.host}:{source.database.port} · {source.settingsAuthority === 'file' ? 'Settings from configuration file' : 'Settings from database'}</p></div></div><details class="card-body"><summary>Settings and environment names</summary><p class="meta mt16">{[...source.settings, ...source.environment].join(', ') || 'No additional settings'}</p></details></section>{/if}
            <div class="wizard-footer"><button class="button quiet" onclick={() => run(() => go('welcome'))}>Back</button><button class="button primary" disabled={busy || !sourceId} onclick={() => run(inspectSource)}>Review library & settings</button></div>
          {:else if step === 1}
            {@render heading('Your library, in the same place', 'These exact mappings will be used by Frameleaf so existing photo paths keep working.')}
            <section class="card"><div class="card-header"><h2>Preserved media mappings</h2><span class="badge good">{source.mounts.length} mappings preserved</span></div>{@render mappings(source.mounts)}</section>
            <section class="card mt16"><div class="card-header"><h2>Settings compatibility</h2></div><div class="settings-row"><span>Users, albums & permissions</span><span>Imported from database</span><span class="badge good">Preserved</span></div><div class="settings-row"><span>Compatible settings</span><span>{source.settingsAuthority === 'file' ? 'Configuration file' : 'Database'}</span><span class="badge good">{source.settings.length} settings</span></div><div class="settings-row"><span>Database connection</span><span>New credentials generated</span><span class="badge">Recreated</span></div>{#if source.unsupportedSettings.length}<div class="card-body">{@render notice('Settings require review', source.unsupportedSettings.join(', '), 'warning')}</div>{/if}<div class="card-body"><p class="meta">External sign-in callbacks and host-specific URLs may need updating for the new Frameleaf address. Compatible settings and credentials are preserved privately.</p></div></section>
            <section class="card mt16"><div class="card-header"><h2>Immich database backup</h2></div><div class="list-row"><Icon name="database"/><div><strong>{sourceReview.backup.action === 'reuse' ? 'Recent verified database backup found' : 'A new database backup is needed'}</strong><p>{sourceReview.backup.action === 'reuse' ? new Date(sourceReview.backup.takenAt).toLocaleString() + ' · Same installation · Readable dump verified' : 'No verified dump from the last 24 hours qualifies.'}</p></div><span class="badge" class:good={sourceReview.backup.action === 'reuse'}>{sourceReview.backup.action === 'reuse' ? 'Backup skipped' : 'Backup needed'}</span></div></section>
            <label class="check-row mt24"><input type="checkbox" bind:checked={mappingsAccepted}/><span>I’ve reviewed the mappings and settings that need attention.</span></label>
            <div class="wizard-footer"><button class="button quiet" onclick={() => step = 0}>Back</button><button class="button primary" disabled={!mappingsAccepted || source.unsupportedSettings.length > 0} onclick={() => step = 2}>{lastImportStep === 2 ? 'Review cutover' : 'Review database backup'}</button></div>
          {:else if step === 2 && lastImportStep === 3}
            {@render heading('Back up the Immich database', 'Only the database will be backed up. Your photos stay in place.')}
            <section class="card"><div class="card-header"><h2>Database backup only</h2><span class="badge">Media excluded</span></div><div class="card-body"><label class="field"><span>Mounted encrypted backup destination</span><input value={dashboard.backupRoot} readonly/><small>Manager uses its mounted backup folder. Photos, videos, thumbnails and external libraries are excluded.</small></label><div class="breakdown mt16"><div><strong>{formatBytes(source.summary.databaseBytes)}</strong><small>Source database</small></div><div><strong>{formatBytes(source.summary.databaseBytes * 3)}</strong><small>Preparation space</small></div></div></div></section>
            <div class="mt16">{@render notice('Your photos stay in place', 'Manager will stop Immich and verify the copied database before starting Frameleaf.')}</div><div class="wizard-footer"><button class="button quiet" onclick={() => step = 1}>Back</button><button class="button primary" onclick={() => step = 3}>Review cutover</button></div>
          {:else}
            {@render heading('Ready to switch to Frameleaf', 'Your library will be unavailable while Manager imports the current stopped database.')}
            {#if !review}{@render configuration()}
              <button class="button primary mt16" disabled={busy || !lifecycle || !tag} onclick={() => run(prepare)}>Check and review cutover</button>
            {:else}
              {#if review.backup.action === 'reuse'}{@render notice('Existing Immich backup reused · Backup step skipped', 'Manager rechecks the backup’s age and usability at cutover.')}{/if}
              <section class="card mt16"><div class="card-header"><h2>The cutover plan</h2><span class="badge good">Preflight passed</span></div><div class="card-body"><ol class="timeline">{#each ['Recheck this installation and its backup', 'Stop Immich and disable automatic restart', ...(review.backup.action === 'create' ? ['Create and verify a database backup'] : []), 'Copy the current database into separate Frameleaf PostgreSQL storage', 'Import, start Frameleaf and verify the library'] as item, index}<li><span class="stage-icon">{index + 1}</span><div><strong>{item}</strong></div></li>{/each}</ol><p class="meta mt16">PostgreSQL root: <code>{review.databaseStorage.root}</code></p></div></section>
              <div class="mt16">{@render notice('Only Frameleaf will write to these media locations', review.recovery, 'warning', 'lock')}</div><label class="check-row mt24"><input type="checkbox" bind:checked={cutoverAccepted}/><span>I understand Immich will stay stopped and this backup covers only the database.</span></label><button class="button primary mt16" disabled={busy || !cutoverAccepted || !!activeOperation} onclick={() => run(() => start('install', { reviewId: review.id }))}>Start import</button>
            {/if}
            <div class="wizard-footer"><button class="button quiet" onclick={() => { review = null; step = lastImportStep - 1; }}>Back</button></div>
          {/if}
        {:else if screen === 'fresh'}
          {@render steps(['Storage', 'Checks', 'Install'], step)}
          {#if step === 0}{@render heading('Give your library a home', 'Choose the server locations and connection settings for this installation.')}{@render configuration()}<div class="wizard-footer"><button class="button quiet" onclick={() => run(() => go('welcome'))}>Back</button><button class="button primary" disabled={busy || !mediaPath || !tag || !lifecycle} onclick={() => run(prepare)}>Check this configuration</button></div>
          {:else if step === 1}{@render heading('This server is ready', 'Manager checked storage, compatibility, and the complete signed release bundle.')}<section class="card"><div class="card-header"><h2>Preflight checks</h2></div>{#each [['folder', 'Storage permissions and free space', formatBytes(review.requiredBytes) + ' required; selected mounted locations validated'], ['network', 'Frameleaf port', String(port) + ' checked against Docker and Manager ports'], ['server', 'Docker compatibility', dashboard.host?.platform ?? 'Host compatibility checked'], ['shield', 'Release signature and eligibility', review.tag + ' · Verified release bundle'], ['database', 'PostgreSQL host storage', review.databaseStorage.root]] as [icon, title, detail]}<div class="list-row"><Icon name={icon}/><div><strong>{title}</strong><p>{detail}</p></div><span class="badge good">Passed</span></div>{/each}</section><p class="meta mt16">Docker’s final port bind remains authoritative for other host processes.</p><div class="wizard-footer"><button class="button quiet" onclick={() => { step = 0; review = null; }}>Back</button><button class="button primary" onclick={() => step = 2}>Review installation</button></div>
          {:else}{@render heading('Ready to set up Frameleaf', 'Manager will prepare the services and take you into Frameleaf when your server is ready.')}<section class="card"><div class="card-header"><h2>New installation</h2><span class="badge good">{review.tag}</span></div>{#each [['folder', 'Photo library', mediaPath], ['database', 'New PostgreSQL database', databaseRoot], ['shield', 'Encrypted database backups', dashboard.backupRoot], ['network', 'Application port', String(port)], ['cpu', 'Processing', ml ? 'CPU with machine learning' : 'CPU · Machine learning off']] as [icon, title, detail]}<div class="list-row"><Icon name={icon}/><div><strong>{title}</strong><p><code>{detail}</code></p></div></div>{/each}</section><div class="mt16">{@render notice('Managed independently', 'Your photo library keeps running when Manager is unavailable. Keep a protected configuration export for manual recovery.')}</div><div class="wizard-footer"><button class="button quiet" onclick={() => step = 1}>Back</button><button class="button primary" disabled={busy || !!activeOperation} onclick={() => run(() => start('install', { reviewId: review.id }))}>Install Frameleaf</button></div>{/if}
        {:else if screen === 'progress'}
          {#if operation && timeline}{@render heading(operationNames[operation.kind] ?? 'Manager operation', operation.state === 'running' ? 'You can close this page. Manager records every completed step.' : operation.state === 'complete' && !operation.error ? 'The recorded operation completed successfully.' : 'Review the saved step before continuing.')}
            <section class="card"><div class="card-body"><div class="spread progress-label"><span>{readable(operation.step ?? operation.state)}</span><strong>{timeline.percent}%</strong></div><progress class="progress" aria-label="Operation progress" value={timeline.percent} max="100"></progress><ol class="timeline mt16">{#each timeline.steps as item, index}<li class:done={item.state === 'complete'} class:running={item.state === 'running'}><span class="stage-icon">{#if item.state === 'complete'}<Icon name="check"/>{:else if item.state === 'running'}<Icon name="loader" class="spin"/>{:else}{index + 1}{/if}</span><div><strong>{item.label}</strong></div><span class="stage-time">{readable(item.state)}</span></li>{/each}</ol>{#if operation.error}<div class="notice warning mt16" role="alert"><Icon name="warning"/><div><strong>{readable(operation.error)}</strong><p>Completed journal steps are retained. Resume runs the next safe step.</p></div></div>{/if}</div><div class="card-footer"><span class="safety-note"><Icon name="shield"/>Completed steps are recorded</span><span class="badge" class:good={timeline.successful}>{readable(operation.state)}</span></div></section>
            <div class="wizard-footer"><button class="button quiet" onclick={() => run(() => go('activity'))}>Operation history</button><div class="actions">{#if ['failed', 'interrupted'].includes(operation.state)}<button class="button primary" disabled={busy} onclick={() => run(async () => { await api('resume', { id: operation.id }); await refresh(); })}>Resume safely</button>{#if (operation.canCancel ?? canCancel(operation, installation))}<button class="button danger" disabled={busy} onclick={() => showModal('recover')}>{operation.kind === 'backup' ? 'Cancel backup' : operation.kind === 'update' ? 'Cancel update and restart' : 'Recover the stopped source'}</button>{/if}{:else if timeline.successful}<button class="button primary" onclick={() => run(() => go(['install', 'import', 'restore'].includes(operation.kind) && !dashboard.onboardingFinished ? 'success' : 'overview'))}>Continue</button>{/if}</div></div>
          {:else}{@render heading('No recorded operation', 'Start setup or choose a maintenance operation.')}<button class="button primary" onclick={() => run(() => go(installation ? 'overview' : 'welcome'))}>Continue</button>{/if}
        {:else if screen === 'success'}
          {@render steps(['Server ready', 'Your details', 'Get the app', 'Finish setup'], 0)}{@render heading(installation?.origin === 'new_import' ? 'Your import is in Frameleaf' : 'Your server is ready', 'Now make it yours and connect your phone. Library preparation continues in the background.')}{@render notice('Services are ready', installation?.origin === 'new_import' ? 'Your users, albums and settings are imported. Immich remains stopped, and your media stays in place.' : 'Continue with your local photo account and mobile app.')}{@render regeneration()}<div class="wizard-footer"><span class="meta">Library preparation continues</span><button class="button primary" onclick={() => run(() => go('profile'))}>Continue to your details <Icon name="arrow"/></button></div>
        {:else if screen === 'profile'}
          {@render steps(['Server ready', 'Your details', 'Get the app', 'Finish setup'], 1)}{@render heading('Make yourself at home', 'Confirm your details, then decide whether to add a Frameleaf account.')}
          <form onsubmit={(event) => { event.preventDefault(); void run(saveProfile); }}><section class="card"><div class="card-body"><div class="profile-intro"><span class="profile-avatar"><Icon name="user"/></span><div><h2>Your photo profile</h2><p class="meta">Your local photo account belongs to this server. Existing library permissions are preserved.</p></div></div><div class="form-grid mt24"><label class="field"><span>First name</span><input bind:value={firstName} required maxlength="80" autocomplete="given-name"/></label><label class="field"><span>Last name</span><input bind:value={lastName} maxlength="80" autocomplete="family-name"/></label><label class="field full"><span>Email address</span><input type="email" bind:value={email} required autocomplete="email"/><small>Saved privately with Manager setup. Photo account changes happen in Frameleaf.</small></label></div></div></section><section class="card mt24"><div class="card-header"><h2>A Frameleaf account is optional</h2><span class="badge">Optional</span></div><div class="card-body"><p class="muted account-description">One sign-in for Frameleaf services. You can choose Cloud features later; no subscription starts here.</p><div class="stack mt16">{#each [['local', 'Continue with my local account', 'Use Frameleaf on your own server. You can add an account later.'], ['create', 'Create a Frameleaf account', 'Continue in Frameleaf’s secure account flow.'], ['existing', 'I already have a Frameleaf account', 'Sign in and link your existing account in Frameleaf.']] as [value, title, detail]}<label class="radio-card"><input type="radio" bind:group={account} value={value}/><div><strong>{title}</strong><p>{detail}</p></div></label>{/each}</div></div></section><div class="wizard-footer"><button type="button" class="button quiet" onclick={() => run(() => go('success'))}>Back</button><button class="button primary" disabled={busy}>{account === 'local' ? 'Continue without a Cloud account' : 'Continue to secure account setup'}</button></div></form>
        {:else if screen === 'downloads'}
          {@render steps(['Server ready', 'Your details', 'Get the app', 'Finish setup'], 2)}{@render heading('Your whole library. In your pocket.', 'Get Frameleaf on your phone, then link this server.')}
          {#if account !== 'local'}<section class="card mb16"><div class="card-body"><h2>{account === 'create' ? 'Create your Frameleaf account' : 'Link your Frameleaf account'}</h2><p class="meta mt16">Complete authentication and email verification in Frameleaf. Manager does not collect your Cloud password or verification code.</p><a class="button primary mt16" href={dashboard.appUrl + '/auth/onboarding#frs-tool-frameleaf'} target="_blank" rel="noreferrer">Open secure Frameleaf setup <Icon name="arrow"/></a></div></section>{/if}
          <div class="two-cols download-grid">{#each apps as app}<section class="card download-card"><div class="card-header"><h2>{app.name}</h2><span class="badge">{app.label}</span></div><div class="download-art"><img class="official-app-shot" src={app.image} alt={`Official Frameleaf ${app.name} library screenshot`} width="120" height="260"/><div class="qr-column"><a href={app.href} target="_blank" rel="noreferrer" aria-label={`Open official ${app.name} app page`}>{@html qrSvg(app.href)}</a><span class="meta">Scan with your phone</span></div></div><div class="card-body"><p class="availability">Check the official page for current app availability.</p><a class="button quiet app-page-link" href={app.href} target="_blank" rel="noreferrer">Open {app.label} app page <Icon name="arrow"/></a></div></section>{/each}</div>
          <section class="card mt24"><div class="card-header"><h2>Connect your server</h2></div><div class="card-body"><ol class="connection-steps"><li><span>1</span><div>Open Frameleaf and choose your own server.</div></li><li><span>2</span><div>Enter the server address below.</div></li><li><span>3</span><div>Sign in with your local or imported photo account.</div></li></ol><div class="server-address"><div><small>Your server</small><code>{dashboard.appUrl}</code></div><button class="button quiet" onclick={copyAddress}>Copy address</button></div><a class="button quiet mt16" href={dashboard.appUrl + '/auth/onboarding'} target="_blank" rel="noreferrer">Open local photo account setup <Icon name="arrow"/></a></div></section><div class="wizard-footer"><button class="button quiet" onclick={() => run(() => go('profile'))}>Back</button><button class="button primary" onclick={() => run(() => go('phone'))}>Continue to library preparation</button></div>
        {:else if screen === 'phone' || screen === 'setup-complete'}
          {@render steps(['Server ready', 'Your details', 'Get the app', 'Finish setup'], 3)}{@render heading(dashboard.onboardingFinished ? 'Your library is ready' : 'Preparing your library, together', 'Your phone syncs the catalog and browsing previews while the server prepares the library.')}
          <div class="setup-layout"><div class="server-preparation"><section class="card"><div class="card-header"><h2>{phases[dashboard.librarySetup?.phase] ?? 'Waiting for library status'}</h2><span class="badge" class:good={dashboard.librarySetup?.rescanComplete}>{dashboard.librarySetup?.rescanComplete ? 'Complete' : 'Preparing'}</span></div><div class="card-body setup-state"><div class="list-row"><Icon name={dashboard.librarySetup?.rescanComplete ? 'check' : 'update'}/><div><strong>Library rescan</strong><p>Reconcile existing media and complete required processing.</p></div></div><div class="list-row"><Icon name={dashboard.librarySetup?.verificationPassed ? 'check' : 'shield'}/><div><strong>Library verification</strong><p>Verify the final catalog and review findings.</p></div></div>{#if dashboard.librarySetup?.phase === 'awaiting-account'}<a class="button primary" href={dashboard.appUrl + '/auth/onboarding'} target="_blank" rel="noreferrer">Finish your photo account setup</a>{/if}{#if dashboard.librarySetup?.phase === 'needs-attention'}<a href={dashboard.appUrl + '/utilities'} target="_blank" rel="noreferrer">Review Library Care findings ↗</a><button class="button quiet" disabled={busy} onclick={() => run(async () => { await api('retry-setup', {}); await refresh(); })}>Verify the library again</button>{/if}</div></section>{@render regeneration()}<p class="quiet-note"><Icon name="info"/>Keep the app open. If the phone pauses background work, reopen it to resume. Original media is not downloaded by catalog setup.</p></div><section class="card"><div class="card-header"><h2>Your phone</h2><span class="badge" class:good={dashboard.librarySetup?.canFinish}>{dashboard.librarySetup?.canFinish ? 'Ready' : 'Waiting'}</span></div><div class="phone-state"><div class="phone-icon"><Icon name="image"/></div><h3>{dashboard.librarySetup?.canFinish ? 'Library caught up' : 'Connect and sign in'}</h3><p class="muted">{dashboard.librarySetup?.canFinish ? 'The server reports a phone has completed its final catalog and browsing previews.' : 'Sign in on your phone, sync the catalog, and let browsing previews finish for the final library revision.'}</p><div class="server-address"><code>{dashboard.appUrl}</code></div><ul class="checklist"><li><Icon name={dashboard.librarySetup?.canFinish ? 'check' : 'clock'}/>Final catalog acknowledged</li><li><Icon name={dashboard.librarySetup?.canFinish ? 'check' : 'clock'}/>Browsing previews ready</li></ul></div></section></div>
          <div class="wizard-footer"><button class="button quiet" onclick={() => run(() => go('downloads'))}>Back to app setup</button>{#if dashboard.onboardingFinished}<button class="button primary" onclick={() => run(() => go('overview'))}>Open overview</button>{:else}<button class="button primary" disabled={busy || !dashboard.librarySetup?.canFinish} onclick={() => run(async () => { await api('finish-setup', {}); await refresh(); screen = 'setup-complete'; })}>Finish setup</button>{/if}</div>
        {:else if ['overview', 'services', 'storage', 'backups', 'updates'].includes(screen) && !installation && screen !== 'backups'}
          {@render heading(labels[screen], 'Set up Frameleaf to use this part of Manager.')}<section class="card empty-state"><Icon name="server"/><h2>No installation yet</h2><p>Import an existing library, set up a new one, or restore a database backup.</p><button class="button primary" onclick={() => run(() => go('welcome'))}>Set up Frameleaf</button></section>
        {:else if screen === 'overview'}
          {@render heading(installation.name ?? 'Your library', 'Your photos, services, and recovery points at a glance.')}<div class="actions mb16"><a class="button primary" href={dashboard.appUrl} target="_blank" rel="noreferrer">Open Frameleaf <Icon name="arrow"/></a>{#if !dashboard.onboardingFinished}<button class="button quiet" onclick={() => run(() => go(dashboard.profile ? 'downloads' : 'profile'))}>Continue setup</button>{/if}</div>
          {@render notice(running ? 'Your server is running' : 'Your library is stopped', running ? healthy ? 'Managed services are running. Review library preparation before finishing setup.' : 'Some services are starting or need attention.' : 'Start your services to make Frameleaf available.', running && healthy ? 'good' : 'warning', running ? 'check' : 'stop')}
          <div class="metric-grid mt16"><section class="card metric"><span class="label"><Icon name="image"/>Photos & videos</span><strong>{dashboard.summary?.assets?.toLocaleString() ?? 'Unavailable'}</strong><small>{dashboard.summary ? dashboard.summary.albums.toLocaleString() + ' albums · ' + dashboard.summary.users.toLocaleString() + ' people' : 'Library counts require the database'}</small></section><section class="card metric"><span class="label"><Icon name="drive"/>Storage available</span><strong>{formatBytes(storage.find(item => item.availableBytes != null)?.availableBytes)}</strong><small>Mounted library storage</small></section><section class="card metric"><span class="label"><Icon name="shield"/>Latest backup</span><strong>{latestBackup ? new Date(latestBackup.time).toLocaleDateString() : 'None'}</strong><small>{latestBackup ? 'Encrypted database recovery point' : 'Create a database backup'}</small></section></div>
          <section class="card mt24"><div class="card-header"><h2>Services</h2><button class="button quiet" onclick={() => run(() => go('services'))}>Manage</button></div>{@render services()}</section><div class="two-cols mt16"><section class="card"><div class="card-body"><div class="row mb16"><Icon name="shield"/><h2>Database recovery points</h2></div><p class="muted">Encrypted database dumps. Media is excluded.</p><div class="spread mt16"><span class="meta">{snapshots.length} snapshots</span><button class="text-button" onclick={() => run(() => go('backups'))}>View backups</button></div></div></section><section class="card"><div class="card-body"><div class="row mb16"><Icon name="update"/><h2>{releasesLoaded ? availableUpdates.length ? 'Updates available' : 'No eligible update found' : 'Choose when to update'}</h2></div><p class="muted">Running {installation.release}. Review eligibility and recovery before applying a release.</p><button class="text-button mt16" onclick={() => run(() => go('updates'))}>Review updates</button></div></section></div>{@render regeneration()}
        {:else if screen === 'services'}
          {@render heading('Services', 'Manager owns this stack. Your library runs independently of the Manager container.')}<div class="actions mb16"><button class="button" class:primary={!running} disabled={busy || !!activeOperation} onclick={() => running ? showModal('control', 'stop') : run(() => control('start'))}><Icon name={running ? 'stop' : 'play'}/>{running ? 'Stop stack' : 'Start stack'}</button><button class="button quiet" disabled={busy || !!activeOperation} onclick={() => showModal('control', 'restart')}><Icon name="update"/>Restart stack</button></div><section class="card"><div class="card-header"><h2>Frameleaf · {installation.project}</h2></div>{@render services()}</section>
          <section class="card mt16"><div class="card-header"><h2>Recent server logs</h2><div class="actions"><button class="button quiet" disabled={busy || !logService} onclick={() => run(() => showLogs(logService))}>Refresh logs</button><button class="button quiet" disabled={!logs} onclick={downloadLogs}><Icon name="document"/>Download logs</button></div></div><div class="card-body">{#if logs}<pre class="log">{logs}</pre>{:else}<p class="muted">Choose Logs on a managed service to load its sanitized output.</p>{/if}</div></section><p class="quiet-note"><Icon name="lock"/>Logs are sanitized before they reach this browser.</p>
        {:else if screen === 'storage'}
          {@render heading('Storage', 'The exact paths your library uses, and available space on mounted storage.')}<div class="stack">{#each storage as disk}<section class="card"><div class="card-header"><h2><code>{disk.path}</code></h2><span class="badge" class:warning={disk.availableBytes == null}>{disk.availableBytes == null ? 'Unavailable' : 'Mounted'}</span></div><div class="card-body">{#if disk.totalBytes != null}<div class="spread"><strong>{formatBytes(disk.totalBytes - disk.freeBytes)} used of {formatBytes(disk.totalBytes)}</strong><span class="muted">{formatBytes(disk.availableBytes)} available</span></div><progress class="meter mt16" aria-label={disk.path + ' storage used'} value={disk.totalBytes - disk.freeBytes} max={disk.totalBytes}></progress>{:else}<p class="muted">Manager cannot read capacity for this mounted location.</p>{/if}</div></section>{/each}</div><section class="card mt16"><div class="card-header"><h2>Media mappings</h2><span class="badge">Exact access modes</span></div>{@render mappings(installation.mounts)}</section><section class="card mt16"><div class="card-header"><h2>Separate Frameleaf database</h2></div><div class="card-body"><code>{installation.databasePath}</code><p class="meta mt16">PostgreSQL uses a dedicated folder on the host disk. The source database and earlier recovery folders are retained.</p></div></section>
        {:else if screen === 'backups'}
          {@render heading('Database backups', 'Back up the database only. Photos, videos and external libraries stay in their existing locations.')}
          {#if installation}<button class="button primary mb16" disabled={busy || !!activeOperation} onclick={() => run(() => control('backup'))}><Icon name="database"/>Back up database</button>{/if}
          <section class="card"><div class="card-header"><h2>Backup drive</h2></div><div class="list-row"><Icon name="drive"/><div><strong><code>{dashboard.backupRoot}</code></strong><p>Encrypted database dumps · Mounted backup destination</p></div></div><div class="list-row"><Icon name="clock"/><div><strong>On demand</strong><p>You control when Manager creates a database backup.</p></div></div><div class="list-row"><Icon name="key"/><div><strong>Recovery key</strong><p>Store it separately from the server.</p></div><button class="button quiet" disabled={!backupStatus.keyAvailable} onclick={() => showModal('backup-key')}>Export recovery key</button></div></section>
          <section class="card mt24"><div class="card-header"><h2>Database recovery points</h2><button class="button quiet" disabled={busy} onclick={() => run(loadBackups)}>Refresh</button></div>{#if snapshots.length}<div class="table-wrap"><table><thead><tr><th>Database backup</th><th>Scope</th><th>Status</th><th></th></tr></thead><tbody>{#each snapshots as item}<tr><td><strong>{new Date(item.time).toLocaleString()}</strong><small>Snapshot {item.id.slice(0, 12)}</small></td><td>Database & configuration<small>Media excluded</small></td><td><span class="badge">Encrypted</span></td><td><button class="button quiet" disabled={busy || !!activeOperation} onclick={() => run(() => startRestore(item.id))}>Restore</button></td></tr>{/each}</tbody></table></div>{:else}<div class="card-body"><p class="muted">No canonical database recovery points are available.</p>{#if !backupStatus.unlocked}<button class="button quiet mt16" disabled={busy || !!activeOperation} onclick={() => run(() => startRestore())}>Unlock a backup repository</button>{/if}</div>{/if}</section><div class="mt16">{@render notice('Media is not part of these backups', 'Restoring a database reconnects references to media that already exists. It does not restore missing or changed files.', '', 'info')}</div>{#if installation?.origin === 'new_import'}<button class="button quiet mt16" onclick={() => showModal('source-recovery')}>Original Immich recovery notes</button>{/if}
        {:else if screen === 'restore'}
          {@render steps(['Database backup', 'Recovery point', 'Restore'], step)}
          {#if step === 0}{@render heading('Restore your database', 'Connect an encrypted database backup and keep the existing media locations available.')}<section class="card"><div class="card-header"><h2>Database backup repository</h2></div><div class="card-body stack"><label class="field"><span>Mounted backup destination</span><input value={dashboard.backupRoot} readonly/></label>{#if !backupStatus.unlocked}<form class="stack" onsubmit={(event) => { event.preventDefault(); void run(unlockBackups); }}><label class="field"><span>Recovery key</span><input type="password" bind:value={recoveryKey} required autocomplete="off"/></label><button class="button primary" disabled={busy}>Unlock backups</button></form>{:else}<p class="meta">The existing recovery key unlocks {snapshots.length} canonical database snapshots.</p><button class="button primary" disabled={!snapshots.length} onclick={() => step = 1}>Choose a recovery point</button>{#if !snapshots.length}<p class="meta">This repository has no canonical Frameleaf recovery points. Create a database backup before using ordinary restore. Source Immich checkpoints are kept for separate source recovery.</p>{/if}{/if}</div></section><div class="mt16">{@render notice('Your media must already be available', 'Manager restores into a new empty PostgreSQL folder. Photos, videos and external-library files are not included.', '', 'database')}</div><div class="wizard-footer"><button class="button quiet" onclick={() => run(() => go(installation ? 'backups' : 'welcome'))}>Back</button></div>
          {:else if step === 1}{@render heading('Choose a database recovery point', 'Database records return to the selected time. Media files are not restored.')}<form onsubmit={(event) => { event.preventDefault(); void run(prepareRestore); }}><div class="stack">{#each snapshots as item}<label class="radio-card"><input type="radio" bind:group={snapshot} value={item.id} required/><div><div class="spread"><strong>{new Date(item.time).toLocaleString()}</strong><span class="badge">Database only</span></div><p>{item.id.slice(0, 12)} · Encrypted recovery point</p></div></label>{/each}<label class="field"><span>PostgreSQL appdata location</span><input bind:value={databaseRoot} list="database-roots" required/><small>A separate empty database folder is allocated here. Existing files are retained.</small></label></div><div class="wizard-footer"><button type="button" class="button quiet" onclick={() => step = 0}>Back</button><button class="button primary" disabled={busy || !snapshot}>Review restore</button></div></form>
          {:else}{@render heading('Review your database restore', 'Verify the database recovery point and reconnect existing library files.')}<section class="card"><div class="card-header"><h2>Recovery destination</h2><span class="badge good">Verified review</span></div><div class="list-row"><Icon name="database"/><div><strong>New, empty PostgreSQL database</strong><p><code>{restoreReview.databaseStorage.root}</code></p></div></div><div class="list-row"><Icon name="update"/><div><strong>Matching release</strong><p>{restoreReview.release}</p></div></div>{@render mappings(restoreReview.mounts)}</section><div class="mt16">{@render notice('This restore does not recover media files', 'Required files must already exist at these mappings. The current stack will be stopped and retained separately before restoring.', 'warning', 'warning')}</div><label class="check-row mt24"><input type="checkbox" bind:checked={restoreAccepted}/><span>I understand this restores database records and stops the current installation. Media is not restored.</span></label><div class="wizard-footer"><button class="button quiet" onclick={() => step = 1}>Back</button><button class="button primary" disabled={busy || !restoreAccepted || !!activeOperation} onclick={() => run(() => start('restore', { id: restoreReview.id }))}>Restore database</button></div>{/if}
        {:else if screen === 'updates'}
          {@render heading('Updates', 'Choose when to update. Manager prepares your database recovery point first.')}
          <button class="button quiet mb16" disabled={busy} onclick={() => run(loadReleases)}><Icon name="update"/>Check for updates</button>
          {#if !availableUpdates.length}<section class="card empty-state"><Icon name="update"/><h2>No eligible update found</h2><p>Your current release is {installation.release}. Withdrawn and staged releases that are not eligible for this server are excluded.</p></section>{:else}<section class="card"><div class="card-header"><h2>Available releases</h2><span class="badge">Stable channel</span></div><div class="card-body"><form class="stack" onsubmit={(event) => { event.preventDefault(); void run(async () => { updateReview = await api('review-update', { tag }); }); }}><label class="field"><span>Eligible release</span><select bind:value={tag} required onchange={() => updateReview = null}><option value="">Select a release</option>{#each availableUpdates as release}<option value={release.tag}>{release.tag} · {new Date(release.publishedAt).toLocaleDateString()}</option>{/each}</select></label>{#if releases.find(item => item.tag === tag)?.notes}<pre class="log">{releases.find(item => item.tag === tag).notes}</pre>{/if}<button class="button primary" disabled={busy || !tag || !!activeOperation}>Verify and review update</button></form></div></section>{/if}
          {#if updateReview}<section class="card mt16"><div class="card-header"><h2>{updateReview.from} → {updateReview.to}</h2><span class="badge good">Verified</span></div><div class="card-body"><ul class="checklist"><li><Icon name="check"/>Signature, architecture and eligibility checked</li><li><Icon name="check"/>Complete compatible image set reviewed</li><li><Icon name="database"/>Database checkpoint required before applying the release</li></ul><p class="meta mt16">{updateReview.recovery}</p></div><div class="card-footer"><span class="safety-note"><Icon name="clock"/>Photo access pauses during the update</span><button class="button primary" disabled={busy || !!activeOperation} onclick={() => showModal('update')}>Update Frameleaf</button></div></section>{/if}
        {:else if screen === 'activity'}
          {@render heading('Activity', 'Recorded setup, maintenance, and recovery operations on this server.')}<section class="card"><div class="card-header"><h2>Operation history</h2></div>{#each dashboard.operations as item}<div class="list-row"><Icon name={item.state === 'complete' && !item.error ? 'check' : item.state === 'running' ? 'clock' : 'warning'}/><div><strong>{operationNames[item.kind] ?? readable(item.kind)}</strong><p>{new Date(item.createdAt).toLocaleString()} · {readable(item.step ?? item.state)}</p>{#if item.error}<p class="amber">{readable(item.error)}</p>{/if}</div><span class="badge" class:good={item.state === 'complete' && !item.error}>{readable(item.state)}</span><button class="button quiet" onclick={() => { selectedOperation = item.id; void run(() => go('progress')); }}>Details</button></div>{:else}<div class="card-body"><p class="muted">No operations have been recorded yet.</p></div>{/each}</section>
        {:else if screen === 'settings'}
          {@render heading('Manager settings', 'Local administration and recovery for this server.')}<section class="card"><div class="card-header"><h2>Access</h2></div><div class="list-row"><Icon name="user"/><div><strong>Local administrator</strong><p>{dashboard.administrator?.name} · Independent of photo accounts</p></div><button class="button quiet" onclick={() => showModal('administrator')}>Edit account</button></div><div class="list-row"><Icon name="lock"/><div><strong>Local HTTPS</strong><p>{dashboard.managerOrigin ?? location.origin}</p></div><span class="badge good">Enabled</span></div><div class="list-row"><Icon name="shield"/><div><strong>Protected session</strong><p>Secure cookies, CSRF protection and sign-in rate limits</p></div><button class="button quiet" disabled={busy} onclick={() => run(signOut)}>Sign out</button></div></section><section class="card mt16"><div class="card-header"><h2>Appearance</h2></div><div class="list-row"><Icon name="sun"/><div><strong>Theme</strong><p>Frameleaf’s approved light and dark palettes</p></div><div class="segmented">{#each ['dark', 'light'] as item}<button aria-pressed={theme === item} onclick={() => theme = item}>{item === 'dark' ? 'Dark' : 'Light'}</button>{/each}</div></div></section><section class="card mt16"><div class="card-header"><h2>Recovery & configuration</h2></div><div class="list-row"><Icon name="document"/><div><strong>Configuration export</strong><p>Export the managed project and secrets for manual recovery.</p></div><button class="button quiet" disabled={!installation} onclick={() => showModal('export')}>Export</button></div><div class="list-row"><Icon name="restore"/><div><strong>Recover Manager</strong><p>Replace only the Manager container and reconnect its persisted state.</p></div><button class="button quiet" onclick={() => showModal('recovery')}>View procedure</button></div></section>
        {/if}
        {/if}
      </main></div>
    </div>
    <aside class="inspector" aria-label="Context and installation details">
      {#if screen === 'import' && source}<section class="inspector-section"><h2>Import summary</h2><dl class="definition"><div><dt>Source</dt><dd>{source.project ?? 'Selected installation'}</dd></div><div><dt>Version</dt><dd>{source.version}</dd></div><div><dt>Photos & videos</dt><dd>{source.summary.assets.toLocaleString()}</dd></div><div><dt>Users</dt><dd>{source.summary.users}</dd></div><div><dt>Albums</dt><dd>{source.summary.albums}</dd></div></dl></section><section class="inspector-section"><h3>What stays in place</h3><p>Your media and external libraries keep the same paths and access modes. The original database is retained separately.</p></section>
      {:else if installation}<section class="inspector-section"><h2>Your library</h2><dl class="definition"><div><dt>Frameleaf</dt><dd>{installation.release}</dd></div><div><dt>Status</dt><dd class:green={running}>{running ? 'Running' : 'Stopped'}</dd></div><div><dt>Project</dt><dd>{installation.project}</dd></div><div><dt>Owner</dt><dd>Manager</dd></div></dl></section><section class="inspector-section"><h3>Database recovery</h3><p>Database backups exclude media. Required files must already exist to restore file access.</p><ul class="checklist"><li><Icon name="check"/>Encrypted database checkpoints</li><li><Icon name="check"/>Existing media reused</li></ul></section>
      {:else}<section class="inspector-section"><div class="spread"><h2>This server</h2><Icon name="server"/></div><dl class="definition"><div><dt>Host</dt><dd>{dashboard?.host?.name ?? location.hostname}</dd></div><div><dt>Platform</dt><dd>{dashboard?.host?.platform ?? 'Waiting for sign-in'}</dd></div><div><dt>Docker</dt><dd>{dashboard?.host?.version ?? 'Not checked'}</dd></div><div><dt>Memory</dt><dd>{formatBytes(dashboard?.host?.memory)}</dd></div><div><dt>Processor</dt><dd>{dashboard?.host?.processors ? dashboard.host.processors + ' cores' : 'Unavailable'}</dd></div></dl></section>{/if}
      <section class="inspector-section"><h3>Manager is independent</h3><p>Your photo library keeps running if Manager stops. Maintenance and recovery stay available when the photo application is offline.</p></section><section class="inspector-section"><h3>Made for your server</h3><ul class="checklist"><li><Icon name="check"/>Your media stays on your server</li><li><Icon name="check"/>No Cloud account required</li><li><Icon name="check"/>You choose when to update</li></ul></section><div class="inspector-note"><Icon name="lock"/><p>Manager has its own local administrator account.</p></div>
    </aside>
  </div>
</div>

{#snippet configuration()}
  <form id="configuration-form" onsubmit={(event) => { event.preventDefault(); void run(prepare); }}>
  <section class="card"><div class="card-header"><h2>Storage & access</h2></div><div class="card-body"><div class="form-grid">
    <label class="field full"><span>Library name</span><input bind:value={libraryName} required maxlength="120"/></label>
    {#if kind === 'install'}<label class="field full"><span>Media location</span><select bind:value={mediaPath} required><option value="">Choose a mounted folder</option>{#each dashboard.storageRoots as root}<option value={root}>{root}</option>{/each}</select><small>Originals and generated media remain in this mounted location.</small></label>{/if}
    <label class="field"><span>PostgreSQL appdata location</span><input bind:value={databaseRoot} list="database-roots" required autocomplete="off" spellcheck="false"/><small>New dedicated host-disk storage, outside Docker’s virtual disk.</small></label><label class="field"><span>Frameleaf port</span><input type="number" bind:value={port} min="1024" max="65535" required/><small>Manager remains on its own HTTPS port.</small></label>
    <label class="field"><span>Frameleaf release</span><select bind:value={tag} required><option value="">Select a verified release</option>{#each releases as release}<option value={release.tag}>{release.tag}</option>{/each}</select>{#if !releases.length}<small>No eligible signed release was offered. Refresh releases or check distribution availability.</small>{/if}</label><label class="field"><span>Database backup destination</span><input value={dashboard.backupRoot} readonly/><small>Mounted encrypted database backups only.</small></label>
    {#if dashboard.databaseStorage.detectedPath}<p class="meta full">Detected Unraid appdata: <code>{dashboard.databaseStorage.detectedPath}</code>. To use another disk, mount its folder into Manager at the identical host path.</p>{/if}
  </div></div></section><section class="card mt16"><div class="card-header"><h2>Processing</h2></div><div class="list-row"><Icon name="cpu"/><div><strong>CPU processing</strong><p>Default local processing</p></div><span class="badge">Default</span></div><div class="list-row"><Icon name="image"/><div><strong>Machine learning</strong><p>Face recognition and smart search</p></div><label class="toggle"><input type="checkbox" bind:checked={ml}/><span class="toggle-track"></span><span>Enable</span></label></div></section><label class="check-row mt24"><input type="checkbox" bind:checked={lifecycle}/><span>Docker or Unraid manages startup. I have disabled any additional scheduler or service that recreates these containers.</span></label>
  </form>
{/snippet}
<datalist id="database-roots">{#each dashboard?.databaseStorage?.roots ?? [] as root}<option value={root}></option>{/each}</datalist>
<dialog bind:this={dialog} aria-labelledby="dialog-title" onclose={() => { password = ''; newPassword = ''; modal = ''; }}>
  <button class="button quiet icon-button modal-close" onclick={closeModal} aria-label="Close dialog"><Icon name="close"/></button>
  <div class="modal-body"><h2 id="dialog-title">{({ control: modalAction === 'stop' ? 'Stop your photo library' : 'Restart your photo library', update: 'Update Frameleaf', recover: 'Recover the saved operation', administrator: 'Secure your Manager', export: 'Export configuration', 'backup-key': 'Export recovery key', recovery: 'Recover Manager', 'source-recovery': 'Returning to Immich', help: 'Frameleaf Manager guide' } as Record<string, string>)[modal]}</h2>
    {#if error}<p class="amber mt16" role="alert">{error}</p>{/if}
    {#if modal === 'control'}<p class="mt16">Photo access and background processing will pause. Manager stays available to manage the recorded operation.</p>
    {:else if modal === 'update'}<p class="mt16">Manager rechecks eligibility, downloads compatible images and creates a database recovery point before applying this release.</p><p class="meta mt16">{updateReview?.recovery}</p>
    {:else if modal === 'recover'}<p class="mt16">Manager will reconcile the saved step and retain recovery files. A database backup does not reverse media changes.</p>
    {:else if ['administrator', 'export', 'backup-key'].includes(modal)}<form id="credential-form" onsubmit={(event) => { event.preventDefault(); void run(credentialAction); }}>
      {#if modal === 'administrator'}<label class="field"><span>Administrator name</span><input bind:value={name} required maxlength="120" autocomplete="name"/></label>{:else}<p class="mt16">This download contains recovery secrets. Store it privately, separately from the server.</p>{/if}<label class="field"><span>Current Manager password</span><input type="password" bind:value={password} required maxlength="256" autocomplete="current-password"/></label>{#if modal === 'administrator'}<label class="field"><span>New password (optional)</span><input type="password" bind:value={newPassword} minlength="14" maxlength="256" autocomplete="new-password"/><small>Leave empty to keep your password. Previous sessions are signed out after saving.</small></label>{/if}
    </form>
    {:else if modal === 'recovery'}<ol class="timeline mt16">{#each [['Keep the existing state folder', 'Preserve the Manager journal, configuration and recovery keys.'], ['Stop and replace only Manager', 'Use a verified image with the same exact bind mappings, HTTPS origin and Docker socket.'], ['Sign in and review the journal', 'An unfinished operation appears as interrupted. Resume only after reviewing its saved step.'], ['Use the protected configuration export if necessary', 'Recover the photo stack with its recorded Compose project. Keep secrets private; media recovery is separate.']] as [title, detail], index}<li><span class="stage-icon">{index + 1}</span><div><strong>{title}</strong><p>{detail}</p></div></li>{/each}</ol>
    {:else if modal === 'source-recovery'}<p class="mt16">Your original Immich database is retained. After Frameleaf writes to shared media, restarting Immich requires a separate recovery review.</p><div class="mt16">{@render notice('Database recovery does not restore media', 'Keep both applications stopped while checking the matching database and media. Manager does not automatically restore files or restart the original source.', 'warning', 'warning')}</div>
    {:else if modal === 'help'}<p class="mt16">Set up a new library, import a supported Immich installation, or restore an encrypted database recovery point. Review every configuration before starting.</p><ul class="checklist"><li><Icon name="server"/>Services: lifecycle controls and sanitized logs</li><li><Icon name="drive"/>Storage: mounted capacity and exact media mappings</li><li><Icon name="shield"/>Backups: database recovery points and key export</li><li><Icon name="update"/>Updates: verified eligibility and recovery checkpoint</li><li><Icon name="activity"/>Activity: saved journal, retry and recovery</li></ul>{/if}
  </div>
  <div class="modal-footer"><button class="button quiet" onclick={closeModal}>Cancel</button>{#if modal === 'control'}<button class="button danger" disabled={busy} onclick={() => run(() => control(modalAction))}>{modalAction === 'stop' ? 'Stop services' : 'Restart services'}</button>{:else if modal === 'update'}<button class="button primary" disabled={busy} onclick={() => run(() => start('update', { id: updateReview.id }))}>Update Frameleaf</button>{:else if modal === 'recover'}<button class="button danger" disabled={busy} onclick={() => run(async () => { await api('recover', { id: operation.id }); await refresh(); closeModal(); })}>Confirm recovery</button>{:else if ['administrator', 'export', 'backup-key'].includes(modal)}<button class="button primary" type="submit" form="credential-form" disabled={busy}>{modal === 'administrator' ? 'Save account' : 'Download'}</button>{:else}<button class="button primary" onclick={closeModal}>Done</button>{/if}</div>
</dialog>
<div id="toast" role="status" aria-live="polite" class:visible={!!toast}>{toast}<button class="button quiet icon-button" onclick={() => toast = ''} aria-label="Dismiss notification"><Icon name="close"/></button></div>
