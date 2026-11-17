<script lang="ts">
  // FL-1664 (mock): the Server Backup workspace. Every screen reads one sample answer from
  // `manager-api/server-backup`; buttons that would change the server only move between mock states.
  import Icon from './Icon.svelte';
  import { formatBytes } from './presentation';
  import { when } from './OverviewPage.svelte';

  let { data, page, go, openPhotos } = $props<{ data: any; page: string; go: (page: string) => void; openPhotos: () => void }>();

  // Local mock state: enough to walk the flows, never sent anywhere.
  let step = $state<number | null>(null);
  let saved = $state(false);
  let picked = $state<string[] | null>(null);
  let destination = $state(false);
  let target = $state('original');
  let versionsOf = $state('');

  const setupStep = $derived(step ?? data.setup?.step ?? 1);
  const selected = $derived(picked ?? (data.browse?.entries ?? []).filter((e: any) => e.selected).map((e: any) => e.name));
  const selectedBytes = $derived((data.browse?.entries ?? []).filter((e: any) => selected.includes(e.name)).reduce((sum: number, e: any) => sum + e.bytes, 0));
  const included = $derived((data.folders ?? []).filter((f: any) => f.state !== 'left-out'));
  const leftOut = $derived((data.folders ?? []).filter((f: any) => f.state === 'left-out'));
  const includedBytes = $derived(included.reduce((sum: number, f: any) => sum + f.bytes, 0));
  const tone = $derived(data.run ? 'running' : data.last?.result === 'failed' ? 'warning' : 'good');
  const toggle = (name: string) => (picked = selected.includes(name) ? selected.filter((n: string) => n !== name) : [...selected, name]);
  const setupSteps = ['Connect Cloud', 'Choose folders', 'Save your key', 'Schedule'];
  const restoreSteps = ['Connect Cloud', 'Choose server', 'Recovery key', 'Choose what to restore'];
  const resultIcon: Record<string, string> = { ok: 'check-circle', failed: 'warning', restore: 'restore', check: 'shield' };
</script>

{#snippet heading(title: string, subtitle: string)}
  <div class="page-heading"><div class="spread"><h1 tabindex="-1">{title}</h1></div><p>{subtitle}</p></div>
{/snippet}
{#snippet steps(items: string[], current: number)}
  <ol class="steps" aria-label="Progress">{#each items as item, index}<li class:active={index === current} class:complete={index < current} aria-current={index === current ? 'step' : undefined}><span class="step-number">{#if index < current}<Icon name="check" />{:else}{index + 1}{/if}</span><span>{item}</span></li>{/each}</ol>
{/snippet}
{#snippet folderRow(folder: any)}
  <div class="list-row">
    <Icon name={folder.kind === 'manager' ? 'settings' : folder.kind === 'photos' ? 'images' : 'folder'} />
    <div class="grow"><strong>{folder.label ?? folder.path}</strong><p>{folder.note ?? `${folder.files.toLocaleString()} files`}</p></div>
    <span class="sb-size">{formatBytes(folder.bytes)}</span>
    {#if folder.kind === 'manager'}<span class="badge">Always included</span>{:else if folder.state === 'left-out'}<button class="button quiet">Add anyway…</button>{:else}<button class="button quiet">Remove</button>{/if}
  </div>
{/snippet}
{#snippet scheduleFields()}
  <div class="sb-fields">
    <label class="field"><span>Back up every day at</span><select><option>{data.schedule.time}</option></select></label>
    <label class="field"><span>Stop by</span><select><option>{data.schedule.stop ?? 'No stop time'}</option></select><small class="muted">A run that is stopped carries on the next night.</small></label>
    <label class="field"><span>Upload speed limit</span><select><option>{data.schedule.limit ?? 'No limit'}</option></select></label>
    <label class="field"><span>Keep earlier versions for</span><select><option>{data.schedule.keep}</option></select><small class="muted">Deleted and changed files stay restorable for this long.</small></label>
  </div>
{/snippet}

{#if page === 'restore-server'}
  {@render heading('Restore this server', 'Bring back your folders and Manager’s settings from Server Backup.')}
  {@render steps(restoreSteps, 3)}
  <section class="card">
    <div class="list-row sb-first"><Icon name="server" /><div class="grow"><strong>{data.machine.name}</strong><p>Connected as {data.machine.account}. Recovery key accepted.</p></div><button class="button quiet">Change</button></div>
    <div class="list-row"><Icon name="clock" /><div class="grow"><strong>As it was on</strong><p>The newest backup is chosen. Earlier dates keep earlier versions of every file.</p></div><select class="sb-select" aria-label="Backup date">{#each data.snapshots as item}<option>{when(item.at)}</option>{/each}</select></div>
  </section>
  <section class="card mt16">
    <div class="card-header"><h2>What to restore</h2><span class="meta">{formatBytes(includedBytes)}</span></div>
    {#each included as folder}
      <label class="list-row sb-check"><input type="checkbox" checked /><Icon name={folder.kind === 'manager' ? 'settings' : 'folder'} /><div class="grow"><strong>{folder.label ?? folder.path}</strong><p>{folder.kind === 'manager' ? 'Then Manager offers to bring back your photo library’s albums, people and settings.' : `Back to ${folder.path}`}</p></div><span class="sb-size">{formatBytes(folder.bytes)}</span></label>
    {/each}
    <div class="card-footer"><span class="safety-note"><Icon name="shield" />Files already in a folder are kept and renamed, never deleted.</span><button class="button primary">Restore {formatBytes(includedBytes)}…</button></div>
  </section>
{:else if data.state === 'off'}
  {@render heading('Server Backup', 'Keep a private, encrypted copy of this server’s files in Frameleaf Cloud.')}
  <section class="card">
    <div class="card-body sb-intro">
      <span class="sb-mark"><Icon name="shield" /></span>
      <div>
        <h2>Protect more than your photos</h2>
        <ul class="checklist">
          <li><Icon name="check" /><span>Choose any folders on this server: documents, app data, family shares.</span></li>
          <li><Icon name="check" /><span>Everything is encrypted here first. File names and contents open only with your recovery key.</span></li>
          <li><Icon name="check" /><span>After the first backup, only what changed is sent.</span></li>
          <li><Icon name="check" /><span>Restore one file, one folder or the whole server, as it was on the day you choose.</span></li>
        </ul>
      </div>
    </div>
  </section>
  <section class="card mt16">
    <div class="card-header"><h2>What you need</h2></div>
    <div class="list-row sb-first"><Icon name="key" /><div class="grow"><strong>Server licence</strong><p>{data.requirements.licence ? 'Active on this server.' : '$100 once. It never expires.'}</p></div>{#if data.requirements.licence}<span class="badge good"><Icon name="check" />Ready</span>{:else}<button class="button quiet">Get a licence</button>{/if}</div>
    <div class="list-row"><Icon name="network" /><div class="grow"><strong>Frameleaf Cloud plan</strong><p>{data.requirements.plan ? 'Active. Server Backup shares its storage with Cloud Backup.' : '$9.99 a month with 1 TB of storage, shared with Cloud Backup.'}</p></div>{#if data.requirements.plan}<span class="badge good"><Icon name="check" />Ready</span>{:else}<button class="button quiet">See the plan</button>{/if}</div>
    <div class="card-footer"><button class="text-button sb-plain" onclick={() => go('restore-server')}>Restore this server from a backup you already have</button><button class="button primary" disabled={!data.requirements.licence || !data.requirements.plan} onclick={() => (step = 1)}>Set up Server Backup</button></div>
  </section>
  <div class="notice mt16"><Icon name="images" /><div><strong>Your photos are looked after separately</strong><p>Cloud Backup in Frameleaf protects your photo library. Server Backup leaves that folder out unless you add it. If you pass 1 TB in total, another 1 TB is added automatically ($9.99 a month each) and you’re emailed.</p></div></div>
  {#if step}<p class="quiet-note"><Icon name="info" />Mock: the set-up steps are shown in the “setup” sample.</p>{/if}
{:else if data.state === 'setup'}
  {@render heading('Set up Server Backup', 'Four steps. Nothing is sent until you start the first backup.')}
  {@render steps(setupSteps, setupStep - 1)}
  {#if setupStep === 1}
    <section class="card">
      <div class="card-header"><h2>Connect this server to Frameleaf Cloud</h2></div>
      <div class="card-body sb-link">
        <div><p class="muted">On your phone or computer, open</p><p class="sb-url">frameleaf.cloud/link</p><p class="muted mt16">and enter this code</p><p class="sb-code">{data.setup.code}</p></div>
        <div class="sb-wait"><Icon name="loader" class="spin" /><span>Waiting for you to approve…</span></div>
      </div>
      <div class="card-footer"><span class="safety-note"><Icon name="lock" />Manager never sees your Cloud password.</span><button class="button primary" onclick={() => (step = 2)}>Continue<Icon name="arrow" /></button></div>
    </section>
    <div class="notice mt16"><Icon name="info" /><div><strong>Manager gets its own connection</strong><p>Backups and restores keep working when Frameleaf is stopped, and on a new server before Frameleaf is installed.</p></div></div>
  {:else if setupStep === 2}
    <section class="card">
      <div class="card-header"><h2>Folders to protect</h2><button class="button quiet"><Icon name="plus" />Add a folder…</button></div>
      {#each included as folder, index}<div class:sb-first={index === 0}>{@render folderRow(folder)}</div>{/each}
      <div class="card-footer"><span>{formatBytes(includedBytes)} selected</span><span class="muted">{formatBytes(data.storage.planBytes - data.storage.usedBytes)} free in your plan</span></div>
    </section>
    <section class="card mt16">
      <div class="card-header"><h2>Left out</h2></div>
      {#each leftOut as folder, index}<div class:sb-first={index === 0}>{@render folderRow(folder)}</div>{/each}
    </section>
    <div class="wizard-footer"><button class="button quiet" onclick={() => (step = 1)}><Icon name="back" />Back</button><button class="button primary" onclick={() => (step = 3)}>Continue<Icon name="arrow" /></button></div>
  {:else if setupStep === 3}
    <section class="card">
      <div class="card-header"><h2>Save your recovery key</h2></div>
      <div class="card-body stack">
        <p class="muted">This key was made on this server and stays here. It is the only way to open your backups on another server.</p>
        <p class="sb-key">{data.setup.key}</p>
        <div class="actions sb-wrap"><button class="button"><Icon name="document" />Download recovery kit</button><button class="button quiet">Copy key</button></div>
        <div class="notice warning"><Icon name="warning" /><div><strong>Frameleaf can’t recover this for you</strong><p>Without the key nobody can open your backups, including us. Keep the kit off this server: in a password manager or printed.</p></div></div>
        <label class="sb-confirm"><input type="checkbox" bind:checked={saved} /><span>I’ve saved the recovery kit somewhere off this server</span></label>
      </div>
    </section>
    <div class="wizard-footer"><button class="button quiet" onclick={() => (step = 2)}><Icon name="back" />Back</button><button class="button primary" disabled={!saved} onclick={() => (step = 4)}>Continue<Icon name="arrow" /></button></div>
  {:else}
    <section class="card">
      <div class="card-header"><h2>When to back up</h2></div>
      <div class="card-body">{@render scheduleFields()}</div>
    </section>
    <div class="notice mt16"><Icon name="clock" /><div><strong>The first backup takes the longest</strong><p>{formatBytes(includedBytes)} has to be sent once. After that only changes are sent, usually in minutes. You can keep using the server meanwhile.</p></div></div>
    <div class="wizard-footer"><button class="button quiet" onclick={() => (step = 3)}><Icon name="back" />Back</button><button class="button primary">Start first backup</button></div>
  {/if}
{:else if page === 'folders'}
  {@render heading('Folders', 'What Server Backup protects on this server.')}
  <section class="card">
    <div class="card-header"><h2>Protected</h2><button class="button quiet"><Icon name="plus" />Add a folder…</button></div>
    {#each included as folder, index}<div class:sb-first={index === 0}>{@render folderRow(folder)}</div>{/each}
    <div class="card-footer"><span>{formatBytes(includedBytes)} in {included.length} places</span></div>
  </section>
  <section class="card mt16">
    <div class="card-header"><h2>Left out</h2></div>
    {#each leftOut as folder, index}<div class:sb-first={index === 0}>{@render folderRow(folder)}</div>{/each}
  </section>
  <section class="card mt16">
    <div class="card-header"><h2>Skipped inside these folders</h2><button class="button quiet">Edit</button></div>
    <div class="card-body"><div class="sb-chips">{#each data.exclusions as item}<span class="badge">{item}</span>{/each}</div><p class="meta mt16">Temporary files and caches that apps rebuild by themselves.</p></div>
  </section>
{:else if page === 'schedule'}
  {@render heading('Schedule', 'When backups run, how fast they send and how long earlier versions are kept.')}
  <section class="card">
    <div class="card-body">{@render scheduleFields()}</div>
    <div class="card-footer"><span>Next backup: {data.next}</span><button class="button primary">Save</button></div>
  </section>
  <div class="notice mt16"><Icon name="info" /><div><strong>Earlier versions cost nothing extra for 90 days</strong><p>Storage is billed for at least 90 days after a file is sent, so keeping every version that long uses no more of your plan.</p></div></div>
{:else if page === 'restore'}
  {@render heading('Restore', 'Bring back a file, a folder or everything, as it was on a date you choose.')}
  {#if data.restore}
    <section class="card sb-status" data-tone="running">
      <div class="sb-status-body">
        <span class="sb-mark"><Icon name="restore" /></span>
        <div><span class="sb-eyebrow">Restoring {data.restore.items} items</span><h2>{data.restore.percent}% · {formatBytes(data.restore.doneBytes)} of {formatBytes(data.restore.totalBytes)}</h2><p class="meta">To {data.restore.target}. Files already there are kept and renamed.</p></div>
        <button class="button quiet"><Icon name="stop" />Stop</button>
      </div>
      <div class="sb-bar"><div class="progress"><span style="width: {data.restore.percent}%"></span></div></div>
    </section>
  {/if}
  <section class="card" class:mt16={!!data.restore}>
    <div class="sb-toolbar">
      <label class="sb-date"><span class="meta">As it was on</span><select aria-label="Backup date">{#each data.snapshots as item}<option>{when(item.at)}</option>{/each}</select></label>
      <button class="button quiet" onclick={() => go('restore-server')}>Restore everything…</button>
    </div>
    <nav class="sb-path" aria-label="Folder">{#each data.browse.path as part, index}{#if index}<Icon name="chevron" />{/if}<button class="text-button sb-plain" aria-current={index === data.browse.path.length - 1 ? 'page' : undefined}>{part}</button>{/each}</nav>
    {#each data.browse.entries as entry}
      <div class="list-row sb-entry">
        <input type="checkbox" aria-label="Select {entry.name}" checked={selected.includes(entry.name)} onchange={() => toggle(entry.name)} />
        <Icon name={entry.type === 'folder' ? 'folder' : 'document'} />
        <div class="grow"><strong>{entry.name}</strong><p>{entry.type === 'folder' ? `${entry.files.toLocaleString()} files` : `Changed ${when(entry.modified)}`}{#if entry.versions > 1}{' · '}<button class="sb-inline" onclick={() => (versionsOf = versionsOf === entry.name ? '' : entry.name)}>{entry.versions} earlier versions</button>{/if}</p></div>
        <span class="sb-size">{formatBytes(entry.bytes)}</span>
      </div>
      {#if versionsOf === entry.name}
        <div class="sb-versions">{#each data.browse.versions as version}<div class="sb-version"><span>{when(version.at)}</span><span class="muted">{formatBytes(version.bytes)}</span><button class="text-button sb-plain">Restore this version</button></div>{/each}</div>
      {/if}
    {/each}
    <div class="card-footer"><span>{selected.length ? `${selected.length} selected · ${formatBytes(selectedBytes)}` : 'Nothing selected'}</span><button class="button primary" disabled={!selected.length} onclick={() => (destination = true)}>Restore…</button></div>
  </section>
  {#if destination}
    <section class="card mt16">
      <div class="card-header"><h2>Where should they go?</h2></div>
      <label class="list-row sb-check sb-first"><input type="radio" name="sb-target" value="original" bind:group={target} /><div class="grow"><strong>Back where they were</strong><p>A file already there is kept and renamed with today’s date. Nothing is deleted.</p></div></label>
      <label class="list-row sb-check"><input type="radio" name="sb-target" value="folder" bind:group={target} /><div class="grow"><strong>Into another folder</strong><p>Choose a folder on this server. The original folders are not touched.</p></div>{#if target === 'folder'}<button class="button quiet">Choose folder…</button>{/if}</label>
      <label class="list-row sb-check"><input type="radio" name="sb-target" value="download" bind:group={target} disabled={selected.length !== 1} /><div class="grow"><strong>Download to this computer</strong><p>For a single file.</p></div></label>
      <div class="card-footer"><button class="button quiet" onclick={() => (destination = false)}>Cancel</button><button class="button primary">Restore {selected.length} {selected.length === 1 ? 'item' : 'items'}</button></div>
    </section>
  {/if}
{:else if page === 'activity'}
  {@render heading('Activity', 'Every backup, restore and check, newest first.')}
  <section class="card">
    {#each data.runs as run, index}
      <div class="list-row sb-run" class:sb-first={index === 0} class:sb-failed={run.result === 'failed'}><Icon name={resultIcon[run.result]} /><div class="grow"><strong>{run.title}</strong><p>{run.detail}</p></div><span class="meta sb-when">{when(run.at)}</span></div>
    {/each}
  </section>
{:else if page === 'key'}
  {@render heading('Recovery key', 'The only way to open your backups on another server.')}
  {#if !data.key.saved}<div class="notice warning mb16"><Icon name="warning" /><div class="grow"><strong>You haven’t confirmed that you saved it</strong><p>If this server is lost before you do, your backups can’t be opened by anyone.</p></div><button class="button">Save it now</button></div>{/if}
  <section class="card">
    <div class="list-row sb-first"><Icon name="key" /><div class="grow"><strong>Kept on this server only</strong><p>{data.key.saved ? `You confirmed saving the recovery kit on ${data.key.savedOn}.` : 'Made when Server Backup was set up.'} Frameleaf never receives it.</p></div></div>
    <div class="list-row"><Icon name="document" /><div class="grow"><strong>Recovery kit</strong><p>A printable page with the key and how to use it. Manager asks for your password first.</p></div><button class="button quiet">Download…</button></div>
    <div class="list-row"><Icon name="network" /><div class="grow"><strong>Keep a locked copy in Frameleaf Cloud</strong><p>Off. If you turn it on, the key is locked with a passphrase only you know before it leaves this server.</p></div><label class="toggle"><input type="checkbox" aria-label="Keep a locked copy in Frameleaf Cloud" /><span class="toggle-track"></span></label></div>
  </section>
  <div class="notice mt16"><Icon name="info" /><div><strong>One key for the whole server</strong><p>Server Backup also keeps Frameleaf’s own backup key, so this kit is enough to bring back the server and then your photo library.</p></div></div>
{:else if page === 'settings'}
  {@render heading('Settings', 'This server’s connection to Frameleaf Cloud and its storage.')}
  <section class="card">
    <div class="card-header"><h2>Frameleaf Cloud</h2></div>
    <div class="list-row sb-first"><Icon name="server" /><div class="grow"><strong>{data.machine.name}</strong><p>Connected as {data.machine.account}. Shown in your Cloud account as a backup server.</p></div><button class="button quiet">Disconnect</button></div>
    <div class="list-row"><Icon name="harddisk" /><div class="grow"><strong>{formatBytes(data.storage.usedBytes)} of {formatBytes(data.storage.planBytes)} used</strong><p>Shared with Cloud Backup. Another 1 TB is added automatically if you pass it ($9.99 a month each).</p></div><button class="button quiet">Open Cloud account</button></div>
  </section>
  <section class="card mt16">
    <div class="card-header"><h2>Turn off</h2></div>
    <div class="list-row sb-first"><Icon name="stop" /><div class="grow"><strong>Turn off Server Backup</strong><p>Backups stop. What is already stored stays restorable until you delete it.</p></div><button class="button quiet">Turn off…</button></div>
    <div class="list-row"><Icon name="warning" /><div class="grow"><strong>Delete this server’s backups</strong><p>Removes everything Server Backup stored for this server. This can’t be undone after 30 days.</p></div><button class="button danger">Delete…</button></div>
  </section>
{:else}
  {@render heading('Server Backup', 'A private, encrypted copy of this server’s files in Frameleaf Cloud.')}
  {#if !data.key.saved}<div class="notice warning mb16"><Icon name="warning" /><div class="grow"><strong>Save your recovery key</strong><p>Without it nobody can open your backups if this server is lost.</p></div><button class="button" onclick={() => go('key')}>Save it now</button></div>{/if}
  <section class="card sb-status" data-tone={tone} aria-labelledby="sb-status-title">
    <div class="sb-status-body">
      <span class="sb-mark"><Icon name={tone === 'warning' ? 'warning' : tone === 'running' ? 'update' : 'shield'} /></span>
      {#if data.run}
        <div><span class="sb-eyebrow">Backing up now</span><h2 id="sb-status-title">{data.run.percent}% · {formatBytes(data.run.doneBytes)} of {formatBytes(data.run.totalBytes)}</h2><p class="meta">Sending at {data.run.mbps} Mbps, about {data.run.left} left. The first backup takes the longest.</p></div>
        <div class="actions"><button class="button quiet">Pause</button><button class="button quiet"><Icon name="stop" />Stop</button></div>
      {:else if tone === 'warning'}
        <div><span class="sb-eyebrow">Last backup didn’t finish</span><h2 id="sb-status-title">{when(data.last.at)}</h2><p class="meta">{data.last.message} Last complete backup: {when(data.last.completeAt)}.</p></div>
        <button class="button primary"><Icon name="refresh" />Try again now</button>
      {:else}
        <div><span class="sb-eyebrow">Last backup</span><h2 id="sb-status-title">{when(data.last.at)}</h2><p class="meta">{formatBytes(includedBytes)} protected in {included.length} places. Next backup {data.next}.</p></div>
        <button class="button primary"><Icon name="shield" />Back up now</button>
      {/if}
    </div>
    {#if data.run}<div class="sb-bar"><div class="progress"><span style="width: {data.run.percent}%"></span></div></div>{/if}
  </section>
  <div class="two-cols mt16">
    <section class="card">
      <div class="card-header"><h2>Protected</h2><button class="text-button sb-plain" onclick={() => go('folders')}>Manage</button></div>
      {#each included as folder, index}
        <div class="list-row sb-compact" class:sb-first={index === 0}><Icon name={folder.kind === 'manager' ? 'settings' : 'folder'} /><div class="grow"><strong>{folder.label ?? folder.path}</strong></div><span class="sb-size">{formatBytes(folder.bytes)}</span></div>
      {/each}
    </section>
    <section class="card">
      <div class="card-header"><h2>Cloud storage</h2></div>
      <div class="card-body">
        <p><strong class="sb-figure">{formatBytes(data.storage.usedBytes)}</strong> <span class="muted">of {formatBytes(data.storage.planBytes)}</span></p>
        <div class="meter"><span style="width: {(data.storage.serverBytes / data.storage.planBytes) * 100}%"></span><span class="sb-photos" style="width: {(data.storage.photosBytes / data.storage.planBytes) * 100}%"></span></div>
        <dl class="definition"><div><dt><i class="sb-dot"></i>Server Backup</dt><dd>{formatBytes(data.storage.serverBytes)}</dd></div><div><dt><i class="sb-dot sb-photos"></i>Photos, Cloud Backup</dt><dd>{formatBytes(data.storage.photosBytes)}</dd></div></dl>
        <p class="meta mt16">Another 1 TB is added automatically if you pass it ($9.99 a month each).</p>
      </div>
    </section>
  </div>
  <section class="card mt16">
    <div class="card-header"><h2>Recent</h2><button class="text-button sb-plain" onclick={() => go('activity')}>All activity</button></div>
    {#each data.runs.slice(0, 3) as run, index}
      <div class="list-row sb-run" class:sb-first={index === 0} class:sb-failed={run.result === 'failed'}><Icon name={resultIcon[run.result]} /><div class="grow"><strong>{run.title}</strong><p>{run.detail}</p></div><span class="meta sb-when">{when(run.at)}</span></div>
    {/each}
  </section>
  <div class="notice mt16"><Icon name="images" /><div class="grow"><strong>Photos · {data.photos.name}</strong><p>{data.photos.running ? 'Running.' : 'Stopped.'} Your photo library is looked after in the Photos workspace.</p></div><button class="button quiet" onclick={openPhotos}>Open Photos</button></div>
{/if}

<style>
  .sb-first { border-top: 0; }
  div.sb-first > :global(.list-row) { border-top: 0; }
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
  .sb-figure { font-size: 22px; letter-spacing: -0.4px; }
  .sb-photos { background: var(--teal) !important; }
  .sb-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--accent); margin-right: 8px; }
  .sb-compact { min-height: 52px; padding-top: 12px; padding-bottom: 12px; }
  .sb-failed > :global(svg) { color: var(--amber) !important; }
  .sb-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
  .sb-chips { display: flex; flex-wrap: wrap; gap: 8px; }
  .sb-wrap { flex-wrap: wrap; }
  .sb-link { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 24px; align-items: center; }
  .sb-url { font-size: 18px; font-weight: 600; margin-top: 4px; }
  .sb-code { font: 600 28px/1.2 ui-monospace, SFMono-Regular, monospace; letter-spacing: 2px; margin-top: 4px; color: var(--accent); }
  .sb-wait { display: flex; align-items: center; gap: 10px; color: var(--muted); font-size: 14px; }
  .sb-key { font: 500 16px/1.7 ui-monospace, SFMono-Regular, monospace; padding: 16px; border: 1px dashed var(--border); border-radius: 10px; background: var(--raised); overflow-wrap: anywhere; }
  .sb-confirm, .sb-check { display: flex; align-items: center; gap: 12px; font-size: 14px; cursor: pointer; }
  .sb-confirm input, .sb-check input, .sb-entry input { width: 18px; height: 18px; flex-shrink: 0; accent-color: var(--accent); margin: 0; }
  .sb-toolbar { display: flex; justify-content: space-between; align-items: end; gap: 12px; padding: 16px 20px; }
  .sb-date { display: grid; gap: 6px; min-width: 220px; }
  .sb-select { width: auto; min-width: 200px; }
  .sb-path { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 10px 20px; border-top: 1px solid var(--border); background: color-mix(in srgb, var(--raised) 30%, var(--panel)); }
  .sb-path :global(svg) { width: 14px; height: 14px; color: var(--muted); }
  .sb-path [aria-current] { color: var(--text); }
  .sb-inline { color: var(--accent); font-size: 13px; padding: 0; }
  .sb-versions { padding: 4px 20px 12px 86px; display: grid; gap: 8px; }
  .sb-version { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 16px; align-items: center; font-size: 13px; }
  .button :global(svg) { width: 15px; height: 15px; }
  @media (max-width: 640px) {
    .sb-status-body { grid-template-columns: auto minmax(0, 1fr); }
    .sb-status-body > .button, .sb-status-body > .actions { grid-column: 1 / -1; justify-content: center; }
    .sb-status-body > .actions > .button { flex: 1; }
    .sb-fields, .sb-link { grid-template-columns: 1fr; }
    .sb-toolbar { flex-direction: column; align-items: stretch; }
    .sb-versions { padding-left: 16px; }
    .sb-intro { flex-direction: column; }
    .sb-run { flex-wrap: wrap; row-gap: 4px; }
    .sb-run .sb-when { flex-basis: 100%; padding-left: 32px; }
  }
</style>
