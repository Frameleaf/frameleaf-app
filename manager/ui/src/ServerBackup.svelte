<script lang="ts">
  // FL-1668: the Server Backup workspace, on the state Manager serves at `manager-api/server-backup`.
  // The screens follow the mock approved in FL-1664. FL-1672 adds the ones that need Frameleaf Cloud:
  // connecting, and restoring on a server that replaces another. `data.cloud` is null where backups go
  // to a folder, and then none of that is shown.
  import { untrack } from 'svelte';
  import FolderPicker from './FolderPicker.svelte';
  import Icon from './Icon.svelte';
  import { formatBytes, midSentence } from './presentation';
  import { when } from './OverviewPage.svelte';

  type Settings = {
    folders: string[];
    exclusions: string[];
    schedule: { time: string; stop: string | null };
    limitMbps: number | null;
    retention: { keepLast: number; keepDays: number; keepMonthly: number };
  };
  type Entry = { name: string; type: 'folder' | 'file'; bytes: number; modified: number };

  let { data, page, go, openPhotos, api, run, busy, change, refresh, photos, photosPath } = $props<{
    data: any;
    page: string;
    go: (page: string) => void;
    openPhotos: () => void;
    api: (path: string, body?: unknown) => Promise<any>;
    run: (work: () => Promise<void>) => Promise<void>;
    busy: boolean;
    change: (view: any) => void;
    refresh: () => Promise<void>;
    photos: { name: string; running: boolean } | null;
    photosPath: string | null;
  }>();

  const clone = (settings: Settings): Settings => JSON.parse(JSON.stringify(settings));
  // What is being edited. It follows the server until the owner changes something here.
  let draft = $state<Settings>(untrack(() => clone(data.settings)));
  let edited = $state(false);
  $effect(() => {
    if (!edited) draft = clone(data.settings);
  });

  type Step = '' | 'connect' | 'folders' | 'key' | 'schedule' | 'server' | 'oldkey' | 'restore';
  const stepNames: Record<string, string> = { connect: 'Connect Cloud', folders: 'Choose folders', key: 'Save your key', schedule: 'Schedule', server: 'Choose server', oldkey: 'Recovery key', restore: 'Choose what to restore' };
  const cloud = $derived(data.cloud);
  // Setting up, or bringing back what an older server stored. '' is neither.
  let flow = $state<'setup' | 'restore'>('setup');
  let step = $state<Step>('');
  const order = $derived<Step[]>(flow === 'restore' ? ['connect', 'server', 'oldkey', 'restore'] : cloud ? ['connect', 'folders', 'key', 'schedule'] : ['folders', 'key', 'schedule']);
  const move = (by: number) => (step = order[order.indexOf(step) + by] ?? '');
  let firstKey = $state('');
  let saved = $state(false);
  let picking = $state<'folder' | 'restore' | null>(null);

  let shownKey = $state('');
  let password = $state('');

  let snapshot = $state<string>(untrack(() => data.snapshots[0]?.key ?? ''));
  let path = $state<string[]>([]);
  let entries = $state<Entry[] | null>(null);
  let picked = $state<string[]>([]);
  let destination = $state(false);
  let into = $state<string | null>(null);

  const always = $derived(data.folders.filter((folder: any) => folder.kind === 'manager'));
  const chosen = $derived(draft.folders.map((folder) => ({ path: folder, ...(data.folders.find((item: any) => item.path === folder) ?? {}) })));
  const protectedBytes = $derived(data.folders.reduce((sum: number, folder: any) => sum + (folder.bytes ?? 0), 0));
  const measured = $derived(data.folders.some((folder: any) => folder.bytes !== undefined));
  const running = $derived(data.running);
  const failed = $derived(data.last?.state === 'failed');
  const percent = $derived(running?.totalBytes ? Math.min(100, Math.floor((running.bytes / running.totalBytes) * 100)) : 0);
  const pickedBytes = $derived((entries ?? []).filter((entry) => picked.includes(entry.name)).reduce((sum, entry) => sum + entry.bytes, 0));
  const photosProtected = $derived(!!photosPath && draft.folders.includes(photosPath));

  // While something runs the page keeps up with it; otherwise a slow check is enough.
  $effect(() => {
    const timer = setInterval(() => void refresh().catch(() => undefined), running ? 2000 : 15_000);
    return () => clearInterval(timer);
  });

  const act = (route: string, body: unknown = {}) => run(async () => change(await api(route, body)));
  const saveSettings = () =>
    run(async () => {
      change(await api('server-backup-settings', draft));
      edited = false;
    });
  function edit(apply: (settings: Settings) => void, save = data.state === 'on') {
    apply(draft);
    edited = true;
    if (save) void saveSettings();
  }

  function begin(which: 'setup' | 'restore', at?: Step) {
    flow = which;
    step = at ?? order[0]!;
    if (which === 'setup') edited = true;
  }
  const showFirstKey = () =>
    run(async () => {
      // A key already confirmed (this server's own, after connecting again) is not shown again without the password.
      if (data.key.saved) return void (step = 'schedule');
      firstKey = (await api('server-backup-first-key', {})).code;
      step = 'key';
    });

  // Connect Cloud. A code is asked for once on arriving; after that only the button asks, so a Cloud that
  // can't be reached is not asked over and over.
  let codeAsked = false;
  let linkEnded = $state<'' | 'refused' | 'expired'>('');
  let places = $state<{ locationId: string; city: string; country: string }[]>([]);
  let place = $state('');
  const getCode = () => {
    linkEnded = '';
    return run(async () => change(await api('server-backup-cloud-link', {})));
  };
  $effect(() => {
    if (step !== 'connect' || cloud?.state !== 'unlinked' || codeAsked) return;
    codeAsked = true;
    untrack(() => void getCode());
  });
  // Looks for the owner's approval at the pace Cloud asked for.
  $effect(() => {
    if (step !== 'connect' || cloud?.state !== 'linking') return;
    const timer = setInterval(async () => {
      const view = await api('server-backup-cloud-check', {}).catch(() => null);
      if (!view) return;
      if (view.linking === 'refused' || view.linking === 'expired') linkEnded = view.linking;
      change(view);
    }, (cloud.code?.intervalSec ?? 5) * 1000);
    return () => clearInterval(timer);
  });
  const needsPlace = $derived(flow === 'setup' && cloud?.state === 'linked' && !cloud.locationId);
  $effect(() => {
    if (step !== 'connect' || !needsPlace || places.length) return;
    untrack(() => void api('server-backup-cloud-locations', {}).then((answer) => ((places = answer.locations), (place = places[0]?.locationId ?? ''))).catch(() => undefined));
  });
  const connected = () =>
    run(async () => {
      if (needsPlace) change(await api('server-backup-cloud-location', { locationId: place }));
      move(1);
    });
  const shortAddress = (address: string) => {
    const url = new URL(address);
    return url.host + url.pathname.replace(/\/$/, '');
  };

  // Choose server: the account's other servers that have backups, then the owner's approval in Cloud.
  let machines = $state<{ instanceId: string; name: string; lastBackupAt: string | null }[] | null>(null);
  let from = $state('');
  let answered = $state('');
  $effect(() => {
    if (step !== 'server' || cloud?.takeover || machines !== null) return;
    untrack(() => void run(async () => ((machines = (await api('server-backup-cloud-machines', {})).machines), (from = machines![0]?.instanceId ?? ''))));
  });
  const askTakeover = () =>
    run(async () => {
      answered = '';
      change(await api('server-backup-cloud-takeover', { instanceId: from }));
    });
  $effect(() => {
    if (step !== 'server' || !cloud?.takeover) return;
    const timer = setInterval(async () => {
      const view = await api('server-backup-cloud-takeover-check', {}).catch(() => null);
      if (!view) return;
      change(view);
      if (view.takeover === 'approved') step = 'oldkey';
      else if (view.takeover !== 'pending') ((answered = view.takeover), (machines = null));
    }, 10_000);
    return () => clearInterval(timer);
  });
  // Choose what to restore: what the chosen backup protected, each folder going back where it was.
  type Kept = { path: string; kind: 'manager' | 'folder'; files: number; bytes: number; reachable: boolean };
  let kept = $state<Kept[] | null>(null);
  let keptFor = '';
  let wanted = $state<string[]>([]);
  let byFile = $state(false);
  $effect(() => {
    if (step !== 'restore' || !snapshot || keptFor === snapshot) return;
    keptFor = snapshot;
    untrack(
      () =>
        void api('server-backup-contents', { snapshot })
          .then((answer) => ((kept = answer.folders), (wanted = (answer.folders ?? []).filter((folder: Kept) => folder.reachable).map((folder: Kept) => folder.path))))
          .catch(() => (kept = null)),
    );
  });
  const wantedBytes = $derived((kept ?? []).filter((folder) => wanted.includes(folder.path)).reduce((sum, folder) => sum + folder.bytes, 0));
  const want = (path: string) => (wanted = wanted.includes(path) ? wanted.filter((item) => item !== path) : [...wanted, path]);
  const restoreWhole = () => run(async () => change(await api('server-backup-restore', { snapshot, items: wanted.map((path) => path.split('/').filter(Boolean)), into: null })));
  /**
   * The recovery kit: a page to print or keep, with the key and how to use it. Made here, in the browser,
   * from the key already on screen; nothing else leaves Manager.
   */
  function downloadKit(code: string) {
    const server = location.hostname;
    const made = new Date().toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' });
    const escape = (text: string) => text.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`);
    const page = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Server Backup recovery kit · ${escape(server)}</title>
<style>body{font:15px/1.6 system-ui,sans-serif;max-width:680px;margin:48px auto;padding:0 24px;color:#111}h1{font-size:26px;margin:0 0 4px}.meta{color:#555}.key{font:600 20px/1.7 ui-monospace,monospace;letter-spacing:1px;border:2px dashed #999;border-radius:10px;padding:18px;margin:24px 0;word-break:break-all}li{margin:6px 0}.warn{border-left:4px solid #c80;padding:8px 14px;background:#fff8ec}</style>
<h1>Frameleaf Server Backup: recovery kit</h1><p class="meta">Server: ${escape(server)} · Made ${escape(made)}</p>
<p>This key opens the backups Server Backup keeps of this server in Frameleaf Cloud. It is the only way to open them. Frameleaf never receives it and can't recover it for you.</p>
<p class="key">${escape(code)}</p>
<h2>If this server is lost</h2><ol><li>Install Frameleaf Manager on the new server and sign in.</li><li>Open Server Backup and choose <b>Restore this server from a backup you already have</b>.</li><li>Connect to your Frameleaf Cloud account, choose this server (${escape(server)}), and approve the request in your account.</li><li>Enter the key above. Upper or lower case and spaces don't matter.</li><li>Choose what to restore.</li></ol>
<p class="warn">Keep this somewhere safe and away from this server: printed, or in a password manager. Anyone who has this key and can sign in to your Frameleaf Cloud account can read these backups.</p></html>`;
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([page], { type: 'text/html' }));
    link.download = `frameleaf-server-backup-recovery-kit-${server.replace(/[^a-z0-9.-]/gi, '-')}.html`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
  }
  let kitAfterReveal = $state(false);
  let passwordField = $state<HTMLInputElement | null>(null);
  const reveal = () =>
    run(async () => {
      shownKey = (await api('server-backup-key', { password })).code;
      password = '';
      if (kitAfterReveal) downloadKit(shownKey);
      kitAfterReveal = false;
    });

  // Settings: storage used, and disconnecting from Frameleaf Cloud.
  let usage = $state<{ bytesCurrent: number; allowanceBytes: number } | null>(null);
  $effect(() => {
    if (page !== 'settings' || cloud?.state !== 'linked' || usage) return;
    untrack(() => void api('server-backup-cloud-usage', {}).then((answer) => (usage = answer)).catch(() => undefined));
  });
  // Deleting this server's backups: Cloud holds them 30 days first, and they can be kept until then.
  let purge = $state<{ status: string; holdUntil: string; cancellable: boolean } | null | undefined>(undefined);
  $effect(() => {
    if ((page !== 'settings' && data.state === 'on') || cloud?.state !== 'linked' || purge !== undefined) return;
    untrack(() => void api('server-backup-cloud-purge', {}).then((answer) => (purge = answer.purge)).catch(() => (purge = null)));
  });
  let deleting = $state(false);
  let deletePassword = $state('');
  const deleteBackups = () =>
    run(async () => {
      const answer = await api('server-backup-delete', { password: deletePassword });
      deletePassword = '';
      deleting = false;
      purge = answer.purge;
      change(answer);
    });
  const keepBackups = () => run(async () => ((purge = null), change(await api('server-backup-keep', {}))));
  const day = (iso: string) => new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' });
  let disconnecting = $state(false);
  const disconnect = () =>
    run(async () => {
      change(await api('server-backup-cloud-disconnect', {}));
      disconnecting = false;
      usage = null;
      go('overview');
    });

  // A fresh server's "Restore this server" lands here.
  $effect(() => {
    if (page !== 'restore-server' || !cloud) return;
    untrack(() => {
      begin('restore', cloud.state === 'linked' ? 'server' : 'connect');
      go('overview');
    });
  });

  // The locked copy of the key in Frameleaf Cloud: off unless the owner turns it on.
  let copying = $state<'on' | 'off' | null>(null);
  let copyPassword = $state('');
  let passphrase = $state('');
  let passphraseAgain = $state('');
  const copyProblem = $derived(copying !== 'on' ? '' : passphrase.length > 0 && passphrase.length < 12 ? 'Use at least 12 characters.' : passphraseAgain && passphrase !== passphraseAgain ? 'The two passphrases are different.' : '');
  const saveCopy = () =>
    run(async () => {
      change(await api('server-backup-key-copy', { password: copyPassword, passphrase: copying === 'on' ? passphrase : null }));
      copying = null;
      copyPassword = passphrase = passphraseAgain = '';
    });
  // On a replacement server: open the older server's backups with its locked copy instead of the key.
  let useCopy = $state(false);
  let copyPassphrase = $state('');
  const adoptCopy = () =>
    run(async () => {
      change(await api('server-backup-adopt-key-copy', { passphrase: copyPassphrase }));
      copyPassphrase = '';
      snapshot = data.snapshots[0]?.key ?? '';
      entries = null;
      step = 'restore';
    });
  let oldKey = $state('');
  const adoptKey = () =>
    run(async () => {
      change(await api('server-backup-adopt-key', { key: oldKey }));
      oldKey = '';
      snapshot = data.snapshots[0]?.key ?? '';
      entries = null;
      step = 'restore';
    });
  const finishSetup = () =>
    run(async () => {
      await api('server-backup-turn-on', draft);
      await api('server-backup-key-saved', {});
      change(await api('server-backup-run', {}));
      edited = false;
      // The key was on screen only to be saved; it is not kept around once it is.
      firstKey = '';
      step = '';
      go('overview');
    });

  async function open(next: string[]) {
    path = next;
    picked = [];
    destination = false;
    entries = null;
    if (!snapshot) return;
    await run(async () => {
      entries = (await api('server-backup-browse', { snapshot, path: next })).entries;
    });
  }
  $effect(() => {
    if ((step === 'restore' || (data.state === 'on' && page === 'restore')) && entries === null && snapshot && !busy) void open(path);
  });
  const toggle = (name: string) => (picked = picked.includes(name) ? picked.filter((item) => item !== name) : [...picked, name]);
  const startRestore = () =>
    run(async () => {
      change(await api('server-backup-restore', { snapshot, items: picked.map((name) => [...path, name]), into }));
      picked = [];
      destination = false;
    });

  const minutes = (item: any) => Math.max(1, Math.round(((item.finishedAt ?? Date.now()) - item.startedAt) / 60_000));
  const took = (item: any) => `took ${minutes(item)} ${minutes(item) === 1 ? 'minute' : 'minutes'}`;
  function nextText(time: number) {
    const date = new Date(time);
    const clock = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const days = Math.round((new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() - new Date(new Date().setHours(0, 0, 0, 0)).getTime()) / 86_400_000);
    return days === 0 ? `${date.getHours() >= 18 || date.getHours() < 6 ? 'tonight' : 'today'} at ${clock}` : days === 1 ? `tomorrow at ${clock}` : `${date.toLocaleDateString([], { weekday: 'long' })} at ${clock}`;
  }
  function left(seconds: number | null) {
    if (seconds === null) return '';
    if (seconds < 90) return 'about a minute left';
    if (seconds < 5400) return `about ${Math.round(seconds / 60)} minutes left`;
    return `about ${Math.round(seconds / 3600)} hours left`;
  }
  const problem: Record<string, string> = {
    worker_exited: 'It stopped unexpectedly.',
    manager_restarted: 'Manager restarted while it ran.',
    stopped: 'It was stopped.',
    cloud_unreachable: 'Frameleaf Cloud could not be reached.',
    cloud_entitlement_missing_licence: 'This server needs a Server licence to back up to Frameleaf Cloud.',
    cloud_entitlement_missing_plan: 'This account needs a Frameleaf Cloud plan to back up.',
    cloud_lease_held: 'Frameleaf Cloud had another backup of this server under way.',
    cloud_lease_lost: 'Frameleaf Cloud ended this backup’s turn, so it stopped at once.',
    cloud_record_failed: 'It was stored, but Frameleaf Cloud could not record it. The next backup records it first.',
    server_backup_cloud_no_location: 'No place to store backups has been chosen.',
    server_backup_cloud_not_linked: 'This server is not connected to Frameleaf Cloud.',
  };
  /** Refused before anything was read or sent. */
  const neverStarted = (error: string | null) => !!error && /^(cloud_|server_backup_cloud_)/.test(error) && !['cloud_lease_lost', 'cloud_record_failed'].includes(error);
  /** One line of history in plain words. */
  function told(item: any): { icon: string; title: string; detail: string } {
    const what = item.kind === 'restore' ? 'Restore' : item.kind === 'verify' ? 'Check' : 'Backup';
    if (item.state === 'running') return { icon: 'update', title: `${what} running`, detail: 'Started ' + midSentence(when(item.startedAt)) + '.' };
    if (item.state === 'stopped') return { icon: 'stop', title: `${what} stopped`, detail: item.kind === 'backup' ? 'What was stored is kept. The next backup carries on from there.' : (problem[item.error] ?? 'It was stopped.') };
    if (item.state === 'failed') return { icon: 'warning', title: `${what} didn’t finish`, detail: (problem[item.error] ?? item.error ?? 'Something went wrong.') + (item.kind === 'backup' && !neverStarted(item.error) ? ' The next backup carries on from where this one got to.' : '') };
    const outcome = item.outcome ?? {};
    if (item.kind === 'restore')
      return { icon: 'restore', title: `Restored ${outcome.files.toLocaleString()} ${outcome.files === 1 ? 'file' : 'files'}`, detail: formatBytes(outcome.bytes) + (outcome.movedAside ? ` · ${outcome.movedAside} already there, kept under another name` : '') };
    if (item.kind === 'verify')
      return outcome.missing || outcome.damaged
        ? { icon: 'warning', title: 'Check found a problem', detail: `${outcome.missing} stored pieces are missing and ${outcome.damaged} backups can’t be opened.` }
        : { icon: 'shield', title: 'Check passed', detail: `All ${outcome.snapshots} backups can be restored.` };
    return {
      icon: 'check-circle',
      title: 'Backed up',
      detail: `${formatBytes(outcome.storedBytes)} new · ${outcome.files.toLocaleString()} files · ${took(item)}` + (outcome.problems ? ` · ${outcome.problems} couldn’t be read` : ''),
    };
  }

  const keeps = [
    { label: '90 days, then one a month for a year', value: { keepLast: 3, keepDays: 90, keepMonthly: 12 } },
    { label: '30 days, then one a month for a year', value: { keepLast: 3, keepDays: 30, keepMonthly: 12 } },
    { label: 'A year of every backup', value: { keepLast: 3, keepDays: 365, keepMonthly: 0 } },
  ];
  const keepIndex = $derived(Math.max(0, keeps.findIndex((keep) => JSON.stringify(keep.value) === JSON.stringify(draft.retention))));
</script>

{#snippet heading(title: string, subtitle: string)}
  <div class="page-heading"><div class="spread"><h1 tabindex="-1">{title}</h1></div><p>{subtitle}</p></div>
{/snippet}
{#snippet steps(items: string[], current: number)}
  <ol class="steps" aria-label="Progress">{#each items as item, index}<li class:active={index === current} class:complete={index < current} aria-current={index === current ? 'step' : undefined}><span class="step-number">{#if index < current}<Icon name="check" />{:else}{index + 1}{/if}</span><span>{item}</span></li>{/each}</ol>
{/snippet}
{#snippet folderRows(removable: boolean)}
  {#each always as folder, index}
    <div class="list-row sb-stack" class:sb-first={index === 0}><Icon name="settings" /><div class="grow"><strong>Manager’s recovery points</strong><p>What Manager needs to bring your photo library’s albums, people and settings back.</p></div>{#if folder.bytes !== undefined}<span class="sb-size">{formatBytes(folder.bytes)}</span>{/if}<span class="badge">Always included</span></div>
  {/each}
  {#each chosen as folder}
    <div class="list-row"><Icon name={folder.path === photosPath ? 'images' : 'folder'} /><div class="grow"><strong>{folder.path}</strong><p>{folder.files !== undefined ? `${folder.files.toLocaleString()} files` : 'Measured at the next backup'}</p></div>{#if folder.bytes !== undefined}<span class="sb-size">{formatBytes(folder.bytes)}</span>{/if}{#if removable}<button class="button quiet" disabled={busy} onclick={() => edit((settings) => (settings.folders = settings.folders.filter((item) => item !== folder.path)))}>Remove</button>{/if}</div>
  {/each}
{/snippet}
{#snippet leftOut()}
  {#if photosPath && !photosProtected}
    <section class="card mt16">
      <div class="card-header"><h2>Left out</h2></div>
      <div class="list-row sb-first sb-stack"><Icon name="images" /><div class="grow"><strong>Your photo library</strong><p>{photosPath} · Cloud Backup in Frameleaf looks after it. Adding it here stores it a second time.</p></div><button class="button quiet" disabled={busy} onclick={() => edit((settings) => settings.folders.push(photosPath!))}>Add anyway</button></div>
    </section>
  {/if}
{/snippet}
{#snippet scheduleFields()}
  <div class="sb-fields">
    <label class="field"><span>Back up every day at</span><input type="time" value={draft.schedule.time} onchange={(event) => edit((settings) => (settings.schedule.time = event.currentTarget.value || settings.schedule.time), false)} /></label>
    <label class="field"><span>Stop by</span><input type="time" value={draft.schedule.stop ?? ''} onchange={(event) => edit((settings) => (settings.schedule.stop = event.currentTarget.value || null), false)} /><small class="muted">Leave empty for no stop time. A backup that is stopped carries on the next night.</small></label>
    <label class="field"><span>Upload speed limit, in Mbit/s</span><input type="number" min="1" max="10000" placeholder="No limit" value={draft.limitMbps ?? ''} onchange={(event) => edit((settings) => (settings.limitMbps = Number(event.currentTarget.value) > 0 ? Number(event.currentTarget.value) : null), false)} /></label>
    <label class="field"><span>Keep earlier versions for</span><select value={keepIndex} onchange={(event) => edit((settings) => (settings.retention = keeps[Number(event.currentTarget.value)]!.value), false)}>{#each keeps as keep, index}<option value={index}>{keep.label}</option>{/each}</select><small class="muted">Deleted and changed files stay restorable for this long.</small></label>
  </div>
{/snippet}
{#snippet history(items: any[])}
  {#each items as item, index}
    {@const line = told(item)}
    <div class="list-row sb-run" class:sb-first={index === 0} class:sb-failed={line.icon === 'warning'}><Icon name={line.icon} /><div class="grow"><strong>{line.title}</strong><p>{line.detail}</p></div><span class="meta sb-when">{when(item.finishedAt ?? item.startedAt)}</span></div>
  {:else}
    <div class="card-body"><p class="muted">Nothing has run yet.</p></div>
  {/each}
{/snippet}

{#snippet restoreBody()}
  {#if data.snapshots.length === 0}
    <section class="card"><div class="card-body"><p class="muted">There is nothing to restore until the first backup finishes.</p></div></section>
  {:else}
    <section class="card">
      <div class="sb-toolbar">
        <label class="sb-date"><span class="meta">As it was on</span><select aria-label="Backup date" bind:value={snapshot} onchange={() => open(path)}>{#each data.snapshots as item}<option value={item.key}>{when(item.time)}</option>{/each}</select></label>
        {#if path.length}<button class="button quiet" onclick={() => open([])}>Go to the top</button>{/if}
      </div>
      <nav class="sb-path" aria-label="Folder"><button class="text-button sb-plain" aria-current={path.length === 0 ? 'page' : undefined} onclick={() => open([])}>This server</button>{#each path as part, index}<Icon name="chevron" /><button class="text-button sb-plain" aria-current={index === path.length - 1 ? 'page' : undefined} onclick={() => open(path.slice(0, index + 1))}>{part}</button>{/each}</nav>
      {#each entries ?? [] as entry (entry.name)}
        <div class="list-row sb-entry">
          <input type="checkbox" aria-label="Select {entry.name}" checked={picked.includes(entry.name)} onchange={() => toggle(entry.name)} />
          <Icon name={entry.type === 'folder' ? 'folder' : 'document'} />
          <div class="grow">{#if entry.type === 'folder'}<button class="sb-open" onclick={() => open([...path, entry.name])}><strong>{entry.name}</strong></button>{:else}<strong>{entry.name}</strong><p>Changed {midSentence(when(entry.modified))}</p>{/if}</div>
          {#if entry.type === 'file'}<span class="sb-size">{formatBytes(entry.bytes)}</span>{/if}
        </div>
      {:else}
        <div class="card-body"><p class="muted">{entries === null ? 'Opening this backup…' : 'This folder was empty.'}</p></div>
      {/each}
      <div class="card-footer"><span>{picked.length ? `${picked.length} selected${pickedBytes ? ` · ${formatBytes(pickedBytes)}` : ''}` : 'Nothing selected'}</span><button class="button primary" disabled={!picked.length || !!running} onclick={() => (destination = true)}>Restore…</button></div>
    </section>
    {#if destination}
      <section class="card mt16">
        <div class="card-header"><h2>Where should they go?</h2></div>
        <label class="list-row sb-check sb-first"><input type="radio" name="sb-target" checked={into === null} onchange={() => (into = null)} /><div class="grow"><strong>Back where they were</strong><p>A file already there is kept and renamed with today’s date. Nothing is deleted.</p></div></label>
        <label class="list-row sb-check"><input type="radio" name="sb-target" checked={into !== null} onchange={() => (picking = 'restore')} /><div class="grow"><strong>Into another folder</strong><p>{into ?? 'Choose a folder on this server. The original folders are not touched.'}</p></div>{#if into !== null}<button class="button quiet" onclick={() => (picking = 'restore')}>Change…</button>{/if}</label>
        <div class="card-footer"><button class="button quiet" onclick={() => (destination = false)}>Cancel</button><button class="button primary" disabled={busy} onclick={startRestore}>Restore {picked.length} {picked.length === 1 ? 'item' : 'items'}</button></div>
      </section>
    {/if}
  {/if}
{/snippet}
{#snippet restoringNow()}
  {#if running?.kind === 'restore'}
    <section class="card sb-status mb16" data-tone="running">
      <div class="sb-status-body">
        <span class="sb-mark"><Icon name="restore" /></span>
        <div><span class="sb-eyebrow">Restoring now</span><h2>{running.files.toLocaleString()} files · {formatBytes(running.bytes)}</h2><p class="meta">Files already there are kept under another name.</p></div>
        <button class="button quiet" disabled={busy} onclick={() => act('server-backup-stop')}><Icon name="stop" />Stop</button>
      </div>
    </section>
  {/if}
{/snippet}

{#if data.state !== 'on' && step === ''}
  {@render heading('Server Backup', 'Keep a private, encrypted copy of this server’s other folders.')}
  <section class="card">
    <div class="card-body sb-intro">
      <span class="sb-mark"><Icon name="shield" /></span>
      <div>
        <h2>Protect more than your photos</h2>
        <ul class="checklist">
          <li><Icon name="check" /><span>Choose any folders on this server: documents, app data, family shares.</span></li>
          <li><Icon name="check" /><span>Everything is encrypted here first. File names and contents open only with your recovery key.</span></li>
          <li><Icon name="check" /><span>After the first backup, only what changed is sent.</span></li>
          <li><Icon name="check" /><span>Restore one file, one folder or everything, as it was on the day you choose.</span></li>
        </ul>
      </div>
    </div>
    <div class="card-footer">
      {#if cloud && data.snapshots.length}<button class="text-button sb-plain" onclick={() => begin('restore', 'restore')}>Restore from the {data.snapshots.length} backups stored</button>
      {:else if cloud}<button class="text-button sb-plain" onclick={() => begin('restore', cloud.state === 'linked' ? 'server' : 'connect')}>Restore this server from a backup you already have</button>
      {:else}<span class="muted">{data.snapshots.length ? `${data.snapshots.length} earlier backups are still stored and can be restored once it is on.` : 'Three steps. Nothing is sent until you start the first backup.'}</span>{/if}
      <button class="button primary" disabled={busy} onclick={() => begin('setup')}>Set up Server Backup</button>
    </div>
  </section>
  {#if purge?.status === 'held'}<div class="notice warning mt16"><Icon name="warning" /><div class="grow"><strong>This server’s backups will be deleted on {day(purge.holdUntil)}</strong><p>You asked for them to be deleted. Restores still work until then.</p></div>{#if purge.cancellable}<button class="button" disabled={busy} onclick={keepBackups}>Keep my backups</button>{/if}</div>{/if}
  {#if cloud?.takeover}<div class="notice warning mt16"><Icon name="clock" /><div class="grow"><strong>Waiting for your approval in Frameleaf Cloud</strong><p>This server asked to restore from another server’s backups.</p></div><button class="button" onclick={() => begin('restore', 'server')}>Continue</button></div>{/if}
  {#if cloud}
    <section class="card mt16">
      <div class="card-header"><h2>What you need</h2></div>
      <div class="list-row sb-first"><Icon name="key" /><div class="grow"><strong>Server licence</strong><p>The one your photo server has covers Server Backup too.</p></div></div>
      <div class="list-row"><Icon name="server" /><div class="grow"><strong>Frameleaf Cloud plan</strong><p>Server Backup shares the plan’s storage with Cloud Backup.</p></div></div>
    </section>
  {/if}
  <div class="notice mt16"><Icon name="images" /><div><strong>Your photos are looked after separately</strong><p>Cloud Backup in Frameleaf protects your photo library. Server Backup leaves that folder out unless you add it.</p></div></div>
{:else if data.state !== 'on'}
  {#if flow === 'restore'}{@render heading('Restore this server', 'Bring back your folders from the backups another server stored.')}
  {:else}{@render heading('Set up Server Backup', `${order.length === 4 ? 'Four' : 'Three'} steps. Nothing is sent until you start the first backup.`)}{/if}
  {@render steps(order.map((name) => stepNames[name]!), order.indexOf(step))}
  {#if step === 'connect'}
    <section class="card">
      <div class="card-header"><h2>Connect this server to Frameleaf Cloud</h2></div>
      {#if cloud.state === 'linked'}
        <div class="list-row sb-first"><Icon name="check-circle" /><div class="grow"><strong>Connected as {cloud.account.label}</strong><p>{cloud.account.email}</p></div></div>
        {#if needsPlace && places.length > 1}
          <div class="card-body sb-place"><label class="field sb-narrow"><span>Store backups in</span><select bind:value={place}>{#each places as item}<option value={item.locationId}>{item.city}, {item.country}</option>{/each}</select><small class="muted">Chosen once. This server’s backups stay there.</small></label></div>
        {/if}
      {:else if cloud.code}
        <div class="card-body sb-connect">
          <div><p class="muted">On your phone or computer, open</p><p><a class="sb-address" href={cloud.code.approveAt} target="_blank" rel="noreferrer">{shortAddress(cloud.code.approveAt)}</a></p><p class="muted sb-then">and enter this code</p><p class="sb-code">{cloud.code.userCode}</p></div>
          <p class="sb-waiting"><span class="spinner"></span>Waiting for you to approve…</p>
        </div>
      {:else}
        <div class="card-body stack"><p class="muted">{linkEnded === 'refused' ? 'That request was turned down on the account site.' : linkEnded === 'expired' ? 'That code ran out before it was approved.' : 'Manager asks Frameleaf Cloud for a code, and you approve it on your account.'}</p><div><button class="button" disabled={busy} onclick={getCode}>Get a {linkEnded ? 'new ' : ''}code</button></div></div>
      {/if}
      <div class="card-footer"><span class="muted sb-lock"><Icon name="lock" />Manager never sees your Cloud password.</span><div class="actions"><button class="button quiet" onclick={() => (step = '')}>Back</button><button class="button primary" disabled={busy || cloud.state !== 'linked' || (needsPlace && !place)} onclick={connected}>Continue<Icon name="arrow" /></button></div></div>
    </section>
    <div class="notice mt16"><Icon name="server" /><div><strong>Manager gets its own connection</strong><p>Backups and restores keep working when Frameleaf is stopped, and on a new server before Frameleaf is installed.</p></div></div>
  {:else if step === 'server'}
    <section class="card">
      <div class="card-header"><h2>Which server’s backups?</h2></div>
      {#if cloud.takeover}
        <div class="card-body sb-connect">
          <div><strong>Approve this in Frameleaf Cloud</strong><p class="muted sb-note">We’ve emailed {cloud.account.email}. Open your Frameleaf Cloud account and approve this server taking over those backups. The request ends after three days.</p></div>
          <p class="sb-waiting"><span class="spinner"></span>Waiting for you to approve…</p>
        </div>
      {:else}
        {#each machines ?? [] as machine, index}
          <label class="list-row sb-check" class:sb-first={index === 0}><input type="radio" name="sb-from" checked={from === machine.instanceId} onchange={() => (from = machine.instanceId)} /><Icon name="server" /><div class="grow"><strong>{machine.name}</strong><p>{machine.lastBackupAt ? `Last backup ${midSentence(when(machine.lastBackupAt))}` : 'No backup recorded yet'}</p></div></label>
        {:else}
          <div class="card-body"><p class="muted">{machines === null ? 'Looking in your account…' : 'No other server in this account has backups in Frameleaf Cloud.'}</p></div>
        {/each}
      {/if}
      <div class="card-footer"><span class="muted">{answered ? `That request was ${answered === 'denied' ? 'turned down' : 'not answered in time'}. Choose a server to ask again.` : 'Only you can approve this, in your Frameleaf Cloud account.'}</span><div class="actions"><button class="button quiet" onclick={() => (step = '')}>Back</button>{#if !cloud.takeover}<button class="button primary" disabled={busy || !from} onclick={askTakeover}>Ask to restore from it</button>{/if}</div></div>
    </section>
    <div class="notice warning mt16"><Icon name="warning" /><div><strong>The old server stops backing up when you approve</strong><p>Its backups carry on from this server. If the old server is still running, it can no longer back up or restore.</p></div></div>
  {:else if step === 'oldkey'}
    <section class="card">
      <div class="card-header"><h2>Enter that server’s recovery key</h2></div>
      {#if useCopy}
      <form class="card-body stack" onsubmit={(event) => { event.preventDefault(); void adoptCopy(); }}>
        <p class="muted">If you kept a locked copy of the old server’s key in Frameleaf Cloud, its passphrase opens it here.</p>
        <label class="field sb-narrow"><span>Passphrase</span><input type="password" bind:value={copyPassphrase} required maxlength="1024" autocomplete="off" /></label>
        <div class="actions"><button class="button primary" disabled={busy || !copyPassphrase}>Open the backups</button><button type="button" class="text-button sb-plain" onclick={() => (useCopy = false)}>Enter the recovery key instead</button></div>
      </form>
      {:else}
      <form class="card-body stack" onsubmit={(event) => { event.preventDefault(); void adoptKey(); }}>
        <p class="muted">The key you saved when Server Backup was set up on the old server. It opens the backups here. Frameleaf never receives it.</p>
        <textarea class="sb-keyfield" bind:value={oldKey} rows="3" spellcheck="false" autocomplete="off" aria-label="Recovery key" placeholder="FLRK-…" required></textarea>
        <div class="actions"><button class="button primary" disabled={busy || !oldKey.trim()}>Open the backups</button><button type="button" class="text-button sb-plain" onclick={() => (useCopy = true)}>Use the locked copy in Frameleaf Cloud</button></div>
      </form>
      {/if}
    </section>
  {:else if step === 'restore'}
    {@render restoringNow()}
    {#if kept && !byFile}
      <section class="card">
        <div class="list-row sb-first sb-pick-row"><Icon name="clock" /><div class="grow"><strong>As it was on</strong><p>The newest backup is chosen. Earlier dates keep earlier versions of every file.</p></div><select class="sb-pick" aria-label="Backup date" bind:value={snapshot}>{#each data.snapshots as item}<option value={item.key}>{when(item.time)}</option>{/each}</select></div>
      </section>
      <section class="card mt16">
        <div class="card-header"><h2>What to restore</h2><span class="sb-size">{formatBytes(wantedBytes)}</span></div>
        {#each kept as folder, index}
          <label class="list-row sb-check" class:sb-first={index === 0}>
            <input type="checkbox" aria-label="Restore {folder.path}" checked={wanted.includes(folder.path)} disabled={!folder.reachable} onchange={() => want(folder.path)} />
            <Icon name={folder.kind === 'manager' ? 'settings' : 'folder'} />
            <div class="grow"><strong>{folder.kind === 'manager' ? 'Manager’s photo recovery points' : folder.path}</strong><p>{!folder.reachable ? `Manager can’t reach ${folder.path} on this server. Share that folder with Manager, then come back.` : folder.kind === 'manager' ? 'What Manager needs to bring back your photo library’s albums, people and settings.' : `Back to ${folder.path}`}</p></div>
            <span class="sb-size">{formatBytes(folder.bytes)}</span>
          </label>
        {/each}
        <div class="card-footer"><span class="muted sb-lock"><Icon name="shield" />Files already in a folder are kept and renamed, never deleted.</span><button class="button primary" disabled={busy || !!running || wanted.length === 0} onclick={restoreWhole}>Restore {formatBytes(wantedBytes)}</button></div>
      </section>
      <p class="mt16"><button class="text-button sb-plain" onclick={() => (byFile = true)}>Choose individual files instead</button></p>
    {:else}
      {#if kept}<p class="mb16"><button class="text-button sb-plain" onclick={() => (byFile = false)}>Back to the whole server</button></p>{/if}
      {@render restoreBody()}
    {/if}
    <div class="wizard-footer"><button class="button quiet" onclick={() => (step = '')}><Icon name="back" />Done</button><button class="button" disabled={busy} onclick={() => begin('setup', 'folders')}>Set up backups on this server</button></div>
  {:else if step === 'folders'}
    <section class="card">
      <div class="card-header"><h2>Folders to protect</h2><button class="button quiet" onclick={() => (picking = 'folder')}><Icon name="plus" />Add a folder…</button></div>
      {@render folderRows(true)}
    </section>
    {@render leftOut()}
    <div class="wizard-footer"><button class="button quiet" onclick={() => move(-1)}><Icon name="back" />Back</button><button class="button primary" disabled={busy || draft.folders.length === 0} onclick={showFirstKey}>Continue<Icon name="arrow" /></button></div>
  {:else if step === 'key'}
    <section class="card">
      <div class="card-header"><h2>Save your recovery key</h2></div>
      <div class="card-body stack">
        <p class="muted">This key was made on this server and stays here. It is the only way to open your backups on another server.</p>
        <p class="sb-key">{firstKey}</p>
        <div class="actions sb-wrap"><button class="button" onclick={() => downloadKit(firstKey)}><Icon name="import" />Download recovery kit</button><button class="button quiet" onclick={() => navigator.clipboard?.writeText(firstKey)}>Copy key</button></div>
        <div class="notice warning"><Icon name="warning" /><div><strong>Frameleaf can’t recover this for you</strong><p>Without the key nobody can open your backups, including us. Keep it off this server: in a password manager or printed.</p></div></div>
        <label class="sb-confirm"><input type="checkbox" bind:checked={saved} /><span>I’ve saved the recovery key somewhere off this server</span></label>
      </div>
    </section>
    <div class="wizard-footer"><button class="button quiet" onclick={() => (step = 'folders')}><Icon name="back" />Back</button><button class="button primary" disabled={!saved} onclick={() => (step = 'schedule')}>Continue<Icon name="arrow" /></button></div>
  {:else}
    <section class="card">
      <div class="card-header"><h2>When to back up</h2></div>
      <div class="card-body">{@render scheduleFields()}</div>
    </section>
    <div class="notice mt16"><Icon name="clock" /><div><strong>The first backup takes the longest</strong><p>Everything has to be stored once. After that only changes are, usually in minutes. You can keep using the server meanwhile.</p></div></div>
    <div class="wizard-footer"><button class="button quiet" onclick={() => (step = data.key.saved ? 'folders' : 'key')}><Icon name="back" />Back</button><button class="button primary" disabled={busy} onclick={finishSetup}>Start first backup</button></div>
  {/if}
{:else if page === 'folders'}
  {@render heading('Folders', 'What Server Backup protects on this server.')}
  <section class="card">
    <div class="card-header"><h2>Protected</h2><button class="button quiet" disabled={busy} onclick={() => (picking = 'folder')}><Icon name="plus" />Add a folder…</button></div>
    {@render folderRows(true)}
    <div class="card-footer"><span>{measured ? `${formatBytes(protectedBytes)} at the last backup` : 'Sizes appear after the next backup'}</span></div>
  </section>
  {@render leftOut()}
  <section class="card mt16">
    <div class="card-header"><h2>Skipped inside these folders</h2></div>
    <div class="card-body"><div class="sb-chips">{#each draft.exclusions as item}<span class="badge">{item}</span>{/each}</div><p class="meta mt16">Temporary files and caches that apps rebuild by themselves.</p></div>
  </section>
{:else if page === 'schedule'}
  {@render heading('Schedule', 'When backups run, how fast they send and how long earlier versions are kept.')}
  <section class="card">
    <div class="card-body">{@render scheduleFields()}</div>
    <div class="card-footer"><span>{data.next ? `Next backup ${nextText(data.next)}` : ''}</span><button class="button primary" disabled={busy || !edited} onclick={saveSettings}>Save</button></div>
  </section>
{:else if page === 'restore'}
  {@render heading('Restore', 'Bring back a file, a folder or everything, as it was on a date you choose.')}
  {@render restoringNow()}
  {@render restoreBody()}
{:else if page === 'activity'}
  {@render heading('Activity', 'Every backup and restore, newest first.')}
  <section class="card">{@render history(data.runs)}</section>
{:else if page === 'key'}
  {@render heading('Recovery key', 'The only way to open your backups on another server.')}
  {#if !data.key.saved}<div class="notice warning mb16"><Icon name="warning" /><div class="grow"><strong>You haven’t confirmed that you saved it</strong><p>If this server is lost before you do, your backups can’t be opened by anyone.</p></div></div>{/if}
  <section class="card">
    <div class="list-row sb-first"><Icon name="key" /><div class="grow"><strong>Kept on this server only</strong><p>{data.key.saved ? `You confirmed saving it ${midSentence(when(data.key.savedAt))}.` : 'Made when Server Backup was set up.'} Frameleaf never receives it.</p></div></div>
    <div class="list-row"><Icon name="document" /><div class="grow"><strong>Recovery kit</strong><p>A printable page with the key and how to use it. Manager asks for your password first.</p></div><button class="button quiet" onclick={() => (shownKey ? downloadKit(shownKey) : ((kitAfterReveal = true), passwordField?.focus()))}>Download…</button></div>
    <form class="list-row sb-reveal" onsubmit={(event) => { event.preventDefault(); void reveal(); }}>
      <Icon name="lock" />
      <div class="grow"><strong>{kitAfterReveal ? 'Enter your password for the kit' : 'Show the recovery key'}</strong><p>Enter your Manager password to {kitAfterReveal ? 'download it' : 'see it'}.</p></div>
      <input type="password" bind:this={passwordField} bind:value={password} required maxlength="256" autocomplete="current-password" aria-label="Manager password" />
      <button class="button quiet" disabled={busy}>Show</button>
    </form>
    {#if shownKey}
      <div class="card-body stack sb-shown">
        <p class="sb-key">{shownKey}</p>
        <div class="actions sb-wrap"><button class="button" onclick={() => downloadKit(shownKey)}><Icon name="import" />Download recovery kit</button><button class="button quiet" onclick={() => navigator.clipboard?.writeText(shownKey)}>Copy key</button>{#if !data.key.saved}<button class="button primary" disabled={busy} onclick={() => act('server-backup-key-saved')}>I’ve saved it</button>{/if}<button class="button quiet" onclick={() => (shownKey = '')}>Hide</button></div>
      </div>
    {/if}
    {#if cloud?.account}
      <div class="list-row"><Icon name="network" /><div class="grow"><strong>Keep a locked copy in Frameleaf Cloud</strong><p>{cloud.keyCopyAt ? `On since ${midSentence(when(cloud.keyCopyAt))}. The key is locked with your passphrase before it leaves this server; Frameleaf can’t open it.` : 'Off. If you turn it on, the key is locked with a passphrase only you know before it leaves this server.'}</p></div><label class="toggle"><input type="checkbox" checked={!!cloud.keyCopyAt} disabled={busy} onchange={(event) => { copying = event.currentTarget.checked ? 'on' : 'off'; event.currentTarget.checked = !!cloud.keyCopyAt; }} aria-label="Keep a locked copy in Frameleaf Cloud" /><span class="toggle-track"></span></label></div>
      {#if copying}
        <form class="card-body stack sb-shown" onsubmit={(event) => { event.preventDefault(); void saveCopy(); }}>
          {#if copying === 'on'}
            <p class="muted">Choose a passphrase you will remember. On a new server it opens the copy instead of the key. Frameleaf can’t reset it.</p>
            <label class="field sb-narrow"><span>Passphrase, at least 12 characters</span><input type="password" bind:value={passphrase} required minlength="12" maxlength="1024" autocomplete="new-password" /></label>
            <label class="field sb-narrow"><span>The same passphrase again</span><input type="password" bind:value={passphraseAgain} required maxlength="1024" autocomplete="new-password" /></label>
          {:else}
            <p class="muted">The copy in Frameleaf Cloud is deleted. Your recovery key keeps working.</p>
          {/if}
          <label class="field sb-narrow"><span>Your Manager password, to confirm</span><input type="password" bind:value={copyPassword} required maxlength="256" autocomplete="current-password" /></label>
          {#if copyProblem}<p class="field-error">{copyProblem}</p>{/if}
          <div class="actions"><button type="button" class="button quiet" onclick={() => ((copying = null), (copyPassword = passphrase = passphraseAgain = ''))}>Cancel</button><button class="button primary" disabled={busy || !!copyProblem || !copyPassword || (copying === 'on' && (!passphrase || passphrase !== passphraseAgain))}>{copying === 'on' ? 'Keep a locked copy' : 'Delete the copy'}</button></div>
        </form>
      {/if}
    {/if}
  </section>
{:else if page === 'settings'}
  {@render heading('Settings', cloud ? 'This server’s connection to Frameleaf Cloud and its storage.' : 'Turn Server Backup off, or back on.')}
  {#if cloud?.account}
    <section class="card mb16">
      <div class="card-header"><h2>Frameleaf Cloud</h2></div>
      <div class="list-row sb-first"><Icon name="server" /><div class="grow"><strong>{location.hostname}</strong><p>Connected as {cloud.account.email}. Shown in your Cloud account as a backup server.</p></div><button class="button quiet" disabled={busy || !!running} onclick={() => (disconnecting = true)}>Disconnect…</button></div>
      {#if usage}<div class="list-row"><Icon name="harddisk" /><div class="grow"><strong>{formatBytes(usage.bytesCurrent)} of {formatBytes(usage.allowanceBytes)} used</strong><p>Shared with Cloud Backup. Another 1 TB is added automatically if you pass it ($9.99 a month each).</p></div><a class="button quiet" href="https://frameleaf.cloud" target="_blank" rel="noreferrer">Open Cloud account</a></div>{/if}
      {#if disconnecting}
        <div class="card-body stack sb-shown">
          <div class="notice warning"><Icon name="warning" /><div><strong>Disconnect this server from Frameleaf Cloud?</strong><p>Backups stop. What is already stored is kept, read-only, for 30 days, and Frameleaf Cloud emails you before deleting it. To keep it, connect again and choose “Restore this server from a backup you already have”; your recovery key opens it.</p></div></div>
          <div class="actions"><button class="button quiet" onclick={() => (disconnecting = false)}>Cancel</button><button class="button danger" disabled={busy} onclick={disconnect}>Disconnect</button></div>
        </div>
      {/if}
    </section>
  {/if}
  <section class="card">
    <div class="card-header"><h2>Turn off</h2></div>
    <div class="list-row sb-first"><Icon name="stop" /><div class="grow"><strong>Turn off Server Backup</strong><p>Backups stop. What is already stored stays where it is and can be restored after turning it back on.</p></div><button class="button quiet" disabled={busy || !!running || data.state !== 'on'} onclick={() => act('server-backup-turn-off')}>Turn off</button></div>
    {#if cloud?.account}
      {#if purge && purge.status === 'held'}
        <div class="list-row sb-failed"><Icon name="warning" /><div class="grow"><strong>Backups will be deleted on {day(purge.holdUntil)}</strong><p>Restores still work until then. Backups have stopped.</p></div>{#if purge.cancellable}<button class="button" disabled={busy} onclick={keepBackups}>Keep my backups</button>{/if}</div>
      {:else if purge && purge.status === 'purging'}
        <div class="list-row sb-failed"><Icon name="warning" /><div class="grow"><strong>This server’s backups are being deleted</strong><p>It can’t be stopped now.</p></div></div>
      {:else}
        <div class="list-row"><Icon name="alert" /><div class="grow"><strong>Delete this server’s backups</strong><p>Removes everything Server Backup stored for this server. This can’t be undone after 30 days.</p></div><button class="button danger" disabled={busy || !!running} onclick={() => (deleting = true)}>Delete…</button></div>
        {#if deleting}
          <form class="card-body stack sb-shown" onsubmit={(event) => { event.preventDefault(); void deleteBackups(); }}>
            <div class="notice warning"><Icon name="warning" /><div><strong>Delete everything Server Backup stored for this server?</strong><p>Backups stop now. Frameleaf Cloud keeps what is stored for 30 days, so you can still restore or change your mind, then deletes it for good. Your photo library’s Cloud Backup is not affected.</p></div></div>
            <label class="field sb-narrow"><span>Manager password</span><input type="password" bind:value={deletePassword} required maxlength="256" autocomplete="current-password" /></label>
            <div class="actions"><button type="button" class="button quiet" onclick={() => ((deleting = false), (deletePassword = ''))}>Cancel</button><button class="button danger" disabled={busy || !deletePassword}>Delete backups</button></div>
          </form>
        {/if}
      {/if}
    {/if}
  </section>
{:else}
  {@render heading('Server Backup', 'A private, encrypted copy of this server’s other folders.')}
  {#if !data.key.saved}<div class="notice warning mb16"><Icon name="warning" /><div class="grow"><strong>Save your recovery key</strong><p>Without it nobody can open your backups if this server is lost.</p></div><button class="button" onclick={() => go('key')}>Save it now</button></div>{/if}
  <section class="card sb-status" data-tone={running ? 'running' : failed ? 'warning' : 'good'} aria-labelledby="sb-status-title">
    <div class="sb-status-body">
      <span class="sb-mark"><Icon name={running ? 'update' : failed ? 'warning' : 'shield'} /></span>
      {#if running?.kind === 'backup'}
        <div><span class="sb-eyebrow">Backing up now</span><h2 id="sb-status-title">{running.totalBytes ? `${percent}% · ${formatBytes(running.bytes)} of ${formatBytes(running.totalBytes)}` : 'Looking at your folders…'}</h2><p class="meta">{running.bytesPerSecond ? `${formatBytes(running.bytesPerSecond)} a second` : 'Starting'}{left(running.secondsLeft) ? `, ${left(running.secondsLeft)}` : ''}. The first backup takes the longest.</p></div>
        <button class="button quiet" disabled={busy} onclick={() => act('server-backup-stop')}><Icon name="stop" />Stop</button>
      {:else if running}
        <div><span class="sb-eyebrow">Restoring now</span><h2 id="sb-status-title">{running.files.toLocaleString()} files · {formatBytes(running.bytes)}</h2><p class="meta">Backups wait until the restore finishes.</p></div>
        <button class="button quiet" onclick={() => go('restore')}>Open Restore</button>
      {:else if failed}
        <div><span class="sb-eyebrow">Last backup didn’t finish</span><h2 id="sb-status-title">{when(data.last.at)}</h2><p class="meta">{problem[data.last.error] ?? data.last.error ?? 'Something went wrong.'} {data.last.completeAt ? `Last complete backup: ${midSentence(when(data.last.completeAt))}.` : ''}</p></div>
        <button class="button primary" disabled={busy} onclick={() => act('server-backup-run')}><Icon name="refresh" />Try again now</button>
      {:else}
        <div><span class="sb-eyebrow">Last backup</span><h2 id="sb-status-title">{data.last ? when(data.last.at) : 'None yet'}</h2><p class="meta">{measured ? `${formatBytes(protectedBytes)} protected in ${data.folders.length} places. ` : ''}{data.next ? `Next backup ${nextText(data.next)}.` : ''}</p></div>
        <button class="button primary" disabled={busy} onclick={() => act('server-backup-run')}><Icon name="shield" />Back up now</button>
      {/if}
    </div>
    {#if running?.kind === 'backup' && running.totalBytes}<div class="sb-bar"><div class="progress"><span style="width: {percent}%"></span></div></div>{/if}
  </section>
  <section class="card mt16">
    <div class="card-header"><h2>Protected</h2><button class="text-button sb-plain" onclick={() => go('folders')}>Manage</button></div>
    {@render folderRows(false)}
  </section>
  <section class="card mt16">
    <div class="card-header"><h2>Recent</h2><button class="text-button sb-plain" onclick={() => go('activity')}>All activity</button></div>
    {@render history(data.runs.slice(0, 3))}
  </section>
  {#if photos}<div class="notice mt16"><Icon name="images" /><div class="grow"><strong>Photos · {photos.name}</strong><p>{photos.running ? 'Running.' : 'Stopped.'} Your photo library is looked after in the Photos workspace.</p></div><button class="button quiet" onclick={openPhotos}>Open Photos</button></div>{/if}
{/if}

{#if picking}
  <FolderPicker
    title={picking === 'folder' ? 'Choose a folder to protect' : 'Choose where to restore to'}
    start={photosPath ?? '/'}
    {api}
    use={(chosenPath: string) => {
      if (picking === 'folder') edit((settings) => (settings.folders = [...new Set([...settings.folders, chosenPath])]));
      else into = chosenPath;
      picking = null;
    }}
    close={() => (picking = null)}
  />
{/if}

<style>
  .sb-first { border-top: 0; }
  .sb-size { font-size: 13px; color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
  .sb-when { white-space: nowrap; }
  .sb-plain { margin-top: 0; }
  .sb-mark { display: grid; place-items: center; width: 44px; height: 44px; border-radius: 13px; flex-shrink: 0; color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, var(--panel)); }
  .sb-mark :global(svg) { width: 22px; height: 22px; }
  .sb-intro { display: flex; gap: 18px; align-items: flex-start; }
  .sb-intro :global(.checklist li) { font-size: 14px; }
  .sb-status-body { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 16px; align-items: center; padding: 20px; }
  .sb-status[data-tone='warning'] { border-color: color-mix(in srgb, var(--amber) 30%, var(--border)); }
  .sb-status[data-tone='warning'] .sb-mark { color: var(--amber); background: color-mix(in srgb, var(--amber) 12%, var(--panel)); }
  .sb-eyebrow { font-size: 12px; color: var(--muted); }
  .sb-status h2 { font-size: 22px; letter-spacing: -0.4px; margin: 2px 0 4px; }
  .sb-status .meta { font-size: 14px; }
  .sb-bar { padding: 0 20px 20px; }
  .sb-failed > :global(svg) { color: var(--amber) !important; }
  .sb-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
  .sb-fields input { background: var(--raised); border: 1px solid var(--border); border-radius: 9px; color: var(--text); padding: 10px 11px; font-size: 14px; min-height: 40px; width: 100%; }
  .sb-chips { display: flex; flex-wrap: wrap; gap: 8px; }
  .sb-wrap { flex-wrap: wrap; }
  .sb-key { font: 500 16px/1.7 ui-monospace, SFMono-Regular, monospace; padding: 16px; border: 1px dashed var(--border); border-radius: 10px; background: var(--raised); overflow-wrap: anywhere; }
  .sb-confirm, .sb-check { display: flex; align-items: center; gap: 12px; font-size: 14px; cursor: pointer; }
  .sb-confirm input, .sb-check input, .sb-entry input { width: 18px; height: 18px; flex-shrink: 0; accent-color: var(--accent); margin: 0; }
  .sb-toolbar { display: flex; justify-content: space-between; align-items: end; gap: 12px; padding: 16px 20px; }
  .sb-date { display: grid; gap: 6px; min-width: 220px; }
  .sb-path { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 10px 20px; border-top: 1px solid var(--border); background: color-mix(in srgb, var(--raised) 30%, var(--panel)); }
  .sb-path :global(svg) { width: 14px; height: 14px; color: var(--muted); }
  .sb-path [aria-current] { color: var(--text); }
  .sb-open { padding: 0; text-align: left; color: var(--accent); }
  .sb-reveal input { background: var(--raised); border: 1px solid var(--border); border-radius: 9px; color: var(--text); padding: 8px 11px; font-size: 14px; min-height: 36px; width: 200px; }
  .sb-shown { border-top: 1px solid var(--border); }
  .sb-connect { display: flex; justify-content: space-between; align-items: center; gap: 24px; }
  .sb-then { margin-top: 14px; }
  .sb-address { font-size: 18px; font-weight: 600; color: var(--text); overflow-wrap: anywhere; }
  .sb-code { font: 600 26px/1.3 ui-monospace, SFMono-Regular, monospace; letter-spacing: 3px; color: var(--accent); margin-top: 4px; }
  .sb-waiting { display: flex; align-items: center; gap: 10px; color: var(--muted); font-size: 14px; white-space: nowrap; }
  .sb-lock { display: flex; align-items: center; gap: 8px; }
  .sb-lock :global(svg) { width: 15px; height: 15px; flex-shrink: 0; }
  .sb-place { border-top: 1px solid var(--border); }
  .sb-narrow { max-width: 420px; }
  .sb-connect .sb-note { font-size: 14px; margin-top: 6px; max-width: 62ch; }
  .sb-pick { width: auto; max-width: 260px; flex-shrink: 0; }
  .sb-keyfield { font: 500 15px/1.7 ui-monospace, SFMono-Regular, monospace; padding: 12px; border: 1px solid var(--border); border-radius: 9px; background: var(--raised); color: var(--text); width: 100%; resize: vertical; }
  .button :global(svg) { width: 15px; height: 15px; }
  @media (max-width: 640px) {
    .sb-status-body { grid-template-columns: auto minmax(0, 1fr); }
    .sb-status-body > .button { grid-column: 1 / -1; justify-content: center; }
    .sb-fields { grid-template-columns: 1fr; }
    .sb-toolbar { flex-direction: column; align-items: stretch; }
    .sb-intro { flex-direction: column; }
    .sb-connect { flex-direction: column; align-items: flex-start; }
    .sb-pick-row { flex-wrap: wrap; row-gap: 10px; }
    .sb-pick { width: 100%; max-width: none; }
    .sb-run, .sb-reveal { flex-wrap: wrap; row-gap: 8px; }
    /* The description gets the full width; what sat beside it (a size, a badge, a button) goes on a line of its own under it. */
    .sb-stack { flex-wrap: wrap; row-gap: 10px; }
    .sb-stack .grow { flex: 1 1 calc(100% - 40px); }
    .sb-stack .grow + * { margin-left: 32px; }
    .sb-run .sb-when { flex-basis: 100%; padding-left: 32px; }
    .sb-reveal input { width: 100%; }
  }
</style>
