<script lang="ts">
  // FL-1668: the Server Backup workspace, on the state Manager serves at `manager-api/server-backup`.
  // The screens follow the mock approved in FL-1664. Parts that need Frameleaf Cloud (connecting, plan
  // storage, the recovery kit) arrive with the Cloud link; nothing here pretends they exist.
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

  let step = $state(0); // 0: not setting up. 1 folders, 2 key, 3 schedule.
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

  function beginSetup() {
    step = 1;
    edited = true;
  }
  const showFirstKey = () =>
    run(async () => {
      firstKey = (await api('server-backup-first-key', {})).key;
      step = 2;
    });
  const finishSetup = () =>
    run(async () => {
      await api('server-backup-turn-on', draft);
      await api('server-backup-key-saved', {});
      change(await api('server-backup-run', {}));
      edited = false;
      step = 0;
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
    if (page === 'restore' && entries === null && snapshot && !busy) void open(path);
  });
  const toggle = (name: string) => (picked = picked.includes(name) ? picked.filter((item) => item !== name) : [...picked, name]);
  const startRestore = () =>
    run(async () => {
      change(await api('server-backup-restore', { snapshot, items: picked.map((name) => [...path, name]), into }));
      picked = [];
      destination = false;
    });

  const grouped = (key: string) => key.match(/.{1,8}/g)?.join(' ') ?? key;
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
  };
  /** One line of history in plain words. */
  function told(item: any): { icon: string; title: string; detail: string } {
    const what = item.kind === 'restore' ? 'Restore' : item.kind === 'verify' ? 'Check' : 'Backup';
    if (item.state === 'running') return { icon: 'update', title: `${what} running`, detail: 'Started ' + midSentence(when(item.startedAt)) + '.' };
    if (item.state === 'stopped') return { icon: 'stop', title: `${what} stopped`, detail: item.kind === 'backup' ? 'What was stored is kept. The next backup carries on from there.' : (problem[item.error] ?? 'It was stopped.') };
    if (item.state === 'failed') return { icon: 'warning', title: `${what} didn’t finish`, detail: (problem[item.error] ?? item.error ?? 'Something went wrong.') + (item.kind === 'backup' ? ' The next backup carries on from where this one got to.' : '') };
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
    <div class="list-row" class:sb-first={index === 0}><Icon name="settings" /><div class="grow"><strong>Manager’s recovery points</strong><p>What Manager needs to bring your photo library’s albums, people and settings back.</p></div>{#if folder.bytes !== undefined}<span class="sb-size">{formatBytes(folder.bytes)}</span>{/if}<span class="badge">Always included</span></div>
  {/each}
  {#each chosen as folder}
    <div class="list-row"><Icon name={folder.path === photosPath ? 'images' : 'folder'} /><div class="grow"><strong>{folder.path}</strong><p>{folder.files !== undefined ? `${folder.files.toLocaleString()} files` : 'Measured at the next backup'}</p></div>{#if folder.bytes !== undefined}<span class="sb-size">{formatBytes(folder.bytes)}</span>{/if}{#if removable}<button class="button quiet" disabled={busy} onclick={() => edit((settings) => (settings.folders = settings.folders.filter((item) => item !== folder.path)))}>Remove</button>{/if}</div>
  {/each}
{/snippet}
{#snippet leftOut()}
  {#if photosPath && !photosProtected}
    <section class="card mt16">
      <div class="card-header"><h2>Left out</h2></div>
      <div class="list-row sb-first"><Icon name="images" /><div class="grow"><strong>Your photo library</strong><p>{photosPath} · Cloud Backup in Frameleaf looks after it. Adding it here stores it a second time.</p></div><button class="button quiet" disabled={busy} onclick={() => edit((settings) => settings.folders.push(photosPath!))}>Add anyway</button></div>
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

{#if data.state !== 'on' && step === 0}
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
    <div class="card-footer"><span class="muted">{data.snapshots.length ? `${data.snapshots.length} earlier backups are still stored and can be restored once it is on.` : 'Three steps. Nothing is sent until you start the first backup.'}</span><button class="button primary" disabled={busy} onclick={beginSetup}>Set up Server Backup</button></div>
  </section>
  <div class="notice mt16"><Icon name="images" /><div><strong>Your photos are looked after separately</strong><p>Cloud Backup in Frameleaf protects your photo library. Server Backup leaves that folder out unless you add it.</p></div></div>
{:else if data.state !== 'on'}
  {@render heading('Set up Server Backup', 'Three steps. Nothing is sent until you start the first backup.')}
  {@render steps(['Choose folders', 'Save your key', 'Schedule'], step - 1)}
  {#if step === 1}
    <section class="card">
      <div class="card-header"><h2>Folders to protect</h2><button class="button quiet" onclick={() => (picking = 'folder')}><Icon name="plus" />Add a folder…</button></div>
      {@render folderRows(true)}
    </section>
    {@render leftOut()}
    <div class="wizard-footer"><button class="button quiet" onclick={() => (step = 0)}><Icon name="back" />Back</button><button class="button primary" disabled={busy || draft.folders.length === 0} onclick={showFirstKey}>Continue<Icon name="arrow" /></button></div>
  {:else if step === 2}
    <section class="card">
      <div class="card-header"><h2>Save your recovery key</h2></div>
      <div class="card-body stack">
        <p class="muted">This key was made on this server and stays here. It is the only way to open your backups on another server.</p>
        <p class="sb-key">{grouped(firstKey)}</p>
        <div class="actions sb-wrap"><button class="button" onclick={() => navigator.clipboard?.writeText(firstKey)}>Copy key</button></div>
        <div class="notice warning"><Icon name="warning" /><div><strong>Frameleaf can’t recover this for you</strong><p>Without the key nobody can open your backups, including us. Keep it off this server: in a password manager or printed.</p></div></div>
        <label class="sb-confirm"><input type="checkbox" bind:checked={saved} /><span>I’ve saved the recovery key somewhere off this server</span></label>
      </div>
    </section>
    <div class="wizard-footer"><button class="button quiet" onclick={() => (step = 1)}><Icon name="back" />Back</button><button class="button primary" disabled={!saved} onclick={() => (step = 3)}>Continue<Icon name="arrow" /></button></div>
  {:else}
    <section class="card">
      <div class="card-header"><h2>When to back up</h2></div>
      <div class="card-body">{@render scheduleFields()}</div>
    </section>
    <div class="notice mt16"><Icon name="clock" /><div><strong>The first backup takes the longest</strong><p>Everything has to be stored once. After that only changes are, usually in minutes. You can keep using the server meanwhile.</p></div></div>
    <div class="wizard-footer"><button class="button quiet" onclick={() => (step = 2)}><Icon name="back" />Back</button><button class="button primary" disabled={busy} onclick={finishSetup}>Start first backup</button></div>
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
  {#if running?.kind === 'restore'}
    <section class="card sb-status mb16" data-tone="running">
      <div class="sb-status-body">
        <span class="sb-mark"><Icon name="restore" /></span>
        <div><span class="sb-eyebrow">Restoring now</span><h2>{running.files.toLocaleString()} files · {formatBytes(running.bytes)}</h2><p class="meta">Files already there are kept under another name.</p></div>
        <button class="button quiet" disabled={busy} onclick={() => act('server-backup-stop')}><Icon name="stop" />Stop</button>
      </div>
    </section>
  {/if}
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
{:else if page === 'activity'}
  {@render heading('Activity', 'Every backup and restore, newest first.')}
  <section class="card">{@render history(data.runs)}</section>
{:else if page === 'key'}
  {@render heading('Recovery key', 'The only way to open your backups on another server.')}
  {#if !data.key.saved}<div class="notice warning mb16"><Icon name="warning" /><div class="grow"><strong>You haven’t confirmed that you saved it</strong><p>If this server is lost before you do, your backups can’t be opened by anyone.</p></div></div>{/if}
  <section class="card">
    <div class="list-row sb-first"><Icon name="key" /><div class="grow"><strong>Kept on this server only</strong><p>{data.key.saved ? `You confirmed saving it ${midSentence(when(data.key.savedAt))}.` : 'Made when Server Backup was set up.'} Frameleaf never receives it.</p></div></div>
    <form class="list-row sb-reveal" onsubmit={(event) => { event.preventDefault(); void run(async () => { shownKey = (await api('server-backup-key', { password })).key; password = ''; }); }}>
      <Icon name="lock" />
      <div class="grow"><strong>Show the recovery key</strong><p>Enter your Manager password to see it.</p></div>
      <input type="password" bind:value={password} required maxlength="256" autocomplete="current-password" aria-label="Manager password" />
      <button class="button quiet" disabled={busy}>Show</button>
    </form>
    {#if shownKey}
      <div class="card-body stack sb-shown">
        <p class="sb-key">{grouped(shownKey)}</p>
        <div class="actions sb-wrap"><button class="button" onclick={() => navigator.clipboard?.writeText(shownKey)}>Copy key</button>{#if !data.key.saved}<button class="button primary" disabled={busy} onclick={() => act('server-backup-key-saved')}>I’ve saved it</button>{/if}<button class="button quiet" onclick={() => (shownKey = '')}>Hide</button></div>
      </div>
    {/if}
  </section>
{:else if page === 'settings'}
  {@render heading('Settings', 'Turn Server Backup off, or back on.')}
  <section class="card">
    <div class="list-row sb-first"><Icon name="stop" /><div class="grow"><strong>Turn off Server Backup</strong><p>Backups stop. What is already stored stays where it is and can be restored after turning it back on.</p></div><button class="button quiet" disabled={busy || !!running} onclick={() => act('server-backup-turn-off')}>Turn off</button></div>
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
  .button :global(svg) { width: 15px; height: 15px; }
  @media (max-width: 640px) {
    .sb-status-body { grid-template-columns: auto minmax(0, 1fr); }
    .sb-status-body > .button { grid-column: 1 / -1; justify-content: center; }
    .sb-fields { grid-template-columns: 1fr; }
    .sb-toolbar { flex-direction: column; align-items: stretch; }
    .sb-intro { flex-direction: column; }
    .sb-run, .sb-reveal { flex-wrap: wrap; row-gap: 8px; }
    .sb-run .sb-when { flex-basis: 100%; padding-left: 32px; }
    .sb-reveal input { width: 100%; }
  }
</style>
