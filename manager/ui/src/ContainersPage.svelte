<script lang="ts">
  // FL-1476: every container's settings after install, kept through updates, restores and library moves.
  import { onMount } from 'svelte';
  import Icon from './Icon.svelte';
  import FolderPicker from './FolderPicker.svelte';
  import {
    CATALOG,
    CONTAINERS,
    GROUPS,
    MANAGED_ENVIRONMENT,
    PURPOSES,
    PURPOSE_VARIABLE,
    catalogEntry,
    changes,
    effectiveEnvironment,
    fromApi,
    fromText,
    hostOf,
    limitIssues,
    limitText,
    mountIssue,
    nameStatus,
    suggestTarget,
    suggestionsFor,
    toApi,
    toText,
    valueIssue,
    type ApiOverride,
    type ContainerId,
    type Draft,
    type Purpose,
    type Suggestion,
  } from './container-catalog';

  let {
    api,
    installation,
    host: rawHost,
    tab = $bindable<ContainerId>('frameleaf-server'),
    disabled = false,
    save,
    openStorage,
  } = $props<{
    api: (path: string, body?: unknown) => Promise<any>;
    installation: { ml: boolean; mounts: { source: string; target: string }[]; databasePath: string };
    host: { processors?: number; memory?: number; acceleration?: string } | undefined;
    tab?: ContainerId;
    disabled?: boolean;
    save: (services: Record<ContainerId, ApiOverride>) => Promise<void>;
    openStorage: () => void;
  }>();

  const empty = (): Record<ContainerId, Draft> => ({
    'frameleaf-server': fromApi(undefined),
    'frameleaf-machine-learning': fromApi(undefined),
    database: fromApi(undefined),
  });
  let saved = $state<Record<ContainerId, Draft>>(empty()),
    draft = $state<Record<ContainerId, Draft>>(empty()),
    outside = $state<Partial<Record<ContainerId, Draft>>>({}),
    loaded = $state(false),
    adding = $state(false),
    picking = $state(false),
    reviewing = $state(false),
    text = $state<string | null>(null),
    dismissed = $state<ContainerId[]>([]),
    query = $state(''),
    customName = $state(''),
    customValue = $state('');

  onMount(async () => {
    const answer = await api('container-settings');
    const read = (services: Record<string, ApiOverride> = {}) =>
      Object.fromEntries(CONTAINERS.map((c) => [c.id, fromApi(services[c.id])])) as Record<ContainerId, Draft>;
    saved = read(answer.services);
    draft = read(answer.services);
    // Settings found on the running containers that Manager didn't write: someone changed them in Docker or Unraid.
    outside = Object.fromEntries(Object.entries(answer.outside ?? {}).map(([id, o]) => [id, fromApi(o as ApiOverride)]));
    loaded = true;
  });

  const host = $derived(hostOf(rawHost));
  const current = $derived(draft[tab]);
  const label = $derived(CONTAINERS.find((c) => c.id === tab)!.label);
  const diff = $derived(changes(saved, draft));
  const suggestions = $derived(host ? suggestionsFor(host, tab) : []);
  const valueNow = (name: string) => current.environment.find(([n]) => n === name)?.[1];
  const open = $derived(dismissed.includes(tab) || text !== null ? [] : suggestions.filter((s) => valueNow(s.name) !== s.value));
  const mountIssues = $derived(current.mounts.map((m, i) => mountIssue(m, current.mounts.filter((_, j) => j !== i))));
  const textErrors = $derived(text === null ? [] : fromText(text, tab).errors);
  const invalid = $derived(
    CONTAINERS.some((c) => draft[c.id].environment.some(([name, value]) => valueIssue(name, value) || ['invalid', 'reserved'].includes(nameStatus(name, c.id).status))) ||
      CONTAINERS.some((c) => draft[c.id].mounts.some((m, i) => mountIssue(m, draft[c.id].mounts.filter((_, j) => j !== i)))) ||
      textErrors.length > 0,
  );
  const derivedRows = $derived(effectiveEnvironment(current).filter(([name]) => !current.environment.some(([n]) => n === name)));
  const limits = $derived(limitIssues(tab, current, host));
  const found = $derived(outside[tab]);
  const managedMounts = $derived(
    tab === 'frameleaf-server'
      ? installation.mounts.map((m) => [m.target, m.source, 'Photos and videos. Change on the Storage page.'])
      : tab === 'database'
        ? [['/var/lib/postgresql', installation.databasePath, 'The database. Change on the Storage page.']]
        : [['/cache', 'model-cache', 'Downloaded models. Manager keeps them between updates.']],
  );
  const count = (id: ContainerId) => effectiveEnvironment(draft[id]).length + draft[id].mounts.length + (draft[id].memory ? 1 : 0) + (draft[id].cpus ? 1 : 0);
  const shownWith = (s: Suggestion) => `${s.shown}${catalogEntry(s.name)?.suffix ? ` ${catalogEntry(s.name)!.suffix}` : ''}`;
  const shownValue = (name: string, value: string) => {
    const unit = catalogEntry(name)?.unit;
    return unit && value !== '' ? String(Number(value) / unit) : value;
  };

  function set(patch: Partial<Draft>) {
    draft = { ...draft, [tab]: { ...current, ...patch } };
  }
  const setEnv = (environment: [string, string][]) => set({ environment });
  function useSuggestions(list: Suggestion[]) {
    const environment = current.environment.map(([name, value]): [string, string] => [name, list.find((s) => s.name === name)?.value ?? value]);
    for (const s of list) if (!environment.some(([name]) => name === s.name)) environment.push([s.name, s.value]);
    setEnv(environment);
  }
  function startValue(name: string) {
    const suggested = suggestions.find((s) => s.name === name);
    if (suggested) return suggested.value;
    const entry = catalogEntry(name)!;
    if (/^\d+$/.test(entry.default)) return String(Number(entry.default) * (entry.unit ?? 1));
    if (entry.type === 'switch') return entry.default;
    if (entry.type === 'choice') return entry.options!.includes(entry.default) ? entry.default : entry.options![0];
    return '';
  }
  function add(name: string, value: string) {
    setEnv([...current.environment, [name, value]]);
    adding = false;
    query = customName = customValue = '';
  }
  function toggleText() {
    if (text === null) return void (text = toText(current));
    const parsed = fromText(text, tab);
    if (parsed.errors.length) return;
    setEnv(parsed.environment);
    text = null;
  }
  function keepOutside() {
    if (!found) return;
    set({ environment: [...current.environment, ...found.environment.filter(([n]) => !valueNow(n))], mounts: [...current.mounts, ...found.mounts] });
    outside = { ...outside, [tab]: undefined };
  }
  async function confirm() {
    reviewing = false;
    await save(Object.fromEntries(CONTAINERS.map((c) => [c.id, toApi(draft[c.id])])) as Record<ContainerId, ApiOverride>);
  }
  const offered = $derived(
    CATALOG.filter((e) => e.in.includes(tab) && !current.environment.some(([n]) => n === e.name)).filter(
      (e) => !query.trim() || `${e.label} ${e.name} ${e.about} ${GROUPS[e.group]}`.toLowerCase().includes(query.trim().toLowerCase()),
    ),
  );
  const custom = $derived(customName ? nameStatus(customName, tab) : null);
  const customBlocked = $derived(!customName || ['invalid', 'reserved', 'elsewhere'].includes(custom!.status) || current.environment.some(([n]) => n === customName));
  const modal = (node: HTMLDialogElement) => node.showModal();
  const mark = { add: ['plus', 'Added'], change: ['edit', 'Changed'], remove: ['minus', 'Removed'] } as const;
</script>

<div class="cs">
  {#if !loaded}
    <p class="meta">Loading container settings…</p>
  {:else}
    {#if found && (found.environment.length || found.mounts.length)}
      <div class="notice warning">
        <Icon name="warning" />
        <div>
          <strong>Changed outside Manager</strong>
          <p>Someone added these to {label} in Docker or Unraid. The next update removes them unless you keep them here.</p>
          <ul class="cs-outside">
            {#each found.environment as [name, value] (name)}<li><code>{name}={value}</code></li>{/each}
            {#each found.mounts as m (m.source)}<li><code>{m.source} → {m.target}</code></li>{/each}
          </ul>
          <div class="actions">
            <button class="button primary" onclick={keepOutside}>Keep them here</button>
            <button class="button quiet" onclick={() => (outside = { ...outside, [tab]: undefined })}>Let the update remove them</button>
          </div>
        </div>
      </div>
    {/if}

    <div class="segmented cs-tabs" role="tablist" aria-label="Containers">
      {#each CONTAINERS as container (container.id)}
        <button role="tab" aria-selected={tab === container.id} aria-pressed={tab === container.id} onclick={() => { tab = container.id; text = null; }}>
          <Icon name={container.icon} />{container.label}{#if count(container.id)}<span class="cs-count">{count(container.id)}</span>{/if}
        </button>
      {/each}
    </div>

    {#if tab === 'frameleaf-machine-learning' && !installation.ml}
      <div class="notice"><Icon name="info" /><div><strong>Machine learning is off</strong><p>Settings here are kept and used when it’s turned on.</p></div></div>
    {/if}

    {#if open.length}
      <section class="card cs-suggest" aria-labelledby="cs-suggest-title">
        <div class="card-header">
          <div class="cs-head-icon"><Icon name="bulb" /><div><h2 id="cs-suggest-title">Suggested for this server</h2><p class="meta">Manager found {host!.cores} cores and {host!.memoryGb} GB{host!.gpu === 'intel' ? ', Intel graphics' : host!.gpu === 'nvidia' ? ', an NVIDIA card' : ''}. {open.length === 1 ? 'This setting suits it' : 'These settings suit it'} better than the defaults.</p></div></div>
        </div>
        {#each open as s (s.name)}
          {@const entry = catalogEntry(s.name)!}
          {@const now = valueNow(s.name)}
          <div class="list-row">
            <div>
              <strong>{entry.label}</strong>
              <p>{now === undefined ? `${entry.default} (default)` : shownValue(s.name, now)} → <b>{shownWith(s)}</b></p>
              <p>{s.reason}</p>
            </div>
            <button class="button quiet" onclick={() => useSuggestions([s])}>Use</button>
          </div>
        {/each}
        <div class="card-footer actions">
          {#if open.length > 1}<button class="button primary" onclick={() => useSuggestions(open)}>Use all {open.length}</button>{/if}
          <button class="button quiet" onclick={() => (dismissed = [...dismissed, tab])}>Not now</button>
        </div>
      </section>
    {/if}

    <section class="card" aria-labelledby="cs-env-title">
      <div class="card-header spread">
        <div><h2 id="cs-env-title">Settings</h2><p class="meta">Environment variables. Frameleaf’s own are listed by what they do.</p></div>
        <button class="button quiet" onclick={toggleText}>{text === null ? 'Edit as text' : 'Done'}</button>
      </div>
      {#if text !== null}
        <div class="card-body">
          <textarea class="settings-editor" rows="8" spellcheck="false" aria-label="Settings as text" bind:value={text}></textarea>
          {#if textErrors.length}<ul class="field-error cs-errors" role="alert">{#each textErrors as message}<li>{message}</li>{/each}</ul>{/if}
          <p class="meta">One NAME=value per line. Lines starting with # are ignored.</p>
        </div>
      {:else}
        {#each current.environment as [name, value], i (`${name}-${i}`)}
          {@const status = nameStatus(name, tab)}
          {@const entry = status.status === 'known' ? status.entry : undefined}
          {@const issue = valueIssue(name, value)}
          {@const suggestion = suggestions.find((s) => s.name === name)}
          {@const joined = (Object.entries(PURPOSE_VARIABLE) as [Purpose, [string, string]][]).find(([, [v]]) => v === name)?.[0]}
          {@const fromFolders = joined ? current.mounts.filter((m) => m.purpose === joined).map((m) => m.target) : []}
          <div class="cs-row">
            <div class="cs-name">
              <strong id="cs-{tab}-{i}">{entry?.label ?? name}</strong>
              {#if entry}<code>{name}</code>{/if}
              {#if entry?.about}<p>{entry.about}</p>{/if}
              {#if entry}<p class="cs-default">Default: {entry.default}</p>{/if}
              {#if fromFolders.length}<p class="cs-note good"><Icon name="link" /><span>Also gets {fromFolders.join(', ')} from Folders below.</span></p>{/if}
              {#if suggestion}
                {#if suggestion.value === value}
                  <p class="cs-note good"><Icon name="check" /><span>Suits this server</span></p>
                {:else}
                  <p class="cs-note"><Icon name="bulb" /><span>Suggested for this server: <b>{shownWith(suggestion)}</b>. {suggestion.reason}</span>
                    <button class="button quiet small" onclick={() => setEnv(current.environment.map((row, j) => (j === i ? [name, suggestion.value] : row)))}>Use {suggestion.shown}</button></p>
                {/if}
              {/if}
              {#if entry?.warn}<p class="cs-note warn"><Icon name="warning" /><span>{entry.warn}</span></p>{/if}
              {#if !entry}
                <p class="cs-note warn"><Icon name={status.status === 'legacy' ? 'update' : 'help'} /><span>{status.message}</span>
                  {#if (status.entry || status.suggestion) && status.status !== 'elsewhere'}
                    {@const next = (status.entry ?? status.suggestion)!.name}
                    <button class="button quiet small" onclick={() => setEnv(current.environment.map((row, j) => (j === i ? [next, value] : row)))}>Use {next}</button>
                  {/if}
                </p>
              {/if}
            </div>
            <div class="cs-value">
              {#if entry?.type === 'switch'}
                <label class="toggle"><input type="checkbox" aria-labelledby="cs-{tab}-{i}" checked={value === 'true'} onchange={(e) => setEnv(current.environment.map((row, j) => (j === i ? [name, String(e.currentTarget.checked)] : row)))} /><span class="toggle-track"></span><span>{value === 'true' ? 'On' : 'Off'}</span></label>
              {:else if entry?.type === 'choice'}
                <select aria-labelledby="cs-{tab}-{i}" {value} onchange={(e) => setEnv(current.environment.map((row, j) => (j === i ? [name, e.currentTarget.value] : row)))}>
                  {#each [...new Set([...entry.options!, value])] as option}<option value={option}>{option}{option === entry.default ? ' (default)' : ''}</option>{/each}
                </select>
              {:else if entry?.type === 'number'}
                <span class="cs-number"><input inputmode="numeric" aria-labelledby="cs-{tab}-{i}" value={shownValue(name, value)} oninput={(e) => setEnv(current.environment.map((row, j) => (j === i ? [name, e.currentTarget.value === '' ? '' : String(Number(e.currentTarget.value) * (entry.unit ?? 1))] : row)))} />{#if entry.suffix}<span>{entry.suffix}</span>{/if}</span>
              {:else}
                <input aria-labelledby="cs-{tab}-{i}" spellcheck="false" {value} placeholder={entry?.placeholder} oninput={(e) => setEnv(current.environment.map((row, j) => (j === i ? [name, e.currentTarget.value] : row)))} />
              {/if}
              {#if issue}<span class="field-error" role="alert">{issue}</span>{/if}
            </div>
            <button class="button quiet cs-remove" aria-label="Remove {entry?.label ?? name}" onclick={() => setEnv(current.environment.filter((_, j) => j !== i))}><Icon name="close" /></button>
          </div>
        {:else}
          {#if !derivedRows.length}<div class="card-body"><p class="meta">Nothing added. Frameleaf uses its defaults.</p></div>{/if}
        {/each}
        {#each derivedRows as [name, value] (name)}
          <div class="cs-row cs-derived"><p class="cs-note good"><Icon name="link" /><span><b>{catalogEntry(name)?.label}</b> <code>{name}</code> is set to {value.split(/[,;]/).join(', ')} from Folders below.</span></p></div>
        {/each}
        <div class="card-body cs-add"><button class="button quiet" {disabled} onclick={() => (adding = true)}><Icon name="plus" />Add a setting…</button></div>
      {/if}
      {#if MANAGED_ENVIRONMENT[tab].length}
        <details class="disclosure">
          <summary><Icon name="lock" />{MANAGED_ENVIRONMENT[tab].length} set by Manager</summary>
          <dl class="cs-locked">{#each MANAGED_ENVIRONMENT[tab] as [name, value, why] (name)}<dt><code>{name}</code></dt><dd>{value}{#if why}<small>{why}</small>{/if}</dd>{/each}</dl>
        </details>
      {/if}
    </section>

    <section class="card" aria-labelledby="cs-folders-title">
      <div class="card-header"><div><h2 id="cs-folders-title">Folders</h2><p class="meta">Folders on this server that {label} can see. It only sees the folders you add.</p></div></div>
      {#each current.mounts as mount, i (mount.source + i)}
        {@const joins = PURPOSE_VARIABLE[mount.purpose]?.[0]}
        <div class="cs-row cs-folder">
          <div class="cs-name">
            <strong class="cs-path"><Icon name="folder" />{mount.source}</strong>
            <label class="field"><span>Inside Frameleaf</span><input spellcheck="false" value={mount.target} aria-invalid={!!mountIssues[i]} oninput={(e) => set({ mounts: current.mounts.map((m, j) => (j === i ? { ...m, target: e.currentTarget.value } : m)) })} /></label>
            {#if mountIssues[i]}<span class="field-error" role="alert">{mountIssues[i]}</span>{/if}
            {#if joins}<p class="cs-note good"><Icon name="link" /><span>Added to {joins} for you.</span></p>{/if}
          </div>
          <div class="cs-value">
            <label class="field"><span>Used for</span>
              <select value={mount.purpose} onchange={(e) => set({ mounts: current.mounts.map((m, j) => (j === i ? { ...m, purpose: e.currentTarget.value as Purpose } : m)) })}>
                {#each Object.entries(PURPOSES) as [key, text]}<option value={key}>{text}</option>{/each}
              </select>
            </label>
            <label class="check-row"><input type="checkbox" checked={mount.readOnly} onchange={() => set({ mounts: current.mounts.map((m, j) => (j === i ? { ...m, readOnly: !m.readOnly } : m)) })} /><span>Read-only</span></label>
          </div>
          <button class="button quiet cs-remove" aria-label="Remove {mount.source}" onclick={() => set({ mounts: current.mounts.filter((_, j) => j !== i) })}><Icon name="close" /></button>
        </div>
      {:else}
        <div class="card-body"><p class="meta">No extra folders.</p></div>
      {/each}
      <div class="card-body cs-add"><button class="button quiet" {disabled} onclick={() => (picking = true)}><Icon name="folder" />Add a folder…</button></div>
      <details class="disclosure">
        <summary><Icon name="lock" />{managedMounts.length} set by Manager</summary>
        <dl class="cs-locked">{#each managedMounts as [target, source, why] (target)}<dt><code>{target}</code></dt><dd>{source}<small>{why}</small></dd>{/each}</dl>
        {#if tab !== 'frameleaf-machine-learning'}<button class="text-button cs-link" onclick={openStorage}>Open Storage</button>{/if}
      </details>
    </section>

    <section class="card" aria-labelledby="cs-limits-title">
      <div class="card-header"><div><h2 id="cs-limits-title">Limits</h2><p class="meta">Keep {label} from using more of the server than you want.</p></div></div>
      <div class="card-body">
        <div class="form-grid cs-limits">
          <label class="field"><span>Memory</span>
            <select value={current.memory} onchange={(e) => set({ memory: e.currentTarget.value })}>
              {#each ['', '2g', '4g', '6g', '8g', '12g', '16g', '32g', '64g'].filter((v) => !v || !host || Number(v.slice(0, -1)) <= host.memoryGb || v === current.memory) as v}<option value={v}>{limitText('memory', v)}</option>{/each}
            </select>
          </label>
          <label class="field"><span>Processor</span>
            <select value={current.cpus} onchange={(e) => set({ cpus: e.currentTarget.value })}>
              {#each ['', '1', '2', '4', '6', '8', '12', '16'].filter((v) => !v || !host || Number(v) <= host.cores || v === current.cpus) as v}<option value={v}>{limitText('cpus', v)}</option>{/each}
            </select>
          </label>
        </div>
        {#if limits.length}<ul class="cs-warnings" role="status">{#each limits as message}<li><Icon name="warning" /><span>{message}</span></li>{/each}</ul>{/if}
        {#if host}<p class="meta cs-host"><Icon name="info" />This server has {host.memoryGb} GB of memory and {host.cores} cores.{tab === 'frameleaf-machine-learning' ? ' Face recognition needs about 3 GB.' : ''}{tab === 'frameleaf-server' ? ' Locked files use 2 GB of shared memory, set by Manager.' : ''}</p>{/if}
      </div>
    </section>

    {#if diff.list.length}
      <div class="cs-savebar" role="region" aria-label="Unsaved changes">
        <span>{diff.list.length} {diff.list.length === 1 ? 'change' : 'changes'} · restarts {diff.restarts.map((c) => c.label).join(', ')}</span>
        <span class="actions">
          <button class="button quiet" onclick={() => { draft = structuredClone($state.snapshot(saved)); text = null; }}>Discard</button>
          <button class="button primary" disabled={disabled || invalid} onclick={() => (reviewing = true)}>Review and save…</button>
        </span>
      </div>
    {/if}
  {/if}
</div>

{#if adding}
  <dialog use:modal class="cs-dialog wide" aria-labelledby="cs-add-title" oncancel={(e) => { e.preventDefault(); adding = false; }}>
    <div class="modal-body">
      <h2 id="cs-add-title">Add a setting</h2>
      <button class="button quiet modal-close" aria-label="Close" onclick={() => (adding = false)}><Icon name="close" /></button>
      <label class="cs-search"><Icon name="search" /><input placeholder="Search: log, iCloud, proxy, memory…" aria-label="Search settings" bind:value={query} /></label>
      <div class="cs-catalog">
        {#each Object.entries(GROUPS) as [group, groupLabel] (group)}
          {@const list = offered.filter((e) => e.group === group)}
          {#if list.length}
            <h3>{groupLabel}</h3>
            {#each list as entry (entry.name)}
              {@const s = suggestions.find((x) => x.name === entry.name)}
              <button class="cs-catalog-item" onclick={() => add(entry.name, startValue(entry.name))}>
                <span><strong>{entry.label}</strong><code>{entry.name}</code><small>{entry.about}</small>{#if s}<small class="cs-suggested"><Icon name="bulb" />Suggested for this server: {shownWith(s)}</small>{/if}</span>
                <Icon name="plus" />
              </button>
            {/each}
          {/if}
        {/each}
        {#if !offered.length}<p class="meta">Nothing Frameleaf reads matches “{query}”. You can still add it below.</p>{/if}
      </div>
      <h3>A variable that isn’t listed</h3>
      <div class="cs-custom">
        <input aria-label="Variable name" placeholder="NAME" spellcheck="false" value={customName} oninput={(e) => (customName = e.currentTarget.value.toUpperCase().replace(/\s/g, '_'))} />
        <span>=</span>
        <input aria-label="Value" placeholder="value" spellcheck="false" bind:value={customValue} />
        <button class="button primary" disabled={customBlocked} onclick={() => add(customName, customValue)}>Add</button>
      </div>
      {#if custom && custom.status !== 'known'}
        <p class="cs-note warn" role="status"><Icon name="info" /><span>{current.environment.some(([n]) => n === customName) ? `${customName} is already set.` : custom.message}</span>
          {#if (custom.entry || custom.suggestion) && custom.status !== 'elsewhere'}<button class="button quiet small" onclick={() => (customName = (custom.entry ?? custom.suggestion)!.name)}>Use {(custom.entry ?? custom.suggestion)!.name}</button>{/if}</p>
      {:else if custom}
        <p class="meta">That’s {custom.entry!.label.toLowerCase()}. Manager will show it with its own control.</p>
      {/if}
      <p class="meta cs-host"><Icon name="lock" />Passwords and tokens don’t go here: anyone who can open Manager can read these settings.</p>
    </div>
  </dialog>
{/if}

{#if picking}
  <FolderPicker
    title="Choose a folder to add"
    start="/mnt/user"
    {api}
    issue={(path: string) => mountIssue({ source: path, target: '/x' }, []) ?? (current.mounts.some((m) => m.source === path) ? 'This folder is already added.' : null)}
    use={(path: string) => { set({ mounts: [...current.mounts, { source: path, target: suggestTarget(path, current.mounts.map((m) => m.target)), readOnly: true, purpose: 'library' }] }); picking = false; }}
    close={() => (picking = false)}
  />
{/if}

{#if reviewing}
  <dialog use:modal aria-labelledby="cs-review-title" oncancel={(e) => { e.preventDefault(); reviewing = false; }}>
    <div class="modal-body">
      <h2 id="cs-review-title">Save {diff.list.length} {diff.list.length === 1 ? 'change' : 'changes'}?</h2>
      {#each diff.restarts as container (container.id)}
        <h3 class="cs-review-head">{container.label}</h3>
        <ul class="cs-review">
          {#each diff.list.filter((c) => c.container === container.id) as change, i (i)}
            <li data-kind={change.kind}><Icon name={mark[change.kind][0]} /><span><strong>{catalogEntry(change.what)?.label ?? change.what}</strong>
              {#if change.kind === 'change'}<small>{change.from} → {change.to}</small>{:else if change.kind === 'add'}<small>{change.to}</small>{:else}<small>was {change.from}</small>{/if}</span></li>
          {/each}
        </ul>
        <p class="meta cs-host"><Icon name="refresh" />Restarts. {container.restart}</p>
      {/each}
      <p class="meta cs-host"><Icon name="shield" />Manager keeps your current settings. If a container doesn’t start, you can put them back from the progress page.</p>
    </div>
    <div class="modal-footer">
      <button class="button quiet" onclick={() => (reviewing = false)}>Keep editing</button>
      <button class="button primary" {disabled} onclick={confirm}>Save and restart</button>
    </div>
  </dialog>
{/if}

<style>
  .cs { display: grid; gap: 16px; padding-bottom: 80px; }
  .cs code, dialog code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .cs-tabs { flex-wrap: wrap; }
  .cs-tabs button { display: inline-flex; align-items: center; gap: 8px; min-height: 36px; }
  .cs-tabs :global(svg) { width: 16px; height: 16px; }
  .cs-count { min-width: 20px; padding: 0 6px; border-radius: 10px; font-size: 11px; line-height: 20px; text-align: center; color: var(--accent); background: color-mix(in srgb, var(--accent) 14%, var(--panel)); }
  .card-header h2 { font-size: 16px; }
  .card-header .meta { margin-top: 4px; font-size: 13px; }
  .cs-head-icon { display: flex; gap: 12px; align-items: flex-start; }
  .cs-head-icon > :global(svg) { width: 20px; height: 20px; color: var(--accent); flex-shrink: 0; margin-top: 2px; }
  .cs-suggest { border-color: color-mix(in srgb, var(--accent) 30%, var(--border)); }
  .cs-suggest .list-row p b { color: var(--text); }
  .cs-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(180px, 260px) 40px; gap: 16px; align-items: start; padding: 16px 20px; border-top: 1px solid var(--border); }
  .cs-name { display: grid; gap: 3px; min-width: 0; font-size: 14px; }
  .cs-name > strong { font-weight: 500; overflow-wrap: anywhere; }
  .cs-name code { font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
  .cs-name > p { font-size: 13px; color: var(--muted); }
  .cs-default { font-size: 12px !important; }
  .cs-value { display: grid; gap: 8px; min-width: 0; }
  .cs-number { display: flex; gap: 8px; align-items: center; font-size: 13px; color: var(--muted); }
  .cs-number input { width: 96px; flex: none; }
  .cs-remove { width: 40px; height: 40px; min-height: 40px; padding: 0; display: grid; place-items: center; }
  .cs-remove :global(svg), .cs-add :global(svg) { width: 16px; height: 16px; }
  .cs-add { padding-top: 16px; border-top: 1px solid var(--border); }
  .cs-add .button { display: inline-flex; align-items: center; gap: 8px; }
  .cs-note { display: grid; grid-template-columns: 14px minmax(0, 1fr); gap: 8px; align-items: start; margin-top: 6px; font-size: 13px; color: var(--text); }
  .cs-note > :global(svg) { width: 14px; height: 14px; margin-top: 3px; color: var(--accent); }
  .cs-note.good { color: var(--accent); }
  .cs-note.warn { color: var(--amber); }
  .cs-note.warn > :global(svg) { color: var(--amber); }
  .cs-note .button { grid-column: 2; justify-self: start; }
  .small { min-height: 32px; font-size: 13px; padding: 0 12px; }
  .cs-derived { grid-template-columns: 1fr; }
  .cs-derived .cs-note { margin: 0; }
  .cs-derived code { margin: 0 4px; font-size: 12px; color: var(--muted); }
  .cs-folder .field span { font-size: 12px; }
  .cs-path { display: flex; gap: 8px; align-items: center; }
  .cs-path :global(svg) { width: 18px; height: 18px; color: var(--muted); flex-shrink: 0; }
  .cs-folder .check-row { min-height: 40px; align-items: center; }
  .cs-folder .check-row input { margin: 0; }
  .disclosure summary { display: inline-flex; gap: 8px; align-items: center; color: var(--muted); }
  .disclosure summary :global(svg) { width: 15px; height: 15px; }
  .cs-locked { display: grid; grid-template-columns: minmax(0, 240px) minmax(0, 1fr); gap: 0 16px; margin-top: 10px; }
  .cs-locked dt, .cs-locked dd { padding: 10px 0; border-top: 1px solid var(--border); margin: 0; overflow-wrap: anywhere; }
  .cs-locked dd { color: var(--text); }
  .cs-locked small { display: block; margin-top: 3px; color: var(--muted); }
  .cs-link { margin-top: 8px; color: var(--accent); }
  .cs-limits { max-width: 480px; }
  .cs-warnings { list-style: none; padding: 0; margin: 16px 0 0; display: grid; gap: 8px; color: var(--amber); font-size: 13px; }
  .cs-warnings li { display: grid; grid-template-columns: 16px minmax(0, 1fr); gap: 8px; }
  .cs-warnings :global(svg) { width: 16px; height: 16px; }
  .cs-host { display: flex; gap: 8px; align-items: flex-start; margin-top: 16px; font-size: 13px; }
  .cs-host :global(svg) { width: 16px; height: 16px; flex-shrink: 0; margin-top: 1px; }
  .cs-outside { list-style: none; padding: 0; margin: 10px 0 14px; display: grid; gap: 4px; }
  .cs-outside code { font-size: 13px; }
  .cs-errors { list-style: none; padding: 0; margin: 10px 0; display: grid; gap: 4px; }
  .cs-savebar { position: sticky; bottom: 16px; z-index: 5; display: flex; flex-wrap: wrap; gap: 12px 16px; align-items: center; justify-content: space-between; padding: 12px 12px 12px 20px; border: 1px solid var(--border); border-radius: 14px; background: var(--raised); box-shadow: var(--shadow); font-size: 14px; }
  dialog.wide { width: 720px; }
  .cs-search { display: flex; gap: 8px; align-items: center; margin-top: 18px; padding: 0 12px; border: 1px solid var(--border); border-radius: 9px; background: var(--raised); color: var(--muted); }
  .cs-search:focus-within { border-color: var(--accent); }
  .cs-search :global(svg) { width: 16px; height: 16px; flex-shrink: 0; }
  .cs-search input { border: 0 !important; background: none !important; outline: none; padding-left: 0 !important; }
  .cs-catalog { max-height: min(400px, 46dvh); overflow-y: auto; margin: 12px 0 20px; display: grid; gap: 2px; }
  .modal-body h3 { font-size: 13px; font-weight: 500; color: var(--muted); margin: 14px 0 6px; }
  .cs-catalog-item { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; align-items: center; width: 100%; padding: 10px 12px; text-align: left; border-radius: 9px; }
  .cs-catalog-item:hover { background: var(--raised); }
  .cs-catalog-item > span { display: grid; gap: 2px; font-size: 14px; }
  .cs-catalog-item strong { font-weight: 500; }
  .cs-catalog-item code { font-size: 12px; color: var(--muted); }
  .cs-catalog-item small { font-size: 13px; color: var(--muted); }
  .cs-catalog-item .cs-suggested { display: inline-flex; gap: 6px; align-items: center; color: var(--accent); }
  .cs-catalog-item :global(svg) { width: 16px; height: 16px; }
  .cs-custom { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr) auto; gap: 8px; align-items: center; }
  .cs-custom input { font-family: ui-monospace, SFMono-Regular, monospace; }
  .cs-review-head { margin-top: 20px !important; }
  .cs-review { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
  .cs-review li { display: grid; grid-template-columns: 16px minmax(0, 1fr); gap: 12px; font-size: 14px; }
  .cs-review li > span { display: grid; gap: 2px; overflow-wrap: anywhere; }
  .cs-review strong { font-weight: 500; }
  .cs-review small { color: var(--muted); font-size: 13px; }
  .cs-review :global(svg) { width: 16px; height: 16px; margin-top: 2px; }
  .cs-review li[data-kind='add'] :global(svg) { color: var(--accent); }
  .cs-review li[data-kind='remove'] :global(svg) { color: var(--red); }
  @media (max-width: 720px) {
    .cs-row { grid-template-columns: minmax(0, 1fr) 40px; padding: 16px; }
    .cs-value { grid-column: 1; grid-row: 2; }
    .cs-custom { grid-template-columns: 1fr; }
    .cs-custom > span { display: none; }
    .cs-locked { grid-template-columns: 1fr; }
    .cs-locked dd { border-top: 0; padding-top: 0; }
  }
</style>
