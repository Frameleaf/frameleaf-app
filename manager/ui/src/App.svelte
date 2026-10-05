<script lang="ts">
  import { onMount } from 'svelte';
  import { encodeQr, qrPath } from './qr.mjs';
  const qrSvg = (url: string) => { const code = encodeQr(url); return `<svg viewBox="0 0 ${code.size + 8} ${code.size + 8}" role="presentation"><rect width="100%" height="100%" fill="white"/><path d="${qrPath(code.modules)}" fill="#101416"/></svg>`; };
  let csrf = '', claimed = $state(false), signedIn = $state(false), busy = $state(false), error = $state('');
  let password = $state(''), name = $state(''), proof = $state(''), screen = $state('welcome');
  let dashboard = $state<any>(null), sources = $state<any[]>([]), releases = $state<any[]>([]), review = $state<any>(null);
  let sourceId = $state(''), tag = $state(''), mediaPath = $state(''), port = $state(2283), ml = $state(false), lifecycle = $state(false);
  let databaseRoot = $state('');
  let databaseDefaultLoaded = false;
  let recoveryKey = $state(''), snapshots = $state<any[]>([]), snapshot = $state(''), restoreReview = $state<any>(null), updateReview = $state<any>(null);
  let kind = $state<'install' | 'import'>('install'), firstName = $state(''), lastName = $state(''), email = $state(''), account = $state('local');
  let logs = $state(''), theme = $state(localStorage.getItem('frameleaf-manager-theme') ?? 'dark');
  const apps = [{ name: 'iPhone', href: 'https://frameleaf.app/apps/iphone/', image: '/assets/ios-library-months.avif' },
    { name: 'Android', href: 'https://frameleaf.app/apps/android/', image: '/assets/android-library-all.avif' }];
  const labels: Record<string, string> = { welcome: 'Welcome', configure: 'Your installation', review: 'Review', progress: 'Getting ready', profile: 'Your account', apps: 'On your phone', dashboard: 'Overview', restore: 'Restore a backup', 'review-restore': 'Review restoration', update: 'Update Frameleaf', export: 'Recovery configuration' };
  const phases: Record<string, string> = { 'awaiting-account': 'Finish your photo account setup', rescanning: 'Rescanning your library', verifying: 'Verifying your library', 'needs-attention': 'Review the findings in Library Care', complete: 'Library ready', unavailable: 'Waiting for Frameleaf' };
  const operation = $derived(dashboard?.operations?.[0]);
  async function api(path: string, body?: unknown) {
    const response = await fetch(`/manager-api/${path}`, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json();
    if (!response.ok) throw new Error(value.code ?? 'Request failed');
    if (value.csrf) csrf = value.csrf;
    return value;
  }
  async function run(work: () => Promise<void>) { busy = true; error = ''; try { await work(); } catch (e) { error = e instanceof Error ? e.message.replaceAll('_', ' ') : 'Could not complete this request'; } finally { busy = false; } }
  async function refresh() { dashboard = await api('dashboard'); if (!databaseDefaultLoaded) { databaseRoot = dashboard.databaseStorage.suggestedPath; databaseDefaultLoaded = true; } }
  async function signIn() { await api(claimed ? 'login' : 'claim', claimed ? { password } : { password, name, proof }); password = ''; proof = ''; signedIn = true; await refresh(); screen = dashboard.installation ? 'dashboard' : 'welcome'; }
  async function choose(value: 'install' | 'import') {
    kind = value; await refresh(); releases = await api('releases'); tag = releases[0]?.tag ?? '';
    if (value === 'import') { const result = await api('sources'); sources = result.sources; if (sources.length === 1) sourceId = sources[0].id; if (result.refused.length) error = 'Some installations need attention: ' + result.refused.map((r: any) => r.code.replaceAll('_', ' ')).join(', '); }
    screen = 'configure';
  }
  async function prepare() { review = await api('review', { kind, tag, ...(kind === 'import' ? { sourceId } : { mediaPath }), databaseRoot, port, ml, lifecycle: 'docker-only' }); screen = 'review'; }
  async function install() { await api('install', { reviewId: review.id, key: crypto.randomUUID() }); await refresh(); screen = 'progress'; }
  async function control(action: string) { await api('control', { action, key: crypto.randomUUID() }); await refresh(); }
  async function saveProfile() { await api('profile', { firstName, lastName, email, account }); screen = 'apps'; }
  async function unlockBackups() { await api('unlock-backups', { key: recoveryKey }); recoveryKey = ''; snapshots = await api('backups'); }
  async function prepareRestore() { restoreReview = await api('review-restore', { snapshot, databaseRoot }); screen = 'review-restore'; }
  async function restore() { await api('restore', { id: restoreReview.id, key: crypto.randomUUID() }); await refresh(); screen = 'progress'; }
  async function chooseUpdate() { releases = await api('releases'); tag = ''; updateReview = null; screen = 'update'; }
  async function exportConfiguration() {
    const response = await fetch('/manager-api/export', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ password }) }); password = '';
    if (!response.ok) throw new Error((await response.json()).code);
    const url = URL.createObjectURL(await response.blob()); const link = document.createElement('a'); link.href = url; link.download = 'frameleaf-manager-recovery.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  onMount(() => {
    void run(async () => { const status = await api('status'); claimed = status.claimed; try { await refresh(); signedIn = true; screen = dashboard.installation ? 'dashboard' : 'welcome'; } catch { signedIn = false; } });
    // Only the local Manager is polled. Disconnects and hidden tabs do not advance an operation.
    const timer = setInterval(() => { if (signedIn && !document.hidden && !busy) void refresh().catch(() => {}); }, 10_000);
    return () => clearInterval(timer);
  });
  $effect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('frameleaf-manager-theme', theme); });
</script>

<svelte:head><title>Frameleaf Manager · {labels[screen]}</title></svelte:head>
<header><img src={theme === 'dark' ? '/assets/frameleaf-logo-white.svg' : '/assets/frameleaf-logo-light.svg'} alt="Frameleaf" /><span class="divider"></span><span>Manager</span><div class="spacer"></div><span class="pill">Local server</span><button class="quiet" onclick={() => theme = theme === 'dark' ? 'light' : 'dark'} aria-label="Switch color theme">{theme === 'dark' ? 'Light' : 'Dark'} appearance</button></header>
<div class="shell"><nav aria-label="Manager"><div class="nav-title">YOUR SERVER</div><button class:active={screen === 'dashboard'} onclick={() => screen = 'dashboard'} disabled={!signedIn || !dashboard?.installation}>Overview</button><button class:active={screen !== 'dashboard'} onclick={() => screen = dashboard?.installation ? 'progress' : 'welcome'} disabled={!signedIn}>Setup assistant</button><div class="nav-bottom"><img src="/assets/frameleaf-symbol.svg" alt=""/><p>Your photos.<br/>Your server.</p></div></nav>
<main><div class="eyebrow">FRAMELEAF MANAGER</div><h1>{!signedIn ? claimed ? 'Welcome back.' : 'A home for your memories.' : labels[screen]}</h1>
{#if error}<div class="notice error" role="alert">{error}</div>{/if}
{#if !signedIn}
  <p class="lede">{claimed ? 'Sign in to manage this Frameleaf installation.' : 'Create the local administrator account for Manager.'}</p>
  <form onsubmit={(event) => { event.preventDefault(); void run(signIn); }}>
    {#if !claimed}<label>Your name<input bind:value={name} required maxlength="120" autocomplete="name" /></label><label>Claim key<input bind:value={proof} required autocomplete="off" type="password" /></label><p class="hint">Read the claim key from the private Manager data folder on your server.</p>{/if}
    <label>Password<input type="password" bind:value={password} required minlength={claimed ? 1 : 14} maxlength="256" autocomplete={claimed ? 'current-password' : 'new-password'} /></label>
    <button class="primary" disabled={busy}>{claimed ? 'Sign in' : 'Create administrator'}</button>
  </form>
{:else if screen === 'welcome'}
  <p class="lede">Bring your library home. We’ll take care of the setup.</p>
  <div class="choices"><button onclick={() => run(() => choose('install'))} disabled={busy}><span class="choice-icon">＋</span><strong>Set up Frameleaf</strong><span>Start a new library on this server.</span><b>Get started →</b></button>
  <button onclick={() => run(() => choose('import'))} disabled={busy}><span class="choice-icon">⇄</span><strong>Import an existing Immich installation</strong><span>Your accounts, albums and memories, in their existing home.</span><b>Find my installation →</b></button>
  <button onclick={() => screen = 'restore'} disabled={busy}><span class="choice-icon">↶</span><strong>Restore a Manager backup</strong><span>Recover your database and server configuration.</span><b>Restore →</b></button></div>
{:else if screen === 'configure'}
  <p class="lede">{kind === 'import' ? 'Choose the Immich installation to bring into Frameleaf.' : 'Choose a home for the library and a verified release.'}</p>
  <form onsubmit={(event) => { event.preventDefault(); void run(prepare); }}>
  {#if kind === 'import'}<label>Immich installation<select bind:value={sourceId} required><option value="">Select an installation</option>{#each sources as s}<option value={s.id}>{s.project ?? s.id.slice(0, 12)} · {s.version} · {s.summary.assets.toLocaleString()} items</option>{/each}</select></label>
  {:else}<label>Library location<select bind:value={mediaPath} required><option value="">Choose a mounted folder</option>{#each dashboard?.storageRoots ?? [] as root}<option value={root}>{root}</option>{/each}</select></label>{/if}
  <label>PostgreSQL appdata location<input bind:value={databaseRoot} list="database-roots" required autocomplete="off" spellcheck="false" /></label>
  <datalist id="database-roots">{#each dashboard.databaseStorage.roots as root}<option value={root}></option>{/each}</datalist>
  {#if dashboard.databaseStorage.detectedPath}<p class="hint">Unraid’s configured appdata location: <code>{dashboard.databaseStorage.detectedPath}</code>. You can change it above.</p>{/if}
  <p class="hint">Manager creates a separate PostgreSQL folder here on your host disk, outside Docker’s virtual disk. Choose an existing mounted folder. To use another disk, mount its folder into Manager at the same host path.</p>
  <label>Frameleaf release<select bind:value={tag} required><option value="">Select a verified release</option>{#each releases as r}<option value={r.tag}>{r.tag}</option>{/each}</select></label>
  <label>Application port<input type="number" bind:value={port} min="1024" max="65535" required /></label>
  <label class="check"><input type="checkbox" bind:checked={ml} /> Enable local machine learning</label><p class="hint">CPU processing. You can enable machine learning later.</p>
  <label class="check"><input type="checkbox" bind:checked={lifecycle} required /> Docker or Unraid manages this installation’s startup. I have disabled any additional scheduler or service that recreates its containers.</label>
  <button class="primary" disabled={busy || !lifecycle}>Check and review</button><button type="button" class="quiet" onclick={() => screen = 'welcome'}>Back</button></form>
{:else if screen === 'review'}
  <p class="lede">Ready to make this library yours.</p><section><h2>{review.tag}</h2>
  <h3>Database on your host disk</h3><code>{review.databaseStorage.root}</code><p class="hint">A new, separate PostgreSQL directory will be created here. {kind === 'import' ? 'The Immich database stays in its original location.' : ''}</p>
  {#if review.source}<dl><div><dt>Accounts</dt><dd>{review.source.summary.users}</dd></div><div><dt>Photos and videos</dt><dd>{review.source.summary.assets.toLocaleString()}</dd></div><div><dt>Albums</dt><dd>{review.source.summary.albums}</dd></div></dl>
  <h3>Your library stays in place</h3>{#each review.source.mounts as m}<div class="row"><code>{m.source}</code><span>→</span><code>{m.target}</code><span>{m.readOnly ? 'Read only' : 'Read and write'}</span></div>{/each}
  <div class="notice">{review.backup.action === 'reuse' ? 'A verified database backup from the last 24 hours is available. No new backup step is needed.' : 'We’ll create a database backup before starting Frameleaf.'}</div><p>{review.downtime}</p><p class="hint">{review.recovery}</p>{/if}</section>
  <button class="primary" disabled={busy} onclick={() => run(install)}>{kind === 'import' ? 'Import into Frameleaf' : 'Set up Frameleaf'}</button><button class="quiet" onclick={() => screen = 'configure'}>Back</button>
{:else if screen === 'progress'}
  <p class="lede">{operation?.state === 'complete' ? 'Frameleaf is running. Let’s make it yours.' : 'You can close this page. Manager keeps track of every step.'}</p>
  <section><h2>{operation?.step?.replaceAll('-', ' ') ?? operation?.state ?? 'Waiting'}</h2>{#each operation?.completed ?? [] as step}<div class="row"><span class="success">✓</span><span>{step.replaceAll('-', ' ')}</span></div>{/each}
  {#if operation?.error}<div class="notice error">{operation.error.replaceAll('_', ' ')}</div>{/if}
  {#if ['failed', 'interrupted'].includes(operation?.state)}<button disabled={busy} onclick={() => run(async () => { await api('resume', { id: operation.id }); await refresh(); })}>Resume safely</button>{/if}
  {#if ['failed', 'interrupted'].includes(operation?.state) && (!dashboard?.installation?.mayHaveWrittenMedia || operation?.kind === 'backup' || (operation?.kind === 'update' && operation?.step !== 'apply-release' && !operation?.completed?.includes('apply-release')))}<button disabled={busy} onclick={() => run(async () => { await api('recover', { id: operation.id }); await refresh(); })}>{operation?.kind === 'backup' ? 'Cancel backup' : operation?.kind === 'update' ? 'Cancel update and restart' : 'Recover the stopped source'}</button>{/if}</section>
  {#if operation?.state === 'complete' && !operation?.error}<button class="primary" onclick={() => screen = 'profile'}>Continue</button>{/if}
{:else if screen === 'profile'}
  <p class="lede">A little about you.</p><form onsubmit={(event) => { event.preventDefault(); void run(saveProfile); }}><div class="two"><label>First name<input bind:value={firstName} required autocomplete="given-name" /></label><label>Last name<input bind:value={lastName} autocomplete="family-name" /></label></div><label>Email<input type="email" bind:value={email} required autocomplete="email" /></label>
  <section><h2>A Frameleaf account is optional</h2><p>Keep your local account, or continue securely in Frameleaf to create or link an account.</p><label class="check"><input type="radio" bind:group={account} value="local" /> Keep my local account</label><label class="check"><input type="radio" bind:group={account} value="create" /> Create a Frameleaf account</label><label class="check"><input type="radio" bind:group={account} value="existing" /> I already have a Frameleaf account</label></section><button class="primary" disabled={busy}>Continue</button></form>
{:else if screen === 'apps'}
  <p class="lede">Your whole library. In your pocket.</p><p>Open Frameleaf to finish your local account or optional Frameleaf account setup, then link this server in the app.</p><a class="button primary" href={dashboard.appUrl + '/auth/onboarding' + (account !== 'local' ? '#frs-tool-frameleaf' : '')} target="_blank" rel="noreferrer">Open Frameleaf setup ↗</a>
  <div class="apps">{#each apps as app}<section><h2>Frameleaf for {app.name}</h2><img class="phone" src={app.image} alt={`Frameleaf ${app.name} library`} /><a class="qr" href={app.href} target="_blank" rel="noreferrer" aria-label={`Get Frameleaf for ${app.name}`}>{@html qrSvg(app.href)}</a><a href={app.href} target="_blank" rel="noreferrer">Get the {app.name} app ↗</a></section>{/each}</div>
  <section><h2>Link your server</h2><code>{dashboard.appUrl}</code><p>Sign in with your existing or new photo account. Your phone will sync your catalog, albums, search data and browsing previews while the server prepares the library. Keep the app open; if the phone pauses it, reopen to continue.</p><p class="hint">The official app pages show current availability. Original media is not downloaded as part of catalog setup.</p></section>
  <section aria-live="polite"><h2>{phases[dashboard.librarySetup?.phase] ?? 'Preparing your library'}</h2><div class="row"><span class:success={dashboard.librarySetup?.rescanComplete}>{dashboard.librarySetup?.rescanComplete ? '✓' : '○'}</span><span>Library rescan and verification</span></div><div class="row"><span class:success={dashboard.librarySetup?.canFinish}>{dashboard.librarySetup?.canFinish ? '✓' : '○'}</span><span>Phone catalog and browsing previews</span></div><p class="hint">Your phone syncs as the server works. Both screens show completion when the final library is ready on your phone.</p></section>
  <button class="primary" disabled={busy || !dashboard.librarySetup?.canFinish} onclick={() => run(async () => { await api('finish-setup', {}); await refresh(); screen = 'dashboard'; })}>Finish setup</button>
  {#if dashboard.librarySetup?.phase === 'needs-attention'}<p>Resolve the scan findings in Frameleaf’s Library Care, then run verification again.</p><button disabled={busy} onclick={() => run(async () => { await api('retry-setup', {}); await refresh(); })}>Verify the library again</button>{/if}
{:else if screen === 'dashboard'}
  <p class="lede">Your server, at a glance.</p>{#if dashboard?.installation}<section><h2>{dashboard.installation.release}</h2>{#each dashboard.services as service}<div class="row"><span class:success={service.health === 'healthy'}>●</span><strong>{service.service}</strong><span>{service.running ? service.health : 'Stopped'}</span><button class="quiet" onclick={() => run(async () => logs = (await api('logs', { id: service.id })).logs)}>Logs</button></div>{/each}<h3>PostgreSQL on your host disk</h3><code>{dashboard.installation.databasePath}</code></section><div class="actions">{#each ['start', 'stop', 'restart', 'backup'] as action}<button disabled={busy} onclick={() => run(() => control(action))}>{action === 'backup' ? 'Back up database' : action[0].toUpperCase() + action.slice(1)}</button>{/each}<button disabled={busy} onclick={() => run(chooseUpdate)}>Updates</button><button onclick={() => screen = 'export'}>Export recovery configuration</button><button onclick={() => screen = 'apps'}>{dashboard.onboardingFinished ? 'Phone setup complete' : 'Connect your phone'}</button></div>{#if logs}<pre>{logs}</pre>{/if}{:else}<p>Set up an installation to see its services here.</p><button onclick={() => screen = 'welcome'}>Set up Frameleaf</button>{/if}
{:else if screen === 'restore'}
  <p class="lede">Restore your database and configuration.</p><p>Your original library folders must be available at their preserved paths. Database backups do not contain photos or videos.</p>
  <label>PostgreSQL appdata location<input bind:value={databaseRoot} required autocomplete="off" spellcheck="false" /></label>
  {#if dashboard?.databaseStorage.detectedPath}<p class="hint">Detected from Unraid: <code>{dashboard.databaseStorage.detectedPath}</code>. You can choose another mounted folder.</p>{/if}
  <p class="hint">Restoration creates a new database directory on your host disk. Existing database files are preserved.</p>
  {#if !snapshots.length}<form onsubmit={(event) => { event.preventDefault(); void run(unlockBackups); }}><label>Recovery key<input type="password" bind:value={recoveryKey} required autocomplete="off" /></label><button class="primary" disabled={busy}>Unlock backups</button></form>{:else}<form onsubmit={(event) => { event.preventDefault(); void run(prepareRestore); }}><label>Database backup<select bind:value={snapshot} required><option value="">Select a snapshot</option>{#each snapshots as item}<option value={item.id}>{new Date(item.time).toLocaleString()}</option>{/each}</select></label><button class="primary" disabled={busy}>Review restoration</button></form>{/if}<button class="quiet" onclick={() => screen = 'welcome'}>Back</button>
{:else if screen === 'review-restore'}
  <section><h2>{restoreReview.release}</h2><p>Restore the database into a new directory under <code>{restoreReview.databaseStorage.root}</code>.</p><h3>Preserved library mappings</h3>{#each restoreReview.mounts as mount}<div class="row"><code>{mount.source}</code><span>→</span><code>{mount.target}</code></div>{/each}<p class="hint">This snapshot contains the database and configuration. Media must already be available at these paths.</p></section><button class="primary" disabled={busy} onclick={() => run(restore)}>Restore Frameleaf</button><button class="quiet" onclick={() => screen = 'restore'}>Back</button>
{:else if screen === 'update'}
  <p class="lede">Choose when to update.</p><form onsubmit={(event) => { event.preventDefault(); void run(async () => { updateReview = await api('review-update', { tag }); }); }}><label>Eligible release<select bind:value={tag} required><option value="">Select a release</option>{#each releases.filter(r => r.tag !== dashboard.installation.release) as release}<option value={release.tag}>{release.tag}</option>{/each}</select></label><button disabled={busy}>Verify and review update</button></form>
  {#if updateReview}<section><h2>{updateReview.from} → {updateReview.to}</h2><p>Manager downloads the compatible images and saves a database checkpoint before applying this release.</p><p class="hint">{updateReview.recovery}</p></section><button class="primary" disabled={busy} onclick={() => run(async () => { await api('update', { id: updateReview.id, key: crypto.randomUUID() }); await refresh(); screen = 'progress'; })}>Update Frameleaf</button>{/if}<button class="quiet" onclick={() => screen = 'dashboard'}>Back</button>
{:else if screen === 'export'}
  <p class="lede">Keep a private copy for recovery.</p><p>This file includes your deployment configuration and backup recovery key. Store it securely.</p><form onsubmit={(event) => { event.preventDefault(); void run(exportConfiguration); }}><label>Manager password<input type="password" bind:value={password} required autocomplete="current-password" /></label><button class="primary" disabled={busy}>Download recovery configuration</button></form><button class="quiet" onclick={() => screen = 'dashboard'}>Back</button>
{/if}
</main><aside><div class="nav-title">{labels[screen] ?? 'RECOVERY'}</div><img class="brand-icon" src="/assets/frameleaf-app-icon.svg" alt=""/><h2>At home with Frameleaf.</h2><p>Your media lives on your server. Manager handles installation and recovery, and Frameleaf keeps running when Manager is offline.</p><div class="aside-rule"></div><p>Database backups only.<br/>No Frameleaf account required.<br/>Updates happen when you choose.</p></aside></div>
